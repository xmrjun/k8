'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const {
  buildSportsAccountExpression,
  normalizeSportsAccountPayload,
} = require('../src/browser/readers/sports-account');
const { CODES } = require('../src/upstream/errors');

function schemaFailure(callback) {
  assert.throws(callback, (error) => error?.code === CODES.SCHEMA_CHANGED && !error.cause);
}

function readyPayload() {
  return {
    status: 'ready',
    heading: '账户 (USD)',
    available: '12.50',
    unsettled: '1,234.00',
  };
}

test('normalizes visible IM Sports account summary values', () => {
  assert.deepEqual(normalizeSportsAccountPayload(readyPayload()), {
    currency: 'USD',
    available_balance: 12.5,
    unsettled_amount: 1234,
  });
});

test('preserves high-precision account decimals as strings', () => {
  const payload = readyPayload();
  payload.available = '0.123456789012345678';

  assert.equal(
    normalizeSportsAccountPayload(payload).available_balance,
    '0.123456789012345678',
  );
});

test('account login marker maps to UPSTREAM_AUTH_EXPIRED', () => {
  assert.throws(
    () => normalizeSportsAccountPayload({ status: 'login_required' }),
    (error) => error?.code === CODES.AUTH_EXPIRED && !error.cause,
  );
});

for (const [name, mutate] of [
  ['missing heading', (payload) => { delete payload.heading; }],
  ['invalid currency', (payload) => { payload.heading = '账户 (US D)'; }],
  ['negative balance', (payload) => { payload.available = '-1.00'; }],
  ['malformed balance', (payload) => { payload.available = 'unlimited'; }],
  ['incorrect comma grouping', (payload) => { payload.unsettled = '12,34.00'; }],
  ['missing available balance', (payload) => { delete payload.available; }],
  ['empty unsettled amount', (payload) => { payload.unsettled = ''; }],
]) {
  test(`${name} maps to UPSTREAM_SCHEMA_CHANGED`, () => {
    const payload = readyPayload();
    mutate(payload);
    schemaFailure(() => normalizeSportsAccountPayload(payload));
  });
}

test('account expression uses only the verified bounded selectors and labels', () => {
  const expression = buildSportsAccountExpression();
  for (const selector of [
    '#left_panel .leftmenu_account',
    '.leftmenu_account_title',
    '.leftmenu_content .row',
    '.text-right',
  ]) {
    assert.equal(expression.includes(selector), true, selector);
  }
  for (const label of ['余额', '未结算注单']) {
    assert.equal(expression.includes(label), true, label);
  }
  assert.match(expression, /slice\(0, 8\)/);
  for (const forbidden of [
    'cookie',
    'localstorage',
    'sessionstorage',
    'indexeddb',
    'fetch(',
    'xmlhttprequest',
    'websocket',
    'location.href',
  ]) {
    assert.equal(expression.toLowerCase().includes(forbidden), false, forbidden);
  }
});

test('account expression emits explicit login and schema markers', () => {
  const expression = buildSportsAccountExpression();
  const documentFor = (login) => ({
    querySelector(selector) {
      if (login && selector.includes('password')) return {};
      return null;
    },
  });
  const run = (document) => JSON.parse(JSON.stringify(
    vm.runInNewContext(expression, { document }),
  ));

  assert.deepEqual(run(documentFor(true)), {
    status: 'login_required',
    heading: '',
    available: '',
    unsettled: '',
  });
  assert.deepEqual(run(documentFor(false)), {
    status: 'schema_changed',
    heading: '',
    available: '',
    unsettled: '',
  });
});
