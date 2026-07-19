const test = require('node:test');
const assert = require('node:assert/strict');

const { createBrowserUpstream } = require('../src/upstream/browser');
const { createOperationQueue } = require('../src/browser/operation-queue');
const { CODES, upstreamError } = require('../src/upstream/errors');

function reader(name) {
  return {
    buildExpression(options) {
      return `${name}:${JSON.stringify(options || {})}`;
    },
    normalize(value, options) {
      return { name, value, options };
    },
  };
}

function gateway(name, calls) {
  return {
    async evaluate(expression, options) {
      calls.push({ name, expression, options });
      return { from: name };
    },
    async close() {
      calls.push({ name, close: true });
    },
  };
}

test('sports reads use only the sports gateway and preserve query options', async () => {
  const calls = [];
  const upstream = createBrowserUpstream({
    sportsGateway: gateway('sports', calls),
    accountGateway: gateway('account', calls),
    betsGateway: gateway('bets', calls),
    queue: createOperationQueue(),
    readers: {
      sports: reader('sports-reader'),
      sportsAccount: reader('sports-account-reader'),
      balance: reader('balance-reader'),
      bets: reader('bets-reader'),
    },
  });

  const result = await upstream.getSports({ scope: 'live', sport: 'football' });

  assert.deepEqual(result, {
    name: 'sports-reader',
    value: { from: 'sports' },
    options: { scope: 'live', sport: 'football' },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'sports');
  assert.equal(calls[0].options.signal instanceof AbortSignal, true);
});

test('sports account reads use only the sports gateway', async () => {
  const calls = [];
  const upstream = createBrowserUpstream({
    sportsGateway: gateway('sports', calls),
    accountGateway: gateway('account', calls),
    betsGateway: gateway('bets', calls),
    queue: createOperationQueue(),
    readers: {
      sports: reader('sports-reader'),
      sportsAccount: reader('sports-account-reader'),
      balance: reader('balance-reader'),
      bets: reader('bets-reader'),
    },
  });

  const result = await upstream.getSportsAccount();

  assert.deepEqual(result, {
    name: 'sports-account-reader',
    value: { from: 'sports' },
    options: undefined,
  });
  assert.deepEqual(calls.map((call) => call.name), ['sports']);
  assert.match(calls[0].expression, /sports-account-reader/);
});

test('balance and bet reads use separate exact-purpose gateways', async () => {
  const calls = [];
  const upstream = createBrowserUpstream({
    sportsGateway: gateway('sports', calls),
    accountGateway: gateway('account', calls),
    betsGateway: gateway('bets', calls),
    queue: createOperationQueue(),
    readers: {
      sports: reader('sports-reader'),
      sportsAccount: reader('sports-account-reader'),
      balance: reader('balance-reader'),
      bets: reader('bets-reader'),
    },
  });

  await upstream.getBalance();
  await upstream.getBets({ limit: 25, cursor: 'next' });

  assert.deepEqual(calls.map((call) => call.name), ['account', 'bets']);
  assert.match(calls[1].expression, /bets-reader/);
});

test('sports and account browser operations share one serial queue', async () => {
  let active = 0;
  let maximumActive = 0;
  const delayedGateway = {
    async evaluate(expression) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return expression;
    },
    async close() {},
  };
  const upstream = createBrowserUpstream({
    sportsGateway: delayedGateway,
    accountGateway: delayedGateway,
    betsGateway: delayedGateway,
    queue: createOperationQueue(),
    readers: {
      sports: reader('sports-reader'),
      sportsAccount: reader('sports-account-reader'),
      balance: reader('balance-reader'),
      bets: reader('bets-reader'),
    },
  });

  await Promise.all([
    upstream.getSports(),
    upstream.getSportsAccount(),
    upstream.getBalance(),
    upstream.getBets(),
  ]);

  assert.equal(maximumActive, 1);
});

