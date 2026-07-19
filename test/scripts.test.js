const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { EventEmitter } = require('node:events');

const projectRoot = path.join(__dirname, '..');

function projectFile(name) {
  return fs.readFileSync(path.join(projectRoot, name), 'utf8');
}

async function importScript(name) {
  return import(pathToFileURL(path.join(projectRoot, 'scripts', name)).href);
}

test('generateToken creates at least 32 random bytes encoded as base64url', async () => {
  const { generateToken } = await importScript('generate-token.mjs');
  const token = generateToken();
  assert.ok(Buffer.from(token, 'base64url').length >= 32);
});

test('writeTokenFile creates a private env file and refuses to overwrite it', async (t) => {
  const { writeTokenFile } = await importScript('generate-token.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'k8-token-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, '.env.local');

  writeTokenFile(output);

  const contents = fs.readFileSync(output, 'utf8');
  const token = contents.match(/^API_TOKEN=(.+)$/m)[1];
  assert.ok(Buffer.from(token, 'base64url').length >= 32);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  assert.throws(() => writeTokenFile(output), /already exists/);
});

test('generate-token CLI never prints the generated token', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'k8-token-cli-'));
  const output = path.join(directory, '.env.local');
  try {
    const result = spawnSync(process.execPath, [
      path.join(projectRoot, 'scripts', 'generate-token.mjs'),
      '--output',
      output,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const token = fs.readFileSync(output, 'utf8').match(/^API_TOKEN=(.+)$/m)[1];
    assert.equal(result.stdout.includes(token), false);
    assert.equal(result.stderr.includes(token), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('smokeTest requires an API token before making any request', async () => {
  const { smokeTest } = await importScript('smoke-test.mjs');
  let called = false;
  await assert.rejects(
    smokeTest({
      baseUrl: 'http://127.0.0.1:8788',
      token: '',
      fetchImpl: async () => { called = true; },
    }),
    /API_TOKEN is required/,
  );
  assert.equal(called, false);
});

test('smokeTest checks health and proves the protected route accepted the token', async () => {
  const { smokeTest } = await importScript('smoke-test.mjs');
  const token = 'smoke-secret-that-must-not-be-returned';
  const calls = [];
  const responses = [
    Response.json({ data: { status: 'ok' } }),
    Response.json({ error: { code: 'UPSTREAM_BAD_RESPONSE' } }, { status: 502 }),
  ];
  const result = await smokeTest({
    baseUrl: 'http://127.0.0.1:8788/',
    token,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return responses.shift();
    },
  });

  assert.deepEqual(result, { health: 'ok', protected_status: 502 });
  assert.equal(calls[0].url, 'http://127.0.0.1:8788/health');
  assert.equal(calls[1].url, 'http://127.0.0.1:8788/api/sports');
  assert.equal(calls[1].options.headers.authorization, `Bearer ${token}`);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test('smokeTest rejects a protected-route authentication failure', async () => {
  const { smokeTest } = await importScript('smoke-test.mjs');
  const responses = [
    Response.json({ data: { status: 'ok' } }),
    Response.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 }),
  ];
  await assert.rejects(
    smokeTest({
      baseUrl: 'http://127.0.0.1:8788',
      token: 'wrong-but-long-enough-token-value',
      fetchImpl: async () => responses.shift(),
    }),
    /authentication failed/,
  );
});

class FakeWebSocket extends EventEmitter {
  static instances = [];

  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit('open');
    });
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', 1000);
  }

  message(value) {
    this.emit('message', Buffer.from(JSON.stringify(value)));
  }
}

function controlledTimeout() {
  let callback;
  return {
    setTimeoutImpl(value) { callback = value; return 1; },
    clearTimeoutImpl() {},
    fire() { callback(); },
  };
}

