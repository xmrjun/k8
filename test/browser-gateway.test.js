const test = require('node:test');
const assert = require('node:assert/strict');

const { createBrowserGateway } = require('../src/browser/gateway');
const { CODES } = require('../src/upstream/errors');

class RespondingWebSocket {
  constructor(url, value) {
    this.url = url;
    this.value = value;
    this.readyState = 0;
    this.listeners = new Map();
    this.sent = [];
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit('open', {});
    });
  }

  addEventListener(type, listener, options = {}) {
    const entries = this.listeners.get(type) || [];
    entries.push({ listener, once: Boolean(options.once) });
    this.listeners.set(type, entries);
  }

  removeEventListener(type, listener) {
    const entries = this.listeners.get(type) || [];
    this.listeners.set(type, entries.filter((entry) => entry.listener !== listener));
  }

  emit(type, event) {
    const entries = [...(this.listeners.get(type) || [])];
    for (const entry of entries) {
      entry.listener(event);
      if (entry.once) this.removeEventListener(type, entry.listener);
    }
  }

  send(rawFrame) {
    const frame = JSON.parse(rawFrame);
    this.sent.push(frame);
    queueMicrotask(() => this.emit('message', {
      data: JSON.stringify({
        id: frame.id,
        result: {
          result: { type: 'object', value: this.value },
        },
      }),
    }));
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', {});
  }
}

function target(url, webSocketDebuggerUrl, type = 'page') {
  return { type, url, webSocketDebuggerUrl };
}

function responseFor(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('gateway selects only an exact allow-listed page origin and evaluates by value', async () => {
  const fetchCalls = [];
  const sockets = [];
  const gateway = createBrowserGateway({
    cdpUrl: 'http://127.0.0.1:9223',
    pageOrigin: 'https://k81128.com',
    async fetchImpl(url, options) {
      fetchCalls.push({ url, options });
      return responseFor([
        target('https://k81128.com.evil.example/sports', 'ws://127.0.0.1:9223/devtools/page/evil'),
        target('https://k81128.com/sports', 'ws://127.0.0.1:9223/devtools/page/allowed'),
      ]);
    },
    webSocketFactory(url) {
      const socket = new RespondingWebSocket(url, { events: [{ id: 'event-1' }] });
      sockets.push(socket);
      return socket;
    },
  });

  const result = await gateway.evaluate('({ events: [] })');

  assert.deepEqual(result, { events: [{ id: 'event-1' }] });
  assert.equal(fetchCalls[0].url, 'http://127.0.0.1:9223/json/list');
  assert.equal(fetchCalls[0].options.redirect, 'error');
  assert.equal(sockets[0].url, 'ws://127.0.0.1:9223/devtools/page/allowed');
  assert.deepEqual(sockets[0].sent[0], {
    id: 1,
    method: 'Runtime.evaluate',
    params: {
      expression: '({ events: [] })',
      awaitPromise: true,
      returnByValue: true,
    },
  });
});

test('gateway rejects unsafe CDP origins before making a request', async () => {
  let fetchCalled = false;
  assert.throws(() => createBrowserGateway({
    cdpUrl: 'http://192.168.1.10:9223',
    pageOrigin: 'https://k81128.com',
    async fetchImpl() {
      fetchCalled = true;
      return responseFor([]);
    },
  }), /loopback/);
  assert.equal(fetchCalled, false);
});

test('gateway rejects remote debugger WebSocket URLs returned by target discovery', async () => {
  const gateway = createBrowserGateway({
    cdpUrl: 'http://127.0.0.1:9223',
    pageOrigin: 'https://k81128.com',
    async fetchImpl() {
      return responseFor([
        target('https://k81128.com/sports', 'ws://attacker.example/devtools/page/allowed'),
      ]);
    },
  });

  await assert.rejects(
    gateway.evaluate('1'),
    (error) => error.code === CODES.BROWSER_UNAVAILABLE && !error.cause,
  );
});

test('gateway reconnects on the next request after a disconnect', async () => {
  let fetchCount = 0;
  const sockets = [];
  const gateway = createBrowserGateway({
    cdpUrl: 'http://127.0.0.1:9223',
    pageOrigin: 'https://k81128.com',
    async fetchImpl() {
      fetchCount += 1;
      return responseFor([
        target('https://k81128.com/sports', 'ws://127.0.0.1:9223/devtools/page/allowed'),
      ]);
    },
    webSocketFactory(url) {
      const socket = new RespondingWebSocket(url, { connection: sockets.length + 1 });
      sockets.push(socket);
      return socket;
    },
  });

  assert.deepEqual(await gateway.evaluate('1'), { connection: 1 });
  sockets[0].close();
  assert.deepEqual(await gateway.evaluate('2'), { connection: 2 });
  assert.equal(fetchCount, 2);
  assert.equal(sockets.length, 2);
});

test('gateway status exposes only connection state', async () => {
  const sockets = [];
  const gateway = createBrowserGateway({
    cdpUrl: 'http://127.0.0.1:9223',
    pageOrigin: 'https://k81128.com',
    async fetchImpl() {
      return responseFor([
        target('https://k81128.com/sports', 'ws://127.0.0.1:9223/devtools/page/allowed'),
      ]);
    },
    webSocketFactory(url) {
      const socket = new RespondingWebSocket(url, { ok: true });
      sockets.push(socket);
      return socket;
    },
  });

  assert.equal(await gateway.status(), 'page_found');
  await gateway.evaluate('1');
  assert.equal(await gateway.status(), 'connected');
  assert.deepEqual(Object.keys({ status: await gateway.status() }), ['status']);
});

test('gateway caps evaluated response values', async () => {
  const gateway = createBrowserGateway({
    cdpUrl: 'http://127.0.0.1:9223',
    pageOrigin: 'https://k81128.com',
    maxResponseBytes: 32,
    async fetchImpl() {
      return responseFor([
        target('https://k81128.com/sports', 'ws://127.0.0.1:9223/devtools/page/allowed'),
      ]);
    },
    webSocketFactory(url) {
      return new RespondingWebSocket(url, { secret: 'x'.repeat(100) });
    },
  });

  await assert.rejects(
    gateway.evaluate('1'),
    (error) => error.code === CODES.BAD_RESPONSE && !error.cause,
  );
});
