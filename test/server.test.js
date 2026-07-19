const test = require('node:test');
const assert = require('node:assert/strict');

const { createHttpServer, createDisabledUpstream } = require('../src/server');
const { CODES } = require('../src/upstream/errors');

const config = {
  apiToken: 'server-test-token-that-is-at-least-32-characters',
  sportsCacheMs: 5000,
};

test('createDisabledUpstream fails every query with a sanitized known error', async () => {
  const upstream = createDisabledUpstream();
  for (const operation of [
    () => upstream.getSports(),
    () => upstream.getBalance(),
    () => upstream.getBets(),
  ]) {
    await assert.rejects(operation(), (error) => (
      error.code === CODES.BAD_RESPONSE && !error.cause
    ));
  }
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
