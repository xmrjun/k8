'use strict';

// IM Sports ("Sunflower 2.0") JSON-API upstream adapter.
//
// Reads odds and places bets by executing the venue's own signed API from the
// logged-in page context through the browser gateway (see imsb-api.js). It
// speaks the same upstream contract as the browser upstream, so app.js /
// bet-drafts / bet-placement do not know which upstream is wired.
//
// Reading uses EventV6/GetSE (the full snapshot carrying 让球/大小/1X2/独赢),
// filtered by market group: pre-match (Market 1) serves scope today/early. Live
// (滚球, Market 3) streams over WebSocket and is a separate, later path — for
// now scope=live yields an empty snapshot rather than a partial one.
//
// Only sports reading and placement are implemented — the account / catalog /
// boosts / balance / bets readers have no JSON-API equivalent here and fail
// closed rather than pretend to be available.

const {
  buildGetSeExpression,
  parseSeEvents,
  buildPlaceExpression,
  interpretPlaceResult,
  ImsbPlacementError,
} = require('./imsb-api');
const { normalizeEvents } = require('./imsb-normalize');
const { CODES, UpstreamError, upstreamError } = require('./errors');

const KNOWN_CODES = new Set(Object.values(CODES));

// Verified live: football = SportId 1 (bet types 1让球/2大小/3=1X2),
// basketball = SportId 2 (bet types 1让分/2大小/4独赢). Tennis has no sample yet.
const SPORTS = new Map([
  ['football', { sportId: 1, betTypeIds: [1, 2, 3] }],
  ['basketball', { sportId: 2, betTypeIds: [1, 2, 4] }],
]);

const PRE_MATCH_MARKET = 1; // 早盘/今日
const LIVE_MARKET = 3; // 滚球
const GAME_PERIODS = [1, 2]; // full_time + first_half

function trustedError(error) {
  if (error instanceof UpstreamError && KNOWN_CODES.has(error.code)) return error;
  return upstreamError(CODES.BROWSER_UNAVAILABLE, 'IM Sports API operation failed');
}

function unsupported(feature) {
  return async () => {
    throw upstreamError(
      CODES.BROWSER_UNAVAILABLE,
      `${feature} is not available via the imsb_api upstream`,
    );
  };
}

// Venue-local (GMT+8) calendar date as YYYY/MM/DD, for the GetSE date filter.
function venueDate(now) {
  const value = now();
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  const shifted = new Date(ms + 8 * 60 * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}/${m}/${d}`;
}

// Map a draft scope to the GetSE date window. today = just today's card; early =
// today onward (open-ended DateTo). live is handled by the caller (empty).
function dateWindow(scope, now) {
  const today = venueDate(now);
  if (scope === 'today') return { dateFrom: today, dateTo: today };
  return { dateFrom: today, dateTo: '' }; // early
}

function createImsbUpstream({ gateway, queue, now = () => new Date() }) {
  if (typeof gateway?.evaluate !== 'function'
    || typeof gateway?.close !== 'function'
    || typeof queue?.run !== 'function'
    || typeof now !== 'function') {
    throw new TypeError('An imsb gateway and operation queue are required');
  }

  let closePromise;

  async function fetchSnapshot({ scope, sport }) {
    const empty = { snapshot: { events: [], count: 0, truncated: false }, index: new Map() };
    const config = SPORTS.get(sport);
    if (!config) return empty;

    // Live (滚球) uses GetSEDelta with an empty Delta — a one-shot full snapshot
    // as `a:0` add-events. Pre-match (today/early) uses GetSE with a date window.
    // Both are token-authenticated page-context fetches parsed into the same
    // draft shape.
    // Both live and pre-match use GetSE with a `sel` snapshot — only the market
    // group differs (3 = 滚球, 1 = 早盘/今日). Live needs no date window.
    const live = scope === 'live';
    let value;
    try {
      const expression = buildGetSeExpression({
        sportId: config.sportId,
        market: live ? LIVE_MARKET : PRE_MATCH_MARKET,
        betTypeIds: config.betTypeIds,
        gamePeriods: GAME_PERIODS,
        ...(live ? { dateFrom: '', dateTo: '' } : dateWindow(scope, now)),
      });
      value = await queue.run(({ signal }) => gateway.evaluate(expression, { signal }));
    } catch (error) {
      throw trustedError(error);
    }
    // parseSeEvents / normalizeEvents throw typed UpstreamError on a bad shape.
    const parsed = parseSeEvents(value);
    return normalizeEvents(parsed, { scope, sport });
  }

  async function getSports(options = {}) {
    const { snapshot } = await fetchSnapshot({
      scope: options.scope,
      sport: options.sport,
    });
    return snapshot;
  }

  // Placement is a JSON API flow (GetBI → SPB) executed in page context, the
  // same authenticated path as reads (x-token, no x-sc). It places the exact
  // stake with no UI, avoiding the DOM/one-click hazards. First re-resolve the
  // draft's selection_key to the venue ids (never carried on the snapshot).
  async function placeBet(draft) {
    const { index } = await fetchSnapshot({ scope: draft.scope, sport: draft.sport });
    const placement = index.get(draft.selection_key);
    if (!placement) {
      throw new ImsbPlacementError('SELECTION_UNAVAILABLE', 'Selection is no longer offered');
    }

    const lineValue = typeof placement.handicap === 'number' ? placement.handicap : 0;
    const sel = {
      ...placement,
      line_value: lineValue,
      stake: draft.stake,
      expected_odds: draft.expected_odds,
      max_odds_drift: draft.max_odds_drift,
    };

    let result;
    try {
      const expression = buildPlaceExpression(sel);
      result = await queue.run(({ signal }) => gateway.evaluate(expression, { signal }));
    } catch (error) {
      throw trustedError(error);
    }
    // interpretPlaceResult intentionally throws typed placement errors (drift,
    // rejection, unconfirmed) — do NOT funnel it through trustedError, which
    // would flatten those into a generic browser-unavailable fault.
    return interpretPlaceResult(result);
  }

  return Object.freeze({
    getSports,
    getSportsAccount: unsupported('Account details'),
    getSportsCatalog: unsupported('Sports catalog'),
    getSportsBoosts: unsupported('Odds boosts'),
    getBalance: unsupported('Balance'),
    getBets: unsupported('Bet history'),
    placeBet,
    close() {
      if (!closePromise) closePromise = gateway.close();
      return closePromise;
    },
  });
}

module.exports = { createImsbUpstream, SPORTS };
