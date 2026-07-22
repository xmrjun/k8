'use strict';

// Normalize an IM Sports GetSE result (parsed by imsb-api.parseSeEvents) into the
// strict snapshot shape the bet-draft service validates, and — from the SAME
// pass — an index mapping each synthesized `selection_key` back to the imsb
// identifiers a placement needs (eid, market id, wager-selection id, ...).
//
// Why two outputs from one function: the draft validator rejects ANY field it
// does not know (readCurrentRecord fails on extra keys), so the placement ids
// cannot ride along on the snapshot. Instead getSports returns the clean
// snapshot and placeBet re-resolves ids against a fresh GetSE through this same
// index — keeping the read and place paths byte-for-byte consistent on how a
// selection_key is formed. See docs/plans/2026-07-21-imsb-api-integration-design.md.
//
// Market coverage and the odds/line conventions below are verified against live
// captures saved under test/fixtures/imsb-getse-*.json.

const { CODES, upstreamError } = require('./errors');

// Market coverage, keyed by GetSE bet-type id (`mls[].bti`). `names` are assigned
// BY POSITION within the market's wager-selection list; imsb returns them in a
// stable selection-index (`si`) order that matches these positions:
//   bti 1 让球/让分  si 1=home, 2=away        -> handicap
//   bti 2 大/小       si 3=over, 4=under       -> total
//   bti 3 1X2         si 5=home, 6=draw, 7=away-> 1x2
//   bti 4 独赢        si 8=home, 9=away        -> moneyline (basketball 2-way)
const MARKET_TYPES = new Map([
  [1, { type: 'handicap', names: ['home', 'away'], hasLine: true }],
  [2, { type: 'total', names: ['over', 'under'], hasLine: true }],
  [3, { type: '1x2', names: ['home', 'draw', 'away'], hasLine: false }],
  [4, { type: 'moneyline', names: ['home', 'away'], hasLine: false }],
]);

// GetSE `mls[].gp` (game period) -> draft period. 1 = full match, 2 = first half.
const PERIOD_BY_GP = new Map([
  [1, 'full_time'],
  [2, 'first_half'],
]);

// Odds type on each wager selection (`ws[].ot`):
//   3 = European decimal (o = decimal odds; Hong Kong display = o - 1)
//   2 = Hong Kong        (o = Hong Kong display; decimal = o + 1)
// Both markets can appear in one event (1X2/独赢 use ot 3; 让球/大小 use ot 2).
const ODDS_TYPE_EUROPEAN = 3;
const ODDS_TYPE_HONG_KONG = 2;

// Only the main line (ml 1) is exposed. Alternate lines (ml 2+) share the same
// (type, name) and would collide on selection_key, which has no line component.
const MAIN_MARKET_LINE = 1;

const EVENT_ID_PATTERN = /^\d{1,32}$/;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const LINE_PATTERN = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:\/(?:0|[1-9]\d*)(?:\.\d+)?)?$/;
const MAX_EVENTS = 500;
const MAX_TEXT = 500;

function normalizedText(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TEXT) return null;
  return trimmed;
}

// Split a decimal string into { decimal_odds, display_odds } in Hong Kong terms
// (decimal = display + 1). `delta` is +1 to add one to the integer part, -1 to
// subtract. Done on the STRING to avoid binary-float drift (2.31 -> "1.31").
function shiftDecimalByOne(decimalStr, delta) {
  if (!DECIMAL_PATTERN.test(decimalStr)) return null;
  const [intPart, fracPart = ''] = decimalStr.split('.');
  let integer;
  try {
    integer = BigInt(intPart) + BigInt(delta);
  } catch {
    return null;
  }
  if (integer < 0n) return null;
  const shifted = fracPart.length > 0 ? `${integer}.${fracPart}` : `${integer}`;
  if (!DECIMAL_PATTERN.test(shifted)) return null;
  return shifted;
}

// Convert an imsb selection's (o, ot) into the draft's Hong Kong odds pair.
function toHongKongOdds(o, ot) {
  if (typeof o !== 'number' || !Number.isFinite(o) || o <= 0) return null;
  const oStr = String(o);
  if (!DECIMAL_PATTERN.test(oStr)) return null;
  if (ot === ODDS_TYPE_EUROPEAN) {
    if (o <= 1) return null; // European decimal odds are always > 1
    const display = shiftDecimalByOne(oStr, -1);
    return display === null ? null : { decimal_odds: oStr, display_odds: display };
  }
  if (ot === ODDS_TYPE_HONG_KONG) {
    const decimal = shiftDecimalByOne(oStr, +1);
    return decimal === null ? null : { decimal_odds: decimal, display_odds: oStr };
  }
  return null;
}

