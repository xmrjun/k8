const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { normalizeSportsPayload } = require('../src/browser/readers/sports');
const { CODES } = require('../src/upstream/errors');

function fixture() {
  return JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'im-sports-raw.json'),
    'utf8',
  ));
}

function schemaFailure(callback) {
  assert.throws(callback, (error) => error?.code === CODES.SCHEMA_CHANGED && !error.cause);
}

test('normalizes IM Sports events with stable markets and selection keys', () => {
  const result = normalizeSportsPayload(fixture(), { scope: 'all' });

  assert.equal(result.count, 3);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.events[0], {
    event_id: '900000001',
    sport: 'football',
    scope: 'live',
    league: 'Example Live League',
    home: 'Example Home',
    away: 'Example Away',
    score: { home: 0, away: 1 },
    clock: '2H 77:24',
    markets: [
      {
        period: 'full_time',
        type: '1x2',
        selections: [
          {
            selection_key: '900000001:full_time:1x2:home',
            name: 'home',
            display_odds: '6.43',
            odds_format: 'hong_kong',
            decimal_odds: '7.43',
            available: true,
          },
          {
            selection_key: '900000001:full_time:1x2:draw',
            name: 'draw',
            display_odds: '2.10',
            odds_format: 'hong_kong',
            decimal_odds: '3.10',
            available: true,
          },
          {
            selection_key: '900000001:full_time:1x2:away',
            name: 'away',
            odds_format: 'hong_kong',
            available: false,
          },
        ],
      },
      {
        period: 'full_time',
        type: 'handicap',
        selections: [
          {
            selection_key: '900000001:full_time:handicap:home',
            name: 'home',
            line: '-0.5',
            display_odds: '0.95',
            odds_format: 'hong_kong',
            decimal_odds: '1.95',
            available: true,
          },
          {
            selection_key: '900000001:full_time:handicap:away',
            name: 'away',
            line: '+0.5',
            display_odds: '0.87',
            odds_format: 'hong_kong',
            decimal_odds: '1.87',
            available: true,
          },
        ],
      },
      {
        period: 'full_time',
        type: 'total',
        selections: [
          {
            selection_key: '900000001:full_time:total:over',
            name: 'over',
            line: '2.5',
            display_odds: '0.88',
            odds_format: 'hong_kong',
            decimal_odds: '1.88',
            available: true,
          },
          {
            selection_key: '900000001:full_time:total:under',
            name: 'under',
            line: '2.5',
            odds_format: 'hong_kong',
            available: false,
          },
        ],
      },
    ],
  });
});

test('filters by scope and sport without changing page order', () => {
  const result = normalizeSportsPayload(fixture(), {
    scope: 'today',
    sport: 'basketball',
  });

  assert.equal(result.count, 1);
  assert.equal(result.events[0].event_id, '900000002');
});

test('adds one to Hong Kong odds as an exact decimal string', () => {
  const payload = fixture();
  payload.sections[0].competitions[0].events[0]
    .markets[0].selections[0].display_odds = '0.123456789012345678';

  const selection = normalizeSportsPayload(payload, { scope: 'live' })
    .events[0].markets[0].selections[0];

  assert.equal(selection.display_odds, '0.123456789012345678');
  assert.equal(selection.decimal_odds, '1.123456789012345678');
});

test('merges repeated event rows when identity fields agree', () => {
  const payload = fixture();
  const competition = payload.sections[0].competitions[0];
  competition.events.push({
    event_id: '900000001',
    home: 'Example Home',
    away: 'Example Away',
    score: { home: '0', away: '1' },
    clock: '2H 77:24',
    markets: structuredClone(competition.events[0].markets),
  });

  const result = normalizeSportsPayload(payload, { scope: 'live' });

  assert.equal(result.count, 1);
  assert.equal(result.events[0].markets.length, 3);
});

test('caps output at 500 events and reports truncation', () => {
  const payload = fixture();
  const template = payload.sections[0].competitions[0].events[0];
  payload.sections = [{
    scope: 'live',
    sport: 'football',
    competitions: [{
      league: 'Synthetic League',
      events: Array.from({ length: 501 }, (_, index) => ({
        ...structuredClone(template),
        event_id: String(910000000 + index),
      })),
    }],
  }];

  const result = normalizeSportsPayload(payload, { scope: 'all' });

  assert.equal(result.events.length, 500);
  assert.equal(result.count, 500);
  assert.equal(result.truncated, true);
});

for (const [name, mutate] of [
  ['missing page status', (payload) => { delete payload.status; }],
  ['unknown section scope', (payload) => { payload.sections[0].scope = 'parlay'; }],
  ['unknown sport', (payload) => { payload.sections[0].sport = 'unknown-sport'; }],
  ['missing league', (payload) => { delete payload.sections[0].competitions[0].league; }],
  ['non-numeric event id', (payload) => { payload.sections[0].competitions[0].events[0].event_id = 'evt-1'; }],
  ['missing home team', (payload) => { delete payload.sections[0].competitions[0].events[0].home; }],
  ['invalid market period', (payload) => { payload.sections[0].competitions[0].events[0].markets[0].period = 'unknown'; }],
  ['invalid odds', (payload) => { payload.sections[0].competitions[0].events[0].markets[0].selections[0].display_odds = '--'; }],
]) {
  test(`${name} maps to UPSTREAM_SCHEMA_CHANGED`, () => {
    const payload = fixture();
    mutate(payload);
    schemaFailure(() => normalizeSportsPayload(payload, { scope: 'all' }));
  });
}

test('conflicting repeated event identity maps to UPSTREAM_SCHEMA_CHANGED', () => {
  const payload = fixture();
  const duplicate = structuredClone(payload.sections[0].competitions[0].events[0]);
  duplicate.home = 'Different Home';
  payload.sections[0].competitions[0].events.push(duplicate);

  schemaFailure(() => normalizeSportsPayload(payload, { scope: 'all' }));
});
