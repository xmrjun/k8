'use strict';

const { CODES, upstreamError } = require('../upstream/errors');

const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_EVENTS = 500;
const ID_PATTERN = /^\d{1,32}$/;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const LINE_PATTERN = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:\/(?:0|[1-9]\d*)(?:\.\d+)?)?$/;
const MARKET_TYPES = Object.freeze({ 1: 'handicap', 2: 'total', 3: '1x2' });
const PERIODS = Object.freeze({ 1: 'full_time', 2: 'first_half' });
const SELECTION_NAMES = Object.freeze({
  handicap: Object.freeze({ 1: 'home', 2: 'away' }),
  total: Object.freeze({ 3: 'over', 4: 'under' }),
  '1x2': Object.freeze({ 5: 'home', 6: 'draw', 7: 'away' }),
});

function schemaError() {
  return upstreamError(CODES.SCHEMA_CHANGED, 'IM Sports response schema changed');
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function id(value) {
  const normalized = typeof value === 'number' && Number.isSafeInteger(value)
    ? String(value)
    : value;
  if (typeof normalized !== 'string' || !ID_PATTERN.test(normalized)) throw schemaError();
  return normalized;
}

function text(value) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 500) {
    throw schemaError();
  }
  return value.trim();
}

function score(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 999) throw schemaError();
  return value;
}

function decimal(value) {
  const normalized = typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : value;
  if (typeof normalized !== 'string' || !DECIMAL_PATTERN.test(normalized)) throw schemaError();
  return normalized;
}

function decimalPlusOne(value) {
  const normalized = decimal(value);
  const [integer, fraction] = normalized.split('.');
  const incremented = (BigInt(integer) + 1n).toString();
  return fraction === undefined ? incremented : `${incremented}.${fraction}`;
}

function signedLine(value) {
  const normalized = typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : value;
  if (typeof normalized !== 'string' || !LINE_PATTERN.test(normalized)) throw schemaError();
  return normalized;
}

function normalizeSelection(raw, context) {
  if (!record(raw)) throw schemaError();
  const selectionId = id(raw.wsi);
  const name = SELECTION_NAMES[context.type][raw.si];
  if (!name) throw schemaError();
  if (raw.ot !== 2 && raw.ot !== 3) throw schemaError();

  const available = !context.locked;
  const result = {
    selection_key: `im:${context.eventId}:${context.marketId}:${selectionId}`,
    name,
  };
  if (context.type !== '1x2') result.line = signedLine(raw.dih);
  if (available) {
    const displayOdds = decimal(raw.o);
    result.display_odds = displayOdds;
    result.odds_format = raw.ot === 2 ? 'hong_kong' : 'decimal';
    result.decimal_odds = raw.ot === 2 ? decimalPlusOne(displayOdds) : displayOdds;
    result.available = true;
  } else {
    result.odds_format = raw.ot === 2 ? 'hong_kong' : 'decimal';
    result.available = false;
  }
  return { publicValue: result, selectionId };
}

function normalizeMarket(raw, eventId) {
  if (!record(raw)) throw schemaError();
  const marketId = id(raw.mi);
  const type = MARKET_TYPES[raw.bti];
  const period = PERIODS[raw.gp];
  if (!type || !period || typeof raw.il !== 'boolean' || !Array.isArray(raw.ws)) {
    throw schemaError();
  }

  const locked = raw.il || raw.ws.length === 0;
  const selectionIds = new Set();
  const selections = raw.ws.map((selection) => {
    const normalized = normalizeSelection(selection, {
      eventId,
      marketId,
      type,
      locked,
    });
    if (selectionIds.has(normalized.selectionId)) throw schemaError();
    selectionIds.add(normalized.selectionId);
    return normalized.publicValue;
  });

  return {
    marketId,
    publicValue: {
      market_key: `im:${eventId}:${marketId}`,
      period,
      type,
      available: !locked,
      selections,
    },
  };
}

function normalizeMarkets(rawMarkets, eventIdValue) {
  const eventId = id(eventIdValue);
  if (!Array.isArray(rawMarkets) || rawMarkets.length > 1_000) throw schemaError();
  const marketIds = new Set();
  const publicMarkets = [];
  for (const rawMarket of rawMarkets) {
    const normalized = normalizeMarket(rawMarket, eventId);
    if (marketIds.has(normalized.marketId)) throw schemaError();
    marketIds.add(normalized.marketId);
    publicMarkets.push(normalized.publicValue);
  }
  return publicMarkets;
}

function normalizeEvent(raw) {
  if (!record(raw) || raw.m !== 3 || !Array.isArray(raw.mls)) throw schemaError();
  const eventId = id(raw.eid);
  const clock = raw.rbt === null || raw.rbt === undefined || raw.rbt === ''
    ? null
    : text(raw.rbt);
  return {
    event_id: eventId,
    sport: 'football',
    scope: 'live',
    league: text(raw.cn),
    home: text(raw.htn),
    away: text(raw.atn),
    score: { home: score(raw.hs), away: score(raw.as) },
    clock,
    markets: normalizeMarkets(raw.mls, eventId),
  };
}

function decodeImResponse(input, { maxBytes = MAX_RESPONSE_BYTES } = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_RESPONSE_BYTES) {
    throw new TypeError('maxBytes must be a positive integer up to 2000000');
  }
  let value = input;
  if (typeof input === 'string' || Buffer.isBuffer(input)) {
    if (Buffer.byteLength(input) > maxBytes) throw schemaError();
    try {
      value = JSON.parse(input.toString());
    } catch {
      throw schemaError();
    }
  }
  if (!record(value) || value.StatusCode !== 100) throw schemaError();
  const snapshot = Array.isArray(value.sel);
  const delta = Array.isArray(value.dc);
  if (snapshot === delta) throw schemaError();
  return { type: snapshot ? 'snapshot' : 'delta', value };
}

function normalizeSnapshot(input) {
  const decoded = decodeImResponse(input);
  if (decoded.type !== 'snapshot' || decoded.value.sel.length > MAX_EVENTS) throw schemaError();

  const allEventIds = new Set();
  const ignoredEventIds = new Set();
  const supportedEvents = [];
  for (const rawEvent of decoded.value.sel) {
    if (!record(rawEvent)) throw schemaError();
    const eventId = id(rawEvent.eid);
    if (allEventIds.has(eventId)) throw schemaError();
    allEventIds.add(eventId);
    if (rawEvent.m === 3) supportedEvents.push(rawEvent);
    else ignoredEventIds.add(eventId);
  }
  if (supportedEvents.length === 0 && decoded.value.sel.length > 0) throw schemaError();

  const upstreamEvents = new Map();
  const events = supportedEvents.map((rawEvent) => {
    const normalized = normalizeEvent(rawEvent);
    const raw = structuredClone(rawEvent);
    upstreamEvents.set(normalized.event_id, raw);
    return normalized;
  });

  const result = { events, count: events.length, truncated: false };
  Object.defineProperty(result, 'upstream', {
    enumerable: false,
    configurable: false,
    writable: false,
    value: Object.freeze({ events: upstreamEvents, ignoredEventIds }),
  });
  return result;
}

module.exports = {
  decodeImResponse,
  normalizeSnapshot,
  normalizeEvent,
  normalizeMarkets,
  schemaError,
};
