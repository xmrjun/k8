const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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

function schemaFailure(callback) {
  assert.throws(callback, (error) => error?.code === CODES.SCHEMA_CHANGED && !error.cause);
}

test('normalizes game-record rows to the truthful public bet model', () => {
  assert.deepEqual(normalizeBetsPayload(fixture(), { limit: 25 }), [
    {
      bet_id: 'ROUND-900001',
      placed_at: '2026-07-19T12:15:30.000Z',
      type: 'Example Game',
      stake: 10,
      currency: 'USDT',
      payout: 0,
    },
    {
      bet_id: 'ROUND-900002',
      placed_at: '2026-07-19T12:16:30.000Z',
      type: 'Example Game Two',
      stake: 2.5,
      currency: 'USDT',
      payout: 4.75,
    },
  ]);
});

test('returns an empty list only for the verified empty state', () => {
  assert.deepEqual(normalizeBetsPayload({
    status: 'ready',
    empty: true,
    currency: 'USDT',
    rows: [],
  }, { limit: 25 }), []);
});

test('applies deterministic cursor offsets and limits', () => {
  assert.deepEqual(
    normalizeBetsPayload(fixture(), { limit: 1, cursor: '1' }).map((bet) => bet.bet_id),
    ['ROUND-900002'],
  );
});

for (const [name, mutate] of [
  ['missing currency', (payload) => { delete payload.currency; }],
  ['missing row id', (payload) => { delete payload.rows[0].bet_id; }],
  ['invalid timestamp', (payload) => { payload.rows[0].placed_at = 'yesterday'; }],
  ['invalid stake', (payload) => { payload.rows[0].stake = 'all-in'; }],
  ['unverified empty rows', (payload) => { payload.rows = []; }],
]) {
  test(`${name} maps to UPSTREAM_SCHEMA_CHANGED`, () => {
    const payload = fixture();
    mutate(payload);
    schemaFailure(() => normalizeBetsPayload(payload, { limit: 25 }));
  });
}

test('bet login marker maps to UPSTREAM_AUTH_EXPIRED', () => {
  assert.throws(
    () => normalizeBetsPayload({ status: 'login_required', rows: [] }, { limit: 25 }),
    (error) => error?.code === CODES.AUTH_EXPIRED && !error.cause,
  );
});

test('bet expression uses the verified game-record route selectors and a row bound', () => {
  const expression = buildBetsExpression({ maxRows: 200 });
  for (const selector of ['.gameTable', '.gameTable .recordList', '.noRecord', '.wallet.active .cy']) {
    assert.equal(expression.includes(selector), true, selector);
  }
  assert.match(expression, /slice\(0, maxRows\)/);
  for (const forbidden of ['cookie', 'localstorage', 'sessionstorage', 'indexeddb', 'fetch(']) {
    assert.equal(expression.toLowerCase().includes(forbidden), false, forbidden);
  }
});

test('bet expression distinguishes login, empty, and unknown pages', () => {
  const expression = buildBetsExpression();
  const createDocument = ({ login = false, empty = false } = {}) => ({
    querySelector(selector) {
      if (login && selector.includes('password')) return {};
      if (empty && selector === '.gameTable') return {};
      if (empty && selector === '.noRecord') return { textContent: '暂无记录' };
      if (empty && selector === '.wallet.active .cy') return { textContent: 'USDT' };
      return null;
    },
    querySelectorAll() { return []; },
  });
  const run = (document) => JSON.parse(JSON.stringify(vm.runInNewContext(expression, { document })));

  assert.deepEqual(run(createDocument({ login: true })), {
    status: 'login_required', empty: false, currency: null, rows: [],
  });
  assert.deepEqual(run(createDocument({ empty: true })), {
    status: 'ready', empty: true, currency: 'USDT', rows: [],
  });
  assert.deepEqual(run(createDocument()), {
    status: 'schema_changed', empty: false, currency: null, rows: [],
  });
});

for (const maxRows of [0, 201, 1.5, '200']) {
  test(`rejects unsafe maxRows ${JSON.stringify(maxRows)}`, () => {
    assert.throws(
      () => buildBetsExpression({ maxRows }),
      /maxRows must be an integer between 1 and 200/,
    );
  });
}

for (const options of [
  { limit: 0 },
  { limit: 101 },
  { limit: 1.5 },
  { limit: 25, cursor: 'not-an-offset' },
]) {
  test(`rejects invalid bet pagination ${JSON.stringify(options)}`, () => {
    assert.throws(() => normalizeBetsPayload(fixture(), options), /Invalid bet pagination/);
  });
}
