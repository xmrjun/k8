const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  normalizeSports,
  normalizeBalance,
  normalizeBets,
} = require('../src/normalize');

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `${name}.json`), 'utf8'));
}

test('normalizeSports maps the assumed upstream contract to stable public fields', () => {
  assert.deepEqual(normalizeSports(fixture('sports')), [
    {
      event_id: 'evt-1001',
      league: 'Premier League',
      starts_at: '2026-07-19T16:00:00.000Z',
      home: 'North City',
      away: 'South United',
      markets: [
        {
          name: 'match_winner',
          selections: [
            { name: 'North City', odds: 1.95 },
            { name: 'Draw', odds: 3.4 },
            { name: 'South United', odds: 4.1 },
          ],
        },
      ],
    },
  ]);
});

test('normalizeBalance maps decimal amounts to JSON numbers when safely representable', () => {
  assert.deepEqual(normalizeBalance(fixture('balance')), {
    currency: 'CNY',
    available: 1234.5,
    locked: 100.25,
    total: 1334.75,
  });
});

test('normalizeBets emits ISO timestamps and preserves unsafe-precision decimals as strings', () => {
  assert.deepEqual(normalizeBets(fixture('bets')), [
    {
      bet_id: 'bet-2001',
      placed_at: '2026-07-19T12:15:30.000Z',
      status: 'settled',
      stake: '9007199254740993.25',
      currency: 'CNY',
      selection: 'North City',
      odds: 1.95,
      payout: '17564038546744936.8375',
    },
  ]);
});

for (const [name, fixtureName, normalizer, mutate] of [
  ['sports event id', 'sports', normalizeSports, (payload) => delete payload.data.events[0].id],
  ['balance currency', 'balance', normalizeBalance, (payload) => delete payload.data.wallet.currency_code],
  ['bet selection', 'bets', normalizeBets, (payload) => delete payload.data.bets[0].pick],
]) {
  test(`missing required upstream ${name} throws UPSTREAM_SCHEMA_CHANGED`, () => {
    const payload = fixture(fixtureName);
    mutate(payload);

    assert.throws(
      () => normalizer(payload),
      (error) => error instanceof Error && error.code === 'UPSTREAM_SCHEMA_CHANGED',
    );
  });
}

test('invalid timestamps throw UPSTREAM_SCHEMA_CHANGED', () => {
  const payload = fixture('sports');
  payload.data.events[0].start_time = 'not-a-date';
  assert.throws(
    () => normalizeSports(payload),
    (error) => error.code === 'UPSTREAM_SCHEMA_CHANGED',
  );
});

test('invalid numeric values throw UPSTREAM_SCHEMA_CHANGED', () => {
  const payload = fixture('balance');
  payload.data.wallet.available_amount = 'unlimited';
  assert.throws(
    () => normalizeBalance(payload),
    (error) => error.code === 'UPSTREAM_SCHEMA_CHANGED',
  );
});

test('integer decimals outside the JSON safe-integer range remain strings', () => {
  const payload = fixture('balance');
  payload.data.wallet.total_amount = '10000000000000000';
  assert.equal(normalizeBalance(payload).total, '10000000000000000');
});

for (const [name, value] of [
  ['an unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ['a fractional number', 1.95],
]) {
  test(`numeric input rejects ${name} because upstream precision cannot be recovered`, () => {
    const payload = fixture('balance');
    payload.data.wallet.available_amount = value;
    assert.throws(
      () => normalizeBalance(payload),
      (error) => error.code === 'UPSTREAM_SCHEMA_CHANGED',
    );
  });
}

test('safe integer numeric input remains supported', () => {
  const payload = fixture('balance');
  payload.data.wallet.available_amount = 1234;
  assert.equal(normalizeBalance(payload).available, 1234);
});

for (const [name, fixtureName, normalizer, mutate] of [
  ['object event id', 'sports', normalizeSports, (payload) => { payload.data.events[0].id = {}; }],
  ['array league', 'sports', normalizeSports, (payload) => { payload.data.events[0].competition.name = []; }],
  ['boolean currency', 'balance', normalizeBalance, (payload) => { payload.data.wallet.currency_code = true; }],
  ['object bet status', 'bets', normalizeBets, (payload) => { payload.data.bets[0].state = {}; }],
]) {
  test(`${name} throws UPSTREAM_SCHEMA_CHANGED`, () => {
    const payload = fixture(fixtureName);
    mutate(payload);
    assert.throws(
      () => normalizer(payload),
      (error) => error.code === 'UPSTREAM_SCHEMA_CHANGED',
    );
  });
}

for (const [name, value] of [
  ['seconds-sized number', 1784476800],
  ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ['boolean', true],
  ['object', {}],
  ['timezone-less string', '2026-07-19T20:15:30'],
  ['space-separated datetime', '2026-07-19 20:15:30+08:00'],
]) {
  test(`timestamp rejects ${name} with UPSTREAM_SCHEMA_CHANGED`, () => {
    const payload = fixture('sports');
    payload.data.events[0].start_time = value;
    assert.throws(
      () => normalizeSports(payload),
      (error) => error.code === 'UPSTREAM_SCHEMA_CHANGED',
    );
  });
}

test('timestamp accepts an offset-qualified ISO datetime string', () => {
  const payload = fixture('sports');
  payload.data.events[0].start_time = '2026-07-20T00:00:00+08:00';
  assert.equal(normalizeSports(payload)[0].starts_at, '2026-07-19T16:00:00.000Z');
});

for (const [name, value] of [
  ['February 30', '2026-02-30T00:00:00Z'],
  ['April 31', '2026-04-31T12:00:00+08:00'],
  ['24:00', '2026-07-19T24:00:00Z'],
]) {
  test(`timestamp rejects impossible calendar value ${name}`, () => {
    const payload = fixture('sports');
    payload.data.events[0].start_time = value;
    assert.throws(
      () => normalizeSports(payload),
      (error) => error.code === 'UPSTREAM_SCHEMA_CHANGED',
    );
  });
}
