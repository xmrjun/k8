const test = require('node:test');
const assert = require('node:assert/strict');

const { createCdpClient } = require('../src/browser/cdp-client');
const { CODES } = require('../src/upstream/errors');

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
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

  send(value) {
    this.sent.push(JSON.parse(value));
  }

  message(frame) {
    this.emit('message', { data: JSON.stringify(frame) });
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', {});
  }
}

function createHarness(options = {}) {
  const sockets = [];
  const client = createCdpClient({
    webSocketUrl: 'ws://127.0.0.1:9223/devtools/page/allowed',
    webSocketFactory(url) {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      return socket;
    },
    ...options,
  });
  return { client, sockets };
}

test('CDP response IDs resolve only their matching requests', async () => {
  const { client, sockets } = createHarness();
  const first = client.call('Runtime.evaluate', { expression: 'first' });
  const second = client.call('Runtime.evaluate', { expression: 'second' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sockets.length, 1);
  const [firstFrame, secondFrame] = sockets[0].sent;
  sockets[0].message({ id: secondFrame.id, result: { value: 'second-result' } });
  sockets[0].message({ id: firstFrame.id, result: { value: 'first-result' } });

  assert.deepEqual(await Promise.all([first, second]), [
    { value: 'first-result' },
    { value: 'second-result' },
  ]);
  assert.notEqual(firstFrame.id, secondFrame.id);
});

test('CDP error frames are sanitized', async () => {
  const { client, sockets } = createHarness();
  const request = client.call('Runtime.evaluate', { expression: 'secret-expression' });
  await new Promise((resolve) => setImmediate(resolve));
  const [frame] = sockets[0].sent;
  sockets[0].message({
    id: frame.id,
    error: { message: 'private page implementation detail' },
  });

  await assert.rejects(request, (error) => (
    error.code === CODES.BAD_RESPONSE
      && !error.cause
      && !JSON.stringify(error).includes('private page implementation detail')
  ));
});

test('socket closure rejects pending CDP calls as browser unavailable', async () => {
  const { client, sockets } = createHarness();
  const request = client.call('Runtime.evaluate', { expression: 'pending' });
  await new Promise((resolve) => setImmediate(resolve));
  sockets[0].close();

  await assert.rejects(request, (error) => (
    error.code === CODES.BROWSER_UNAVAILABLE && !error.cause
  ));
  assert.equal(client.closed, true);
});

test('oversized CDP messages are rejected before parsing', async () => {
  const { client, sockets } = createHarness({ maxMessageBytes: 64 });
  const request = client.call('Runtime.evaluate', { expression: 'pending' });
  await new Promise((resolve) => setImmediate(resolve));
  sockets[0].emit('message', { data: JSON.stringify({ id: 1, value: 'x'.repeat(100) }) });

  await assert.rejects(request, (error) => (
    error.code === CODES.BAD_RESPONSE && !error.cause
  ));
  assert.equal(client.closed, true);
});

