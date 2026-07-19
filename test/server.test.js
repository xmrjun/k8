const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createConfiguredUpstream,
  createHttpServer,
  createDisabledUpstream,
} = require('../src/server');
const { CODES } = require('../src/upstream/errors');

const config = {
  apiToken: 'server-test-token-that-is-at-least-32-characters',
  sportsCacheMs: 5000,
  upstreamMode: 'disabled',
};

test('createDisabledUpstream fails every query with a sanitized known error', async () => {
  const upstream = createDisabledUpstream();
  for (const operation of [
    () => upstream.getSports(),
    () => upstream.getSportsAccount(),
    () => upstream.getBalance(),
    () => upstream.getBets(),
  ]) {
    await assert.rejects(operation(), (error) => (
      error.code === CODES.BAD_RESPONSE && !error.cause
    ));
  }
});

test('CDP browser transport creates exact-origin gateways that share one queue', () => {
  const gateways = [];
  const queues = [];
  const browserConfig = {
    ...config,
    upstreamMode: 'browser',
    browserTransport: 'cdp',
    browserCdpUrl: 'http://127.0.0.1:9223',
    browserPageOrigin: 'https://k81128.com',
    browserSportsOrigin: 'https://sports.example.test:2053',
    browserOperationTimeoutMs: 1234,
  };
  const upstream = createConfiguredUpstream(browserConfig, {
    cdpGatewayFactory(options) {
      gateways.push(options);
      return { async evaluate() { return {}; }, async close() {} };
    },
    queueFactory(options) {
      const queue = { options, run: (operation) => operation({ signal: new AbortController().signal }) };
      queues.push(queue);
      return queue;
    },
  });

  assert.equal(typeof upstream.getSports, 'function');
  assert.equal(typeof upstream.getSportsAccount, 'function');
  assert.deepEqual(gateways, [
    { cdpUrl: 'http://127.0.0.1:9223', pageOrigin: 'https://sports.example.test:2053' },
    { cdpUrl: 'http://127.0.0.1:9223', pageOrigin: 'https://k81128.com' },
  ]);
  assert.equal(queues.length, 1);
  assert.deepEqual(queues[0].options, { timeoutMs: 1234 });
});

test('Apple Events browser transport creates dual exact-origin gateways with no CDP URL', () => {
  const appleGateways = [];
  const cdpGateways = [];
  const queues = [];
  const browserConfig = {
    ...config,
    upstreamMode: 'browser',
    browserTransport: 'apple_events',
    browserCdpUrl: 'http://127.0.0.1:9223',
    browserPageOrigin: 'https://k81128.com',
    browserSportsOrigin: 'https://sports.example.test:2053',
    browserOperationTimeoutMs: 4321,
  };

  const upstream = createConfiguredUpstream(browserConfig, {
    appleEventsGatewayFactory(options) {
      appleGateways.push(options);
      return { async evaluate() { return {}; }, async close() {} };
    },
    cdpGatewayFactory(options) {
      cdpGateways.push(options);
      return { async evaluate() { return {}; }, async close() {} };
    },
    queueFactory(options) {
      const queue = { options, run: (operation) => operation({ signal: new AbortController().signal }) };
      queues.push(queue);
      return queue;
    },
  });

  assert.equal(typeof upstream.getBalance, 'function');
  assert.equal(typeof upstream.getSportsAccount, 'function');
  assert.deepEqual(appleGateways, [
    { pageOrigin: 'https://sports.example.test:2053' },
    { pageOrigin: 'https://k81128.com' },
  ]);
  assert.deepEqual(cdpGateways, []);
  assert.equal(queues.length, 1);
  assert.deepEqual(queues[0].options, { timeoutMs: 4321 });
});

test('server shutdown closes an injected upstream lifecycle', async () => {
  let closed = 0;
  const upstream = {
    async getSports() { return []; },
    async getSportsAccount() { return {}; },
    async getBalance() { return {}; },
    async getBets() { return []; },
    async close() { closed += 1; },
  };
  const server = createHttpServer(config, upstream);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  await new Promise((resolve, reject) => server.close((error) => (
    error ? reject(error) : resolve()
  )));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(closed, 1);
});

test('createHttpServer serves health while production upstream remains disabled', async () => {
  const server = createHttpServer(config);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    const sports = await fetch(`http://127.0.0.1:${port}/api/sports`, {
      headers: { authorization: `Bearer ${config.apiToken}` },
    });
    assert.equal(health.status, 200);
    assert.equal(sports.status, 502);
    assert.equal((await sports.json()).error.code, CODES.BAD_RESPONSE);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    )));
  }
});
