'use strict';

const { CODES, upstreamError } = require('../../upstream/errors');

const SCOPES = new Set(['live', 'today', 'early']);
const SPORTS = new Set([
  'american_football',
  'badminton',
  'baseball',
  'basketball',
  'beach_volleyball',
  'boxing',
  'cricket',
  'cycling',
  'darts',
  'ebasketball',
  'efootball',
  'esports',
  'football',
  'futsal',
  'golf',
  'handball',
  'ice_hockey',
  'mma',
  'motorsports',
  'rugby',
  'snooker',
  'squash',
  'table_tennis',
  'tennis',
  'volleyball',
  'water_polo',
]);
const PERIODS = new Set(['full_time']);
const MARKET_SELECTIONS = Object.freeze({
  '1x2': new Set(['home', 'draw', 'away']),
  handicap: new Set(['home', 'away']),
  total: new Set(['over', 'under']),
});
const EVENT_ID_PATTERN = /^\d{1,32}$/;
const SCORE_PATTERN = /^\d{1,3}$/;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const LINE_PATTERN = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?$/;

function schemaError() {
  return upstreamError(CODES.SCHEMA_CHANGED, 'IM Sports page schema changed');
}

function requiredArray(value) {
  if (!Array.isArray(value)) throw schemaError();
  return value;
}

function requiredText(value) {
  if (typeof value !== 'string' || value.trim().length === 0) throw schemaError();
  return value.trim();
}

function optionalText(value) {
  if (value === null || value === undefined) return null;
  return requiredText(value);
}

function decimalPlusOne(value) {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) throw schemaError();
  const [integer, fraction] = value.split('.');
  const nextInteger = (BigInt(integer) + 1n).toString();
  return fraction === undefined ? nextInteger : `${nextInteger}.${fraction}`;
}

function normalizeScore(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw schemaError();
  const home = value.home;
  const away = value.away;
  if (typeof home !== 'string' || !SCORE_PATTERN.test(home)
    || typeof away !== 'string' || !SCORE_PATTERN.test(away)) {
    throw schemaError();
  }
  return { home: Number(home), away: Number(away) };
}

function normalizeSelection(selection, { eventId, period, type }) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
    throw schemaError();
  }
  const name = requiredText(selection.name);
  if (!MARKET_SELECTIONS[type].has(name) || typeof selection.available !== 'boolean') {
    throw schemaError();
  }

  const normalized = {
    selection_key: `${eventId}:${period}:${type}:${name}`,
    name,
  };
  if (type !== '1x2') {
    const line = requiredText(selection.line);
    if (!LINE_PATTERN.test(line)) throw schemaError();
    normalized.line = line;
  }

  if (selection.available) {
    const displayOdds = requiredText(selection.display_odds);
    if (!DECIMAL_PATTERN.test(displayOdds)) throw schemaError();
    normalized.display_odds = displayOdds;
    normalized.odds_format = 'hong_kong';
    normalized.decimal_odds = decimalPlusOne(displayOdds);
    normalized.available = true;
    return normalized;
  }

  if (![undefined, null, '', '--'].includes(selection.display_odds)) throw schemaError();
  normalized.odds_format = 'hong_kong';
  normalized.available = false;
  return normalized;
}

function normalizeMarket(market, eventId) {
  if (!market || typeof market !== 'object' || Array.isArray(market)) throw schemaError();
  const period = requiredText(market.period);
  const type = requiredText(market.type);
  if (!PERIODS.has(period) || !Object.hasOwn(MARKET_SELECTIONS, type)) throw schemaError();

  const selections = requiredArray(market.selections).map(
    (selection) => normalizeSelection(selection, { eventId, period, type }),
  );
  if (selections.length === 0) throw schemaError();
  if (new Set(selections.map((selection) => selection.selection_key)).size !== selections.length) {
    throw schemaError();
  }

  return { period, type, selections };
}

function normalizeEvent(rawEvent, { sport, scope, league }) {
  if (!rawEvent || typeof rawEvent !== 'object' || Array.isArray(rawEvent)) {
    throw schemaError();
  }
  const eventId = requiredText(rawEvent.event_id);
  if (!EVENT_ID_PATTERN.test(eventId)) throw schemaError();
  const markets = requiredArray(rawEvent.markets).map(
    (market) => normalizeMarket(market, eventId),
  );
  const marketKeys = new Set();
  for (const market of markets) {
    const key = `${market.period}:${market.type}`;
    if (marketKeys.has(key)) throw schemaError();
    marketKeys.add(key);
  }

  return {
    event_id: eventId,
    sport,
    scope,
    league,
    home: requiredText(rawEvent.home),
    away: requiredText(rawEvent.away),
    score: normalizeScore(rawEvent.score),
    clock: optionalText(rawEvent.clock),
    markets,
  };
}

function sameIdentity(left, right) {
  return left.event_id === right.event_id
    && left.sport === right.sport
    && left.scope === right.scope
    && left.league === right.league
    && left.home === right.home
    && left.away === right.away
    && JSON.stringify(left.score) === JSON.stringify(right.score)
    && left.clock === right.clock;
}

function mergeEvent(target, incoming) {
  if (!sameIdentity(target, incoming)) throw schemaError();
  const existing = new Map(target.markets.map(
    (market) => [`${market.period}:${market.type}`, JSON.stringify(market)],
  ));
  for (const market of incoming.markets) {
    const key = `${market.period}:${market.type}`;
    if (existing.has(key)) {
      if (existing.get(key) !== JSON.stringify(market)) throw schemaError();
      continue;
    }
    target.markets.push(market);
    existing.set(key, JSON.stringify(market));
  }
}

function normalizeOptions(options = {}) {
  const scope = options.scope === undefined ? 'all' : options.scope;
  const sport = options.sport;
  if ((scope !== 'all' && !SCOPES.has(scope))
    || (sport !== undefined && !SPORTS.has(sport))) {
    throw schemaError();
  }
  return { scope, sport };
}

function normalizeSportsPayload(payload, options) {
  const filters = normalizeOptions(options);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || payload.status !== 'ready') {
    throw schemaError();
  }

  const events = [];
  const byId = new Map();
  for (const section of requiredArray(payload.sections)) {
    if (!section || typeof section !== 'object' || Array.isArray(section)) throw schemaError();
    const scope = requiredText(section.scope);
    const sport = requiredText(section.sport);
    if (!SCOPES.has(scope) || !SPORTS.has(sport)) throw schemaError();

    for (const competition of requiredArray(section.competitions)) {
      if (!competition || typeof competition !== 'object' || Array.isArray(competition)) {
        throw schemaError();
      }
      const league = requiredText(competition.league);
      for (const rawEvent of requiredArray(competition.events)) {
        const event = normalizeEvent(rawEvent, { sport, scope, league });
        if (filters.scope !== 'all' && filters.scope !== scope) continue;
        if (filters.sport !== undefined && filters.sport !== sport) continue;

        const existing = byId.get(event.event_id);
        if (existing) {
          mergeEvent(existing, event);
        } else {
          byId.set(event.event_id, event);
          events.push(event);
        }
      }
    }
  }

  const truncated = events.length > 500;
  const boundedEvents = events.slice(0, 500);
  return {
    events: boundedEvents,
    count: boundedEvents.length,
    truncated,
  };
}

module.exports = { normalizeSportsPayload };
