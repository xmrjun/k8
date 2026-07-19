'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let createImNetworkMonitor;
try {
  ({ createImNetworkMonitor } = require('../src/realtime/im-network-monitor'));
} catch {
  createImNetworkMonitor = undefined;
}

class FakeCdpClient {
  constructor() {
    this.calls = [];
    this.handlers = new Map();
    this.disconnectHandlers = new Set();
    this.bodies = new Map();
    this.closed = false;
  }

  async call(method, params = {}) {
    this.calls.push({ method, params });
    if (method === 'Network.getResponseBody') {
      const result = this.bodies.get(params.requestId);
      if (result instanceof Error) throw result;
      return result;
    }
    return {};
  }

  subscribe(method, handler) {
    const handlers = this.handlers.get(method) || new Set();
    handlers.add(handler);
    this.handlers.set(method, handlers);
    return () => handlers.delete(handler);
  }

  onDisconnect(handler) {
    this.disconnectHandlers.add(handler);
    return () => this.disconnectHandlers.delete(handler);
  }

  emit(method, params) {
    for (const handler of [...(this.handlers.get(method) || [])]) handler(params);
  }

  disconnect() {
    for (const handler of [...this.disconnectHandlers]) handler();
    this.disconnectHandlers.clear();
  }

  close() {
    this.closed = true;
  }
}

function fakeTimers() {
  const pending = [];
  return {
    pending,
    setTimeoutImpl(callback, delay) {
      const entry = { callback, delay, cleared: false };
      pending.push(entry);
      return entry;
    },
    clearTimeoutImpl(entry) {
      if (entry) entry.cleared = true;
    },
    async runNext() {
      const entry = pending.find((candidate) => !candidate.cleared);
      assert.ok(entry, 'expected a pending timer');
      entry.cleared = true;
      await entry.callback();
      await new Promise((resolve) => setImmediate(resolve));
      return entry.delay;
    },
  };
}

function createHarness(options = {}) {
  const clients = [];
  const responses = [];
  const diagnostics = [];
  const disconnects = [];
  const timers = fakeTimers();
  const privateDebuggerUrl = 'ws://127.0.0.1:9223/devtools/page/private-target';
  const monitor = createImNetworkMonitor({
    pageOrigin: 'https://sports.example',
    targetDiscovery: {
      async discover() {
        return { webSocketDebuggerUrl: privateDebuggerUrl };
      },
    },
    cdpClientFactory(config) {
      const client = new FakeCdpClient();
      client.config = config;
      clients.push(client);
      return client;
    },
    onResponse(value) {
      responses.push(value);
      return { needsResync: false };
    },
    onDisconnect() {
      disconnects.push(true);
    },
    onDiagnostic(value) {
      diagnostics.push(value);
    },
    ...timers,
    ...options,
  });
  return {
    monitor,
    clients,
    responses,
    diagnostics,
    disconnects,
    timers,
    privateDebuggerUrl,
  };
}

