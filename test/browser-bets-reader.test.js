'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildBetsExpression,
  normalizeBetsPayload,
} = require('../src/browser/readers/bets');
const { CODES } = require('../src/upstream/errors');

function fixture() {
  return JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'browser-bets-dom.json'),
    'utf8',
  ));
}

function fixtureFor(recordStatus) {
  const payload = fixture();
  payload.tabs = payload.tabs.filter((tab) => tab.record_status === recordStatus);
  return payload;
}

function schemaFailure(callback) {
  assert.throws(callback, (error) => error?.code === CODES.SCHEMA_CHANGED && !error.cause);
}

test('normalizes visible unsettled IM Sports records', () => {
  assert.deepEqual(normalizeBetsPayload(fixtureFor('unsettled'), {
    status: 'unsettled', limit: 1,
  }), [{
    bet_id: 'SYNTHETIC-1',
    placed_at: '2026-07-19T02:30:00.000Z',
    status: 'unsettled',
    description: 'Synthetic competition Synthetic home vs Synthetic away Synthetic market Synthetic selection',
    odds: 2.25,
    stake: 10,
    currency: 'USD',
    potential_payout: 22.5,
  }]);
});

test('normalizes settled records without inventing a payout', () => {
  assert.deepEqual(normalizeBetsPayload(fixtureFor('settled'), {
    status: 'settled', limit: 25,
  }), [{
    bet_id: 'SYNTHETIC-3',
    placed_at: '2026-07-18T01:15:00.000Z',
    status: 'settled',
    description: 'Synthetic settled competition Synthetic settled selection',
    odds: 1.8,
    stake: 25,
    currency: 'USD',
    potential_payout: null,
  }]);
});

test('status all combines both verified tabs before pagination', () => {
  const result = normalizeBetsPayload(fixture(), {
    status: 'all', limit: 2, cursor: '1',
  });

  assert.deepEqual(result.map((bet) => [bet.bet_id, bet.status]), [
    ['SYNTHETIC-2', 'unsettled'],
    ['SYNTHETIC-3', 'settled'],
  ]);
  assert.equal(result[0].stake, 1234.5);
  assert.equal(result[0].potential_payout, 2407.28);
});

test('returns an empty list only for a verified requested tab', () => {
  assert.deepEqual(normalizeBetsPayload({
    status: 'ready',
    currency_label: '投注金额 (USD)',
    tabs: [{ record_status: 'unsettled', empty: true, rows: [] }],
  }, { status: 'unsettled', limit: 25 }), []);
});

test('login marker maps to UPSTREAM_AUTH_EXPIRED', () => {
  assert.throws(
    () => normalizeBetsPayload({ status: 'login_required', tabs: [] }, {
      status: 'unsettled', limit: 25,
    }),
    (error) => error?.code === CODES.AUTH_EXPIRED && !error.cause,
  );
});

for (const [name, mutate] of [
  ['missing currency label', (payload) => { delete payload.currency_label; }],
  ['missing requested tab', (payload) => { payload.tabs = payload.tabs.slice(1); }],
  ['duplicate tab', (payload) => { payload.tabs.push(payload.tabs[0]); }],
  ['unverified empty rows', (payload) => { payload.tabs[0].rows = []; }],
  ['empty tab with rows', (payload) => { payload.tabs[0].empty = true; }],
  ['missing row id', (payload) => { payload.tabs[0].rows[0].date_and_id = '19/07/2026 10:30:00'; }],
  ['invalid timestamp', (payload) => { payload.tabs[0].rows[0].date_and_id = 'yesterday 注单号: SYNTHETIC-1'; }],
  ['invalid odds', (payload) => { payload.tabs[0].rows[0].odds = 'locked'; }],
  ['invalid stake', (payload) => { payload.tabs[0].rows[0].stake = 'all-in'; }],
  ['too many rows', (payload) => { payload.tabs[0].rows = Array(201).fill(payload.tabs[0].rows[0]); }],
]) {
  test(`${name} maps to UPSTREAM_SCHEMA_CHANGED`, () => {
    const payload = fixtureFor('unsettled');
    mutate(payload);
    schemaFailure(() => normalizeBetsPayload(payload, { status: 'unsettled', limit: 25 }));
  });
}

test('bet expression is bounded to the popup record tabs and excludes private browser data', () => {
  const expression = buildBetsExpression({ status: 'all', maxRows: 200 });

  assert.equal(expression.includes('未结算注单'), true);
  assert.equal(expression.includes('已结算注单'), true);
  assert.match(expression, /slice\(0, 256\)/);
  assert.match(expression, /maxRows/);
  assert.match(expression, /originalStatus/);
  assert.match(expression, /restore/);
  for (const forbidden of [
    'cookie', 'localstorage', 'sessionstorage', 'indexeddb', 'fetch(',
    'xmlhttprequest', 'websocket', 'location.href', '兑现价格', '确认投注',
  ]) {
    assert.equal(expression.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  }
});

for (const status of ['unsettled', 'settled']) {
  test(`bet expression targets only the requested ${status} tab`, () => {
    const expression = buildBetsExpression({ status, maxRows: 50 });
    assert.match(expression, new RegExp(`requestedStatus = '${status}'`));
  });
}

for (const options of [
  { status: 'unknown', maxRows: 200 },
  { status: 'all', maxRows: 0 },
  { status: 'all', maxRows: 201 },
  { status: 'all', maxRows: 1.5 },
]) {
  test(`rejects unsafe expression options ${JSON.stringify(options)}`, () => {
    assert.throws(() => buildBetsExpression(options), /Invalid bet reader options/);
  });
}

for (const options of [
  { status: 'unknown', limit: 25 },
  { status: 'unsettled', limit: 0 },
  { status: 'unsettled', limit: 101 },
  { status: 'unsettled', limit: 1.5 },
  { status: 'unsettled', limit: 25, cursor: 'not-an-offset' },
]) {
  test(`rejects invalid pagination ${JSON.stringify(options)}`, () => {
    assert.throws(() => normalizeBetsPayload(fixture(), options), /Invalid bet pagination/);
  });
}