// Build a draft-shaped selection record plus its placement descriptor, or null
// when it cannot be represented safely (bad odds, or a line-market with no line).
function buildSelection(sel, { eventId, period, type, name, hasLine }) {
  const odds = toHongKongOdds(sel.odds, sel.odds_type);
  if (!odds) return null;

  const record = {
    selection_key: `${eventId}:${period}:${type}:${name}`,
    name,
    odds_format: 'hong_kong',
    available: true,
    display_odds: odds.display_odds,
    decimal_odds: odds.decimal_odds,
  };
  if (hasLine) {
    const line = typeof sel.line === 'string' ? sel.line.trim() : '';
    if (!LINE_PATTERN.test(line)) return null;
    record.line = line;
  }

  return {
    record,
    placement: {
      eid: sel.eid,
      bet_type_id: sel.bet_type_id,
      bet_type_sub_id: 0,
      game_period: sel.game_period,
      odds_type: sel.odds_type,
      market_id: sel.market_id,
      wager_selection_id: sel.wager_selection_id,
      selection_id: sel.selection_id,
      handicap: sel.handicap,
      line: hasLine ? record.line : '',
      odds: sel.odds,
    },
  };
}

// Group one event's imsb selections into draft markets. Each (bti, gp) on the
// main line (ml 1) maps to one draft (type, period) market; positions within it
// become the pick names.
function buildMarkets(eventId, selections) {
  const groups = new Map();
  for (const sel of selections) {
    const marketType = MARKET_TYPES.get(sel.bet_type_id);
    const period = PERIOD_BY_GP.get(sel.game_period);
    if (!marketType || !period) continue;
    if (sel.market_line !== MAIN_MARKET_LINE) continue;
    const key = `${period}:${marketType.type}`;
    if (!groups.has(key)) groups.set(key, { period, marketType, items: [] });
    groups.get(key).items.push(sel);
  }

  const markets = [];
  const index = new Map();
  for (const { period, marketType, items } of groups.values()) {
    // A market must fill exactly its named positions, or the name<->pick mapping
    // is ambiguous and we refuse it rather than mislabel a real-money selection.
    if (items.length !== marketType.names.length) continue;

    const records = [];
    let ok = true;
    for (let i = 0; i < items.length; i += 1) {
      const built = buildSelection(items[i], {
        eventId,
        period,
        type: marketType.type,
        name: marketType.names[i],
        hasLine: marketType.hasLine,
      });
      if (!built) { ok = false; break; }
      records.push(built);
    }
    if (!ok) continue;

    markets.push({
      period,
      type: marketType.type,
      selections: records.map((r) => r.record),
    });
    for (const r of records) index.set(r.record.selection_key, r.placement);
  }
  return { markets, index };
}

// Turn a parseSeEvents result into { snapshot, index }. `scope` and `sport` label
// each event so the draft validator accepts them. GetSE already filtered live vs
// pre-match at the request level (Market 1 vs 3), so events are NOT re-filtered
// by their `live` flag here — every returned event is labelled with `scope`.
function normalizeEvents(parsed, { scope, sport }) {
  if (!parsed || !Array.isArray(parsed.selections)) {
    throw upstreamError(CODES.BAD_RESPONSE, 'GetSE produced no selections to normalize');
  }

  const byEvent = new Map();
  for (const sel of parsed.selections) {
    if (typeof sel.eid !== 'number' || !Number.isInteger(sel.eid) || sel.eid < 0) continue;
    if (!byEvent.has(sel.eid)) byEvent.set(sel.eid, []);
    byEvent.get(sel.eid).push(sel);
  }

  const events = [];
  const index = new Map();
  for (const [eid, selections] of byEvent) {
    if (events.length >= MAX_EVENTS) break;
    const eventId = String(eid);
    if (!EVENT_ID_PATTERN.test(eventId)) continue;
    const league = normalizedText(selections[0].competition);
    const home = normalizedText(selections[0].home);
    const away = normalizedText(selections[0].away);
    if (!league || !home || !away) continue;

    const { markets, index: eventIndex } = buildMarkets(eventId, selections);
    if (markets.length === 0) continue;

    events.push({
      event_id: eventId,
      sport,
      scope,
      league,
      home,
      away,
      score: null,
      clock: null,
      markets,
    });
    for (const [key, placement] of eventIndex) index.set(key, placement);
  }

  return {
    snapshot: { events, count: events.length, truncated: false },
    index,
  };
}

module.exports = {
  normalizeEvents,
  toHongKongOdds,
  MARKET_TYPES,
  PERIOD_BY_GP,
};