test('unknown gateway errors are replaced with a sanitized browser error', async () => {
  const secret = 'private-browser-implementation-detail';
  const maliciousGateway = {
    async evaluate() {
      const error = new Error(secret);
      error.code = CODES.AUTH_EXPIRED;
      throw error;
    },
    async close() {},
  };
  const upstream = createBrowserUpstream({
    sportsGateway: maliciousGateway,
    accountGateway: maliciousGateway,
    betsGateway: maliciousGateway,
    queue: createOperationQueue(),
    readers: { sports: reader('sports-reader') },
  });

  await assert.rejects(
    upstream.getSports(),
    (error) => error.code === CODES.BROWSER_UNAVAILABLE
      && !error.cause
      && !JSON.stringify(error).includes(secret),
  );
});

test('trusted browser, timeout, auth, and schema errors preserve only stable codes', async () => {
  for (const code of [
    CODES.BROWSER_UNAVAILABLE,
    CODES.TIMEOUT,
    CODES.AUTH_EXPIRED,
    CODES.SCHEMA_CHANGED,
  ]) {
    const failingGateway = {
      async evaluate() { throw upstreamError(code, 'sanitized internal message'); },
      async close() {},
    };
    const upstream = createBrowserUpstream({
      sportsGateway: failingGateway,
      accountGateway: failingGateway,
      betsGateway: failingGateway,
      queue: createOperationQueue(),
      readers: { sports: reader('sports-reader') },
    });
    await assert.rejects(upstream.getSports(), (error) => error.code === code && !error.cause);
  }
});

test('sports failure never falls back to the account page', async () => {
  let accountCalls = 0;
  const upstream = createBrowserUpstream({
    sportsGateway: {
      async evaluate() {
        throw upstreamError(CODES.BROWSER_UNAVAILABLE, 'sports page missing');
      },
      async close() {},
    },
    accountGateway: {
      async evaluate() {
        accountCalls += 1;
        return {};
      },
      async close() {},
    },
    betsGateway: gateway('bets', []),
    queue: createOperationQueue(),
    readers: { sports: reader('sports-reader') },
  });

  await assert.rejects(upstream.getSports(), (error) => error.code === CODES.BROWSER_UNAVAILABLE);
  assert.equal(accountCalls, 0);
});

test('close releases all three browser gateways exactly once', async () => {
  const calls = [];
  const upstream = createBrowserUpstream({
    sportsGateway: gateway('sports', calls),
    accountGateway: gateway('account', calls),
    betsGateway: gateway('bets', calls),
    queue: createOperationQueue(),
    readers: { sports: reader('sports-reader') },
  });

  await upstream.close();
  await upstream.close();

  assert.deepEqual(calls, [
    { name: 'sports', close: true },
    { name: 'account', close: true },
    { name: 'bets', close: true },
  ]);
});

test('default readers normalize balance and IM Sports records on separate gateways', async () => {
  const accountGateway = {
    async evaluate(expression) {
      if (expression.includes('.gameTable')) {
        return {
          status: 'ready',
          empty: true,
          currency: 'USDT',
          rows: [],
        };
      }
      return {
        status: 'ready',
        wallets: [{ currency: 'USDT', amount: '1.25', active: true }],
      };
    },
    async close() {},
  };
  const betsGateway = {
    async evaluate() {
      return {
        status: 'ready',
        currency_label: '投注金额 (USD)',
        tabs: [{ record_status: 'unsettled', empty: true, rows: [] }],
      };
    },
    async close() {},
  };
  const upstream = createBrowserUpstream({
    sportsGateway: gateway('sports', []),
    accountGateway,
    betsGateway,
    queue: createOperationQueue(),
  });

  assert.deepEqual(await upstream.getBalance(), {
    active_currency: 'USDT',
    total: 1.25,
    wallets: [{ currency: 'USDT', amount: 1.25 }],
  });
  assert.deepEqual(await upstream.getBets({ status: 'unsettled', limit: 25 }), []);
});
