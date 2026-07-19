const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createConfiguredUpstream,
  createHttpServer,
  createDisabledUpstream,
} = require('../src/server');
const { CODES } = require('../src/upstream/errors');
const { WebSocket } = require('ws');

const config = {
  apiToken: 'server-test-token-that-is-at-least-32-characters',
  sportsCacheMs: 5000,
  upstreamMode: 'disabled',
};

const browserConfig = {
  ...config,
  wsToken: 'server-websocket-token-that-is-at-least-32-characters',
  upstreamMode: 'browser',
  browserTransport: 'cdp',
  browserCdpUrl: 'http://127.0.0.1:9223',
  browserPageOrigin: 'https://k81128.com',
  browserSportsOrigin: 'https://sports.example.test:2053',
  browserOperationTimeoutMs: 1234,
};

function injectedBrowserUpstream(calls = []) {
  return {
    async getSports() { return []; },
    async getSportsAccount() { return {}; },
    async getBalance() { return {}; },
    async getBets() { return []; },
    async close() { calls.push('upstream.close'); },
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

function rejectedUpgrade(url) {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(url);
    client.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    client.once('open', () => reject(new Error('unexpected connection')));
    client.once('error', () => {});
  });
}

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
    { cdpUrl: 'http://127.0.0.1:9223', pageOrigin: 'https://sports.example.test:2053', pagePathname: '/' },
    { cdpUrl: 'http://127.0.0.1:9223', pageOrigin: 'https://k81128.com', pagePathname: '/' },
    { cdpUrl: 'http://127.0.0.1:9223', pageOrigin: 'https://sports.example.test:2053', pagePathname: '/popup/' },
  ]);
  assert.equal(queues.length, 1);
  assert.deepEqual(queues[0].options, { timeoutMs: 1234 });
});

test('Apple Events browser transport creates exact-purpose gateways with no CDP URL', () => {
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
    { pageOrigin: 'https://sports.example.test:2053', pagePathname: '/' },
    { pageOrigin: 'https://k81128.com', pagePathname: '/' },
    { pageOrigin: 'https://sports.example.test:2053', pagePathname: '/popup/' },
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

test('CDP server composes and starts one realtime monitor without delaying listen', async () => {
  const calls = [];
  const feed = {
    ingest(value) { calls.push(['feed.ingest', value]); return { needsResync: false }; },
    invalidate() { calls.push(['feed.invalidate']); },
    snapshot() { return null; },
    isStale() { return true; },
    subscribe() { return () => {}; },
    nextSequence() { return 1; },
  };
  let monitorOptions;
  let wsOptions;
  let releaseStart;
  const startPending = new Promise((resolve) => { releaseStart = resolve; });
  const server = createHttpServer(browserConfig, injectedBrowserUpstream(calls), {
    feedFactory(options) {
      calls.push(['feed.create', options]);
      return feed;
    },
    monitorFactory(options) {
      monitorOptions = options;
      return {
        async start() { calls.push('monitor.start'); await startPending; },
        async stop() { calls.push('monitor.stop'); },
      };
    },
    wsFeedFactory(options) {
      wsOptions = options;
      return { async close() { calls.push('ws.close'); } };
    },
  });

  await listen(server);
  assert.equal(calls.includes('monitor.start'), true);
  assert.equal(wsOptions.server, server);
  assert.equal(wsOptions.feed, feed);
  assert.equal(wsOptions.token, browserConfig.wsToken);
  assert.equal(monitorOptions.cdpUrl, browserConfig.browserCdpUrl);
  assert.equal(monitorOptions.pageOrigin, browserConfig.browserSportsOrigin);
  assert.deepEqual(monitorOptions.onResponse('decoded'), { needsResync: false });
  monitorOptions.onDisconnect();
  assert.deepEqual(calls.slice(-2), [
    ['feed.ingest', 'decoded'],
    ['feed.invalidate'],
  ]);

  releaseStart();
  await new Promise((resolve, reject) => server.close((error) => (
    error ? reject(error) : resolve()
  )));
  await server.waitForShutdown();
  assert.deepEqual(calls.slice(-3), ['monitor.stop', 'ws.close', 'upstream.close']);
});

test('Apple Events rollback mode never starts realtime and returns 503 on upgrade', async () => {
  const rollbackConfig = { ...browserConfig, browserTransport: 'apple_events' };
  let monitorCreated = 0;
  let wsCreated = 0;
  const server = createHttpServer(rollbackConfig, injectedBrowserUpstream(), {
    monitorFactory() { monitorCreated += 1; },
    wsFeedFactory() { wsCreated += 1; },
  });
  const port = await listen(server);

  assert.equal(
    await rejectedUpgrade(`ws://127.0.0.1:${port}/ws/sports?token=anything`),
    503,
  );
  assert.equal(monitorCreated, 0);
  assert.equal(wsCreated, 0);

  await new Promise((resolve, reject) => server.close((error) => (
    error ? reject(error) : resolve()
  )));
  await server.waitForShutdown();
});

test('monitor startup failure preserves health but leaves realtime unavailable', async () => {
  const feed = {
    invalidated: 0,
    ingest() { return { needsResync: false }; },
    invalidate() { this.invalidated += 1; },
    snapshot() { return null; },
    isStale() { return true; },
    subscribe() { return () => {}; },
    nextSequence() { return 1; },
  };
  const server = createHttpServer(browserConfig, injectedBrowserUpstream(), {
    feedFactory: () => feed,
    monitorFactory: () => ({
      async start() { throw new Error('private startup detail'); },
      async stop() {},
    }),
  });
  const port = await listen(server);
  await new Promise((resolve) => setImmediate(resolve));

  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  assert.equal(feed.invalidated, 1);
  assert.equal(
    await rejectedUpgrade(
      `ws://127.0.0.1:${port}/ws/sports?token=${browserConfig.wsToken}`,
    ),
    503,
  );

  await new Promise((resolve, reject) => server.close((error) => (
    error ? reject(error) : resolve()
  )));
  await server.waitForShutdown();
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
