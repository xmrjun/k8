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

function markdownTableHasStatusCodeRow(markdown, status, code) {
  return markdown.split(/\r?\n/).some((row) => {
    const cells = row.split('|').slice(1, -1).map((cell) => cell.trim());
    return cells.length >= 2
      && cells[0] === `\`${status}\``
      && cells[1].includes(`\`${code}\``);
  });
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
  assert.equal(
    calls[1].url,
    'http://127.0.0.1:8788/api/sports?scope=live&sport=football',
  );
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

test('documentation error matcher requires status and code in the same table row', () => {
  const splitRows = [
    '| `400` | `SOME_OTHER_CODE` |',
    '| `999` | `INVALID_REQUEST` |',
  ].join('\n');

  assert.equal(markdownTableHasStatusCodeRow(splitRows, 400, 'INVALID_REQUEST'), false);
});

test('manual bet draft docs define the complete safe handoff contract', () => {
  const readme = projectFile('README.md');
  const operations = projectFile('docs/operations.md');
  const upstream = projectFile('docs/im-sports-upstream.md');

  assert.match(readme, /POST \/api\/bets\/drafts/);
  assert.match(readme, /Bearer.*application\/json.*不接受查询参数.*8192 字节/s);
  const curlMatch = readme.match(/```bash\n(curl --request POST[\s\S]*?)\n```/);
  assert.ok(curlMatch, 'README must include the draft curl template');
  const curlTemplate = curlMatch[1];
  for (const [field, placeholder] of [
    ['scope', 'SCOPE'],
    ['sport', 'SPORT'],
    ['event_id', 'EVENT_ID'],
    ['selection_key', 'SELECTION_KEY'],
    ['stake', 'STAKE_DECIMAL'],
    ['expected_odds', 'EXPECTED_ODDS_DECIMAL'],
    ['max_odds_drift', 'MAX_ODDS_DRIFT_DECIMAL'],
    ['idempotency_key', 'IDEMPOTENCY_KEY'],
  ]) {
    assert.match(curlTemplate, new RegExp(`"${field}": "<${placeholder}>"`));
  }
  assert.match(curlTemplate, /https:\/\/<API_HOST>\/api\/bets\/drafts/);
  assert.match(curlTemplate, /Authorization: Bearer <API_TOKEN>/);
  assert.doesNotMatch(
    curlTemplate,
    /"(?:scope|sport|stake|expected_odds|max_odds_drift)": "(?:live|football|10\.00|1\.95|0\.05)"/,
  );
  const responseMatch = readme.match(/成功响应示例：\n\n```json\n([\s\S]*?)\n```/);
  assert.ok(responseMatch, 'README must include the draft response template');
  for (const placeholder of [
    'SCOPE',
    'SPORT',
    'EVENT_ID',
    'SELECTION_KEY',
    'STAKE_DECIMAL',
    'EXPECTED_ODDS_DECIMAL',
    'CURRENT_ODDS_DECIMAL',
    'MAX_ODDS_DRIFT_DECIMAL',
    'PROJECTED_GROSS_RETURN_DECIMAL',
  ]) {
    assert.match(responseMatch[1], new RegExp(`<${placeholder}>`));
  }
  for (const field of [
    'scope',
    'sport',
    'event_id',
    'selection_key',
    'stake',
    'expected_odds',
    'max_odds_drift',
    'idempotency_key',
  ]) {
    assert.match(readme, new RegExp('`' + field + '`'));
  }
  assert.match(readme, /live.*today.*early.*football.*basketball.*tennis/s);
  assert.match(readme, /120 秒.*1000.*重启.*失效/s);
  assert.match(readme, /不使用.*HTTP.*缓存.*当前赔率.*偏差.*预计总回报/s);
  assert.match(readme, /幂等.*并发.*合并/s);
  assert.match(readme, /ready_for_manual_confirmation.*current_odds.*created_at.*expires_at/s);
  assert.match(readme, /fetched_at.*实际校验时间.*重放.*原始/s);
  assert.match(readme, /IM 体育页面.*手动.*最终确认/s);
  assert.match(readme, /只读.*选择.*scope.*sport.*筛选.*绝不点击.*赔率.*下注单.*提交.*确认.*取消.*结算.*兑现.*私有下注端点/s);
  for (const [status, code] of [
    [400, 'INVALID_REQUEST'],
    [409, 'IDEMPOTENCY_CONFLICT'],
    [409, 'EVENT_UNAVAILABLE'],
    [409, 'SELECTION_UNAVAILABLE'],
    [409, 'ODDS_DRIFT_EXCEEDED'],
    [413, 'PAYLOAD_TOO_LARGE'],
    [415, 'UNSUPPORTED_MEDIA_TYPE'],
    [415, 'UNSUPPORTED_CHARSET'],
    [405, 'METHOD_NOT_ALLOWED'],
    [500, 'INTERNAL_ERROR'],
    [502, 'MALFORMED_CURRENT_SNAPSHOT'],
    [503, 'DRAFT_CAPACITY_EXCEEDED'],
    [503, 'BROWSER_UNAVAILABLE'],
    [502, 'UPSTREAM_AUTH_EXPIRED'],
    [504, 'UPSTREAM_TIMEOUT'],
    [502, 'UPSTREAM_BAD_RESPONSE'],
    [502, 'UPSTREAM_SCHEMA_CHANGED'],
  ]) {
    assert.equal(
      markdownTableHasStatusCodeRow(readme, status, code),
      true,
      `${status} ${code} must appear in one README table row`,
    );
  }
  assert.match(readme, /请求、响应、文档示例和日志.*凭证.*Cookie.*Web Storage.*URL.*token/s);

  assert.match(operations, /IM 体育页面.*登录.*保持打开/s);
  assert.match(operations, /重启.*草稿.*失效/s);
  assert.match(operations, /DRAFT_CAPACITY_EXCEEDED.*稍后.*重试/s);
  assert.match(operations, /内存.*不持久化/s);
  assert.match(operations, /手动.*最终确认/s);
  assert.match(operations, /冒烟.*响应结构.*不打印.*请求体.*响应体/s);
  assert.match(operations, /IDEMPOTENCY_CONFLICT.*同一.*idempotency_key.*不同.*规范化.*原.*payload.*新.*key/s);
  assert.match(operations, /EVENT_UNAVAILABLE.*SELECTION_UNAVAILABLE.*ODDS_DRIFT_EXCEEDED.*重新获取.*当前赔率.*新建草稿/s);
  assert.match(operations, /只读.*选择.*scope.*sport.*筛选.*绝不点击.*赔率.*下注单.*提交.*确认.*取消.*结算.*兑现.*私有下注端点/s);

  assert.match(upstream, /POST \/api\/bets\/drafts/);
  assert.match(upstream, /existing.*read-only.*getSports.*fresh.*snapshot/is);
  assert.match(upstream, /does not use.*HTTP sports cache/is);
  assert.match(upstream, /exactly one.*event_id.*exactly one.*selection_key.*schema/is);
  assert.match(upstream, /truncated=true.*MALFORMED_CURRENT_SNAPSHOT.*fail closed/is);
  assert.match(upstream, /never calls\s+private venue endpoints/is);
  assert.match(upstream, /credentials.*cookies.*Web Storage.*URLs.*URL tokens/is);
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