test('wsSmokeTest requires WS_TOKEN before constructing a connection', async () => {
  const { wsSmokeTest } = await importScript('ws-smoke-test.mjs');
  FakeWebSocket.instances.length = 0;

  await assert.rejects(wsSmokeTest({
    baseUrl: 'ws://127.0.0.1:8788',
    token: '',
    WebSocketImpl: FakeWebSocket,
  }), /WS_TOKEN is required/);
  assert.equal(FakeWebSocket.instances.length, 0);
});

test('wsSmokeTest accepts the agreed message types and reports only aggregate counts', async () => {
  const { wsSmokeTest } = await importScript('ws-smoke-test.mjs');
  const timeout = controlledTimeout();
  const token = 'private-websocket-token-that-must-not-be-returned';
  FakeWebSocket.instances.length = 0;
  const pending = wsSmokeTest({
    baseUrl: 'https://k8.example.test/base?old=private',
    token,
    WebSocketImpl: FakeWebSocket,
    ...timeout,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const [socket] = FakeWebSocket.instances;

  assert.equal(socket.url.startsWith('wss://k8.example.test/ws/sports?token='), true);
  socket.message({ type: 'snapshot', events: [], seq: 10 });
  socket.message({
    type: 'delta', event_id: '1', selection_key: '1', decimal_odds: '1.9',
    line: null, available: true, seq: 11,
  });
  socket.message({ type: 'score', event_id: '1', score: '1-0', clock: '20:00', seq: 12 });
  socket.message({ type: 'ping', seq: 13 });
  timeout.fire();

  const result = await pending;
  assert.deepEqual(result, {
    status: 'ok',
    messages: 4,
    types: { snapshot: 1, delta: 1, score: 1, ping: 1 },
    monotonic_seq: true,
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes('k8.example.test'), false);
});

test('wsSmokeTest rejects unknown message types and non-monotonic sequences', async () => {
  const { wsSmokeTest } = await importScript('ws-smoke-test.mjs');
  for (const messages of [
    [{ type: 'private', seq: 1 }],
    [{ type: 'snapshot', events: [], seq: 5 }, { type: 'ping', seq: 5 }],
    [{ type: 'delta', seq: 1 }],
  ]) {
    const timeout = controlledTimeout();
    FakeWebSocket.instances.length = 0;
    const pending = wsSmokeTest({
      baseUrl: 'ws://127.0.0.1:8788',
      token: 'long-enough-test-websocket-token-value',
      WebSocketImpl: FakeWebSocket,
      ...timeout,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const [socket] = FakeWebSocket.instances;
    for (const message of messages) socket.message(message);
    await assert.rejects(pending, /WebSocket feed validation failed/);
  }
});

test('operations docs describe the dedicated Chrome realtime data path', () => {
  const operations = projectFile('docs/operations.md');

  assert.match(operations, /Cloudflare.*127\.0\.0\.1:8788.*127\.0\.0\.1:9223.*专用 Chrome/s);
  assert.match(operations, /wss:\/\/k8\.nbmrjun\.top\/ws\/sports\?token=<WS_TOKEN>/);
  assert.match(operations, /不得.*9223.*Cloudflare/s);
  assert.match(operations, /隧道配置.*无需修改/s);
  assert.match(operations, /只读/s);
});

test('package exposes native syntax checks for production JavaScript and JXA', () => {
  const packageJson = JSON.parse(projectFile('package.json'));

  assert.match(packageJson.scripts.check, /node --check src\/server\.js/);
  assert.match(packageJson.scripts.check, /node --check src\/realtime\/ws-feed-server\.js/);
  assert.equal(packageJson.scripts['smoke:ws'], 'node --env-file=.env.local scripts/ws-smoke-test.mjs');
  assert.match(packageJson.scripts.check, /node --check src\/browser\/apple-events-gateway\.js/);
  assert.match(
    packageJson.scripts.check,
    /\/usr\/bin\/osacompile -l JavaScript -o \/dev\/null scripts\/chrome-evaluate\.jxa/,
  );
});
