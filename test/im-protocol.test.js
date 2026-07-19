'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { CODES } = require('../src/upstream/errors');

let decodeImResponse;
let normalizeSnapshot;
try {
  ({ decodeImResponse, normalizeSnapshot } = require('../src/realtime/im-protocol'));
} catch {
  decodeImResponse = undefined;
  normalizeSnapshot = undefined;
}

function fixture() {
  return JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'im-live-snapshot.json'),
    'utf8',
  ));
}

function schemaFailure(callback) {
  assert.throws(callback, (error) => (
    error?.code === CODES.SCHEMA_CHANGED
      && !error.cause
      && !JSON.stringify(error).includes('Example Home')
  ));
}

test('classifies only verified IM snapshots and deltas', () => {
  assert.equal(typeof decodeImResponse, 'function');
  assert.deepEqual(decodeImResponse(fixture()).type, 'snapshot');
  assert.deepEqual(
    decodeImResponse({ StatusCode: 100, dc: [] }),
    { type: 'delta', value: { StatusCode: 100, dc: [] } },
  );

  for (const value of [
    null,
    [],
    { StatusCode: 99, sel: [] },
    { StatusCode: 100 },
    { StatusCode: 100, sel: [], dc: [] },
  ]) {
    schemaFailure(() => decodeImResponse(value));
  }
});

test('decodes bounded JSON text without retaining malformed input', () => {
  const decoded = decodeImResponse(JSON.stringify(fixture()));
  assert.equal(decoded.type, 'snapshot');
  schemaFailure(() => decodeImResponse('{private-invalid-json'));
  schemaFailure(() => decodeImResponse('x'.repeat(2_000_001)));
});

test('normalizes verified football markets, periods, sides, lines, and odds types', () => {
  assert.equal(typeof normalizeSnapshot, 'function');
  const result = normalizeSnapshot(fixture());

  assert.equal(result.count, 1);
  assert.equal(result.truncated, false);
  assert.equal(Object.prototype.propertyIsEnumerable.call(result, 'upstream'), false);
  assert.equal(result.upstream.events instanceof Map, true);
  assert.deepEqual(result.events[0], {
    event_id: '900000001',
    sport: 'football',
    scope: 'live',
    league: 'Example League',
    home: 'Example Home',
    away: 'Example Away',
    score: { home: 1, away: 0 },
    clock: '2H 67:21',
    markets: [
      {
        market_key: 'im:900000001:8101',
        period: 'full_time',
        type: 'handicap',
        available: true,
        selections: [
          {
            selection_key: 'im:900000001:8101:9101',
            name: 'home',
            line: '-0/0.5',
            display_odds: '0.95',
            odds_format: 'hong_kong',
            decimal_odds: '1.95',
            available: true,
          },
          {
            selection_key: 'im:900000001:8101:9102',
            name: 'away',
            line: '+0/0.5',
            display_odds: '0.87',
            odds_format: 'hong_kong',
            decimal_odds: '1.87',
            available: true,
          },
        ],
      },
      {
        market_key: 'im:900000001:8102',
        period: 'first_half',
        type: 'total',
        available: true,
        selections: [
          {
            selection_key: 'im:900000001:8102:9201',
            name: 'over',
            line: '2.5',
            display_odds: '0.88',
            odds_format: 'hong_kong',
            decimal_odds: '1.88',
            available: true,
          },
          {
            selection_key: 'im:900000001:8102:9202',
            name: 'under',
            line: '2.5',
            display_odds: '0.92',
            odds_format: 'hong_kong',
            decimal_odds: '1.92',
            available: true,
          },
        ],
      },
      {
        market_key: 'im:900000001:8103',
        period: 'full_time',
        type: '1x2',
        available: true,
        selections: [
          {
            selection_key: 'im:900000001:8103:9301',
            name: 'home',
            display_odds: '2.3',
            odds_format: 'decimal',
            decimal_odds: '2.3',
            available: true,
          },
          {
            selection_key: 'im:900000001:8103:9302',
            name: 'draw',
            display_odds: '3.1',
            odds_format: 'decimal',
            decimal_odds: '3.1',
            available: true,
          },
          {
            selection_key: 'im:900000001:8103:9303',
            name: 'away',
            display_odds: '2.8',
            odds_format: 'decimal',
            decimal_odds: '2.8',
            available: true,
          },
        ],
      },
      {
        market_key: 'im:900000001:8104',
        period: 'first_half',
        type: 'handicap',
        available: false,
        selections: [
          {
            selection_key: 'im:900000001:8104:9401',
            name: 'home',
            line: '0',
            odds_format: 'hong_kong',
            available: false,
          },
        ],
      },
      {
        market_key: 'im:900000001:8105',
        period: 'full_time',
        type: 'total',
        available: false,
        selections: [],
      },
    ],
  });
});

test('Hong Kong odds conversion uses exact string arithmetic', () => {
  const payload = fixture();
  payload.sel[0].mls[0].ws[0].o = '0.123456789012345678';
  const result = normalizeSnapshot(payload);
  assert.equal(
    result.events[0].markets[0].selections[0].decimal_odds,
    '1.123456789012345678',
  );
});

for (const [name, mutate] of [
  ['unknown sport', (payload) => { payload.sel[0].m = 999; }],
  ['unknown market', (payload) => { payload.sel[0].mls[0].bti = 999; }],
  ['unknown period', (payload) => { payload.sel[0].mls[0].gp = 999; }],
  ['wrong side for market', (payload) => { payload.sel[0].mls[0].ws[0].si = 7; }],
  ['duplicate market id', (payload) => { payload.sel[0].mls[1].mi = 8101; }],
  ['duplicate selection id', (payload) => { payload.sel[0].mls[0].ws[1].wsi = 9101; }],
  ['invalid odds type', (payload) => { payload.sel[0].mls[0].ws[0].ot = 9; }],
  ['invalid line', (payload) => { payload.sel[0].mls[0].ws[0].dih = 'private-line'; }],
]) {
  test(`${name} fails with a sanitized schema error`, () => {
    const payload = fixture();
    mutate(payload);
    schemaFailure(() => normalizeSnapshot(payload));
  });
}

test('duplicate events and more than 500 events are rejected', () => {
  const duplicate = fixture();
  duplicate.sel.push(structuredClone(duplicate.sel[0]));
  schemaFailure(() => normalizeSnapshot(duplicate));

  const oversized = fixture();
  oversized.sel = Array.from({ length: 501 }, (_, index) => ({
    ...structuredClone(oversized.sel[0]),
    eid: 910000000 + index,
    mls: [],
  }));
  schemaFailure(() => normalizeSnapshot(oversized));
});

test('normalized public snapshots are detached from upstream input', () => {
  const payload = fixture();
  const result = normalizeSnapshot(payload);
  payload.sel[0].htn = 'Changed Later';
  assert.equal(result.events[0].home, 'Example Home');
  assert.equal(JSON.stringify(result).includes('upstream'), false);
});

test('mixed snapshots publish verified football and remember unsupported event ids', () => {
  const payload = fixture();
  payload.sel.push({
    eid: 900000002,
    m: 2,
    cn: 'Unsupported Example League',
    htn: 'Unsupported Home',
    atn: 'Unsupported Away',
    mls: [],
  });

  const result = normalizeSnapshot(payload);

  assert.equal(result.count, 1);
  assert.deepEqual(result.events.map((event) => event.event_id), ['900000001']);
  assert.deepEqual([...result.upstream.ignoredEventIds], ['900000002']);
  assert.equal(JSON.stringify(result).includes('900000002'), false);
});