function emitRequest(client, requestId, overrides = {}) {
  const url = overrides.url || 'https://sports.example/feed?private=query';
  client.emit('Network.requestWillBeSent', {
    requestId,
    type: overrides.requestType || 'Fetch',
    request: { url, method: overrides.method || 'POST' },
  });
  client.emit('Network.responseReceived', {
    requestId,
    type: overrides.responseType || 'Fetch',
    response: {
      url: overrides.responseUrl || url,
      status: overrides.status ?? 200,
      mimeType: overrides.mimeType || 'application/json',
    },
  });
  client.emit('Network.loadingFinished', {
    requestId,
    encodedDataLength: overrides.encodedDataLength ?? 100,
  });
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('enables bounded CDP Network events on the discovered target', async () => {
  assert.equal(typeof createImNetworkMonitor, 'function');
  const harness = createHarness();
  await harness.monitor.start();

  assert.equal(harness.clients.length, 1);
  assert.deepEqual(harness.clients[0].calls[0], {
    method: 'Network.enable',
    params: {
      maxTotalBufferSize: 10_000_000,
      maxResourceBufferSize: 2_000_000,
      maxPostDataSize: 0,
    },
  });
  assert.equal(harness.clients[0].config.webSocketUrl, harness.privateDebuggerUrl);
  assert.equal(harness.clients[0].config.maxMessageBytes, 4_100_000);
  assert.deepEqual(harness.monitor.status(), { connected: true, pendingRequests: 0 });
});

test('passes only classified same-origin JSON Fetch response bodies', async () => {
  const harness = createHarness();
  await harness.monitor.start();
  const client = harness.clients[0];
  client.bodies.set('snapshot', {
    body: JSON.stringify({ StatusCode: 100, sel: [] }),
    base64Encoded: false,
  });

  emitRequest(client, 'snapshot');
  await flush();

  assert.equal(harness.responses.length, 1);
  assert.equal(harness.responses[0].type, 'snapshot');
  assert.deepEqual(client.calls.at(-1), {
    method: 'Network.getResponseBody',
    params: { requestId: 'snapshot' },
  });
  assert.equal(harness.monitor.status().pendingRequests, 0);
});

test('filters origin, method, resource type, status, MIME, and encoded size before body reads', async () => {
  const harness = createHarness();
  await harness.monitor.start();
  const client = harness.clients[0];
  for (const requestId of ['origin', 'method', 'request-type', 'response-type', 'status', 'mime', 'size']) {
    client.bodies.set(requestId, {
      body: JSON.stringify({ StatusCode: 100, dc: [] }),
      base64Encoded: false,
    });
  }

  emitRequest(client, 'origin', { url: 'https://sports.example.evil.invalid/feed' });
  emitRequest(client, 'method', { method: 'GET' });
  emitRequest(client, 'request-type', { requestType: 'XHR' });
  emitRequest(client, 'response-type', { responseType: 'XHR' });
  emitRequest(client, 'status', { status: 204 });
  emitRequest(client, 'mime', { mimeType: 'text/html' });
  emitRequest(client, 'size', { encodedDataLength: 2_000_001 });
  await flush();

  assert.equal(client.calls.filter((call) => call.method === 'Network.getResponseBody').length, 0);
  assert.deepEqual(harness.responses, []);
});

test('rejects base64, oversized decoded bodies, unknown JSON, and duplicate completion', async () => {
  const harness = createHarness({ maxResponseBytes: 64 });
  await harness.monitor.start();
  const client = harness.clients[0];
  client.bodies.set('base64', { body: 'e30=', base64Encoded: true });
  client.bodies.set('large', { body: '界'.repeat(30), base64Encoded: false });
  client.bodies.set('unknown', { body: '{"private":"body"}', base64Encoded: false });
  client.bodies.set('duplicate', {
    body: JSON.stringify({ StatusCode: 100, dc: [] }),
    base64Encoded: false,
  });

  for (const id of ['base64', 'large', 'unknown', 'duplicate']) {
    emitRequest(client, id, { encodedDataLength: 20 });
  }
  client.emit('Network.loadingFinished', { requestId: 'duplicate', encodedDataLength: 20 });
  await flush();

  assert.equal(harness.responses.length, 1);
  assert.equal(client.calls.filter(
    (call) => call.method === 'Network.getResponseBody' && call.params.requestId === 'duplicate',
  ).length, 1);
});

test('bounds and cleans the request correlation map', async () => {
  const harness = createHarness({ maxRequests: 2 });
  await harness.monitor.start();
  const client = harness.clients[0];
  for (const id of ['one', 'two', 'three']) {
    client.emit('Network.requestWillBeSent', {
      requestId: id,
      type: 'Fetch',
      request: { url: 'https://sports.example/feed', method: 'POST' },
    });
  }
  assert.equal(harness.monitor.status().pendingRequests, 2);

  client.emit('Network.loadingFailed', { requestId: 'two' });
  assert.equal(harness.monitor.status().pendingRequests, 1);
  client.emit('Network.loadingFinished', { requestId: 'one', encodedDataLength: 10 });
  await flush();
  assert.equal(client.calls.some(
    (call) => call.method === 'Network.getResponseBody' && call.params.requestId === 'one',
  ), false);
});

test('disconnect clears state, reports unavailability, and schedules bounded reconnect', async () => {
  const harness = createHarness();
  await harness.monitor.start();
  const client = harness.clients[0];
  client.emit('Network.requestWillBeSent', {
    requestId: 'pending',
    type: 'Fetch',
    request: { url: 'https://sports.example/feed', method: 'POST' },
  });

  client.disconnect();

  assert.deepEqual(harness.disconnects, [true]);
  assert.deepEqual(harness.monitor.status(), { connected: false, pendingRequests: 0 });
  assert.equal(harness.timers.pending.at(-1).delay, 250);
  assert.equal(await harness.timers.runNext(), 250);
  assert.equal(harness.clients.length, 2);
});

test('failed discovery retries with exponential backoff capped at ten seconds', async () => {
  const timers = fakeTimers();
  let attempts = 0;
  const diagnostics = [];
  const monitor = createImNetworkMonitor({
    pageOrigin: 'https://sports.example',
    targetDiscovery: {
      async discover() {
        attempts += 1;
        throw new Error('https://private.invalid/?secret=value');
      },
    },
    cdpClientFactory() {
      throw new Error('not reached');
    },
    onResponse() {},
    onDiagnostic(value) { diagnostics.push(value); },
    ...timers,
  });

  await monitor.start();
  const delays = [timers.pending.at(-1).delay];
  for (let index = 0; index < 7; index += 1) {
    await timers.runNext();
    delays.push(timers.pending.at(-1).delay);
  }

  assert.deepEqual(delays, [250, 500, 1000, 2000, 4000, 8000, 10000, 10000]);
  assert.equal(attempts, 8);
  assert.equal(JSON.stringify(diagnostics).includes('private.invalid'), false);
});

test('feed resync requests cause at most one reload per fifteen seconds', async () => {
  let currentTime = 50_000;
  const harness = createHarness({
    now: () => currentTime,
    onResponse(value) {
      harness.responses.push(value);
      return { needsResync: true };
    },
  });
  await harness.monitor.start();
  const client = harness.clients[0];
  for (const id of ['first', 'second', 'third']) {
    client.bodies.set(id, {
      body: JSON.stringify({ StatusCode: 100, dc: [] }),
      base64Encoded: false,
    });
  }

  emitRequest(client, 'first');
  emitRequest(client, 'second');
  await flush();
  assert.equal(client.calls.filter((call) => call.method === 'Page.reload').length, 1);

  currentTime += 15_001;
  emitRequest(client, 'third');
  await flush();
  assert.equal(client.calls.filter((call) => call.method === 'Page.reload').length, 2);
});

test('diagnostics never contain URLs, response bodies, headers, or debugger targets', async () => {
  const privateBody = '{"private":"must-not-leak"}';
  const harness = createHarness();
  await harness.monitor.start();
  const client = harness.clients[0];
  client.bodies.set('private', { body: privateBody, base64Encoded: false });
  emitRequest(client, 'private', {
    url: 'https://sports.example/feed?token=must-not-leak',
  });
  await flush();

  const serialized = JSON.stringify(harness.diagnostics);
  for (const forbidden of ['must-not-leak', privateBody, harness.privateDebuggerUrl, 'headers']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('stop is idempotent and prevents reconnect after client closure', async () => {
  const harness = createHarness();
  await harness.monitor.start();
  const client = harness.clients[0];

  await harness.monitor.stop();
  await harness.monitor.stop();
  client.disconnect();

  assert.equal(client.closed, true);
  assert.equal(harness.timers.pending.some((entry) => !entry.cleared), false);
  assert.deepEqual(harness.monitor.status(), { connected: false, pendingRequests: 0 });
});
