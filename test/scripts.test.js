const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const projectRoot = path.join(__dirname, '..');

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
