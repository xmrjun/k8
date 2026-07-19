const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  buildBalanceExpression,
  normalizeBalancePayload,
} = require('../src/browser/readers/balance');
const { CODES } = require('../src/upstream/errors');

function fixture() {
  return JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'browser-balance-dom.json'),
    'utf8',
  ));
}

function schemaFailure(callback) {
  assert.throws(callback, (error) => error?.code === CODES.SCHEMA_CHANGED && !error.cause);
}

test('normalizes multiple wallets and the active balance', () => {
  assert.deepEqual(normalizeBalancePayload(fixture()), {
    active_currency: 'USDT',
    total: 0.24,
    wallets: [
      { currency: 'CNY', amount: 0.98 },
      { currency: 'USDT', amount: 0.24 },
    ],
  });
});

test('preserves high-precision wallet decimals as strings', () => {
  const payload = fixture();
  payload.wallets[1].amount = '0.123456789012345678';
  assert.equal(normalizeBalancePayload(payload).total, '0.123456789012345678');
});

for (const [name, mutate] of [
  ['missing active wallet', (payload) => { payload.wallets[1].active = false; }],
  ['multiple active wallets', (payload) => { payload.wallets[0].active = true; }],
  ['invalid currency', (payload) => { payload.wallets[0].currency = ''; }],
  ['invalid amount', (payload) => { payload.wallets[0].amount = 'unlimited'; }],
  ['missing wallets', (payload) => { delete payload.wallets; }],
]) {
  test(`${name} maps to UPSTREAM_SCHEMA_CHANGED`, () => {
    const payload = fixture();
    mutate(payload);
    schemaFailure(() => normalizeBalancePayload(payload));
  });
}

test('balance login marker maps to UPSTREAM_AUTH_EXPIRED', () => {
  assert.throws(
    () => normalizeBalancePayload({ status: 'login_required', wallets: [] }),
    (error) => error?.code === CODES.AUTH_EXPIRED && !error.cause,
  );
});

test('balance expression uses only verified bounded wallet selectors', () => {
  const expression = buildBalanceExpression({ maxWallets: 20 });
  for (const selector of [
    '.balances .wallets .wallet',
    '.cy',
    '.balanceAmout',
    '.wallet.active',
  ]) {
    assert.equal(expression.includes(selector), true, selector);
  }
  assert.match(expression, /slice\(0, maxWallets\)/);
  for (const forbidden of ['cookie', 'localstorage', 'sessionstorage', 'indexeddb', 'fetch(']) {
    assert.equal(expression.toLowerCase().includes(forbidden), false, forbidden);
  }
});

test('balance expression distinguishes login and unknown pages', () => {
  const expression = buildBalanceExpression();
  const documentFor = (login) => ({
    querySelector(selector) {
      if (login && selector.includes('password')) return {};
      return null;
    },
    querySelectorAll() { return []; },
  });
  const run = (document) => JSON.parse(JSON.stringify(vm.runInNewContext(expression, { document })));

  assert.deepEqual(run(documentFor(true)), { status: 'login_required', wallets: [] });
  assert.deepEqual(run(documentFor(false)), { status: 'schema_changed', wallets: [] });
});

for (const maxWallets of [0, 101, 1.5, '20']) {
  test(`rejects unsafe maxWallets ${JSON.stringify(maxWallets)}`, () => {
    assert.throws(
      () => buildBalanceExpression({ maxWallets }),
      /maxWallets must be an integer between 1 and 100/,
    );
  });
}
