const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createApp } = require('../src/app');
const { createFakeUpstream } = require('../src/upstream/fake');
const { upstreamError, CODES } = require('../src/upstream/errors');

const API_TOKEN = 'test-api-token-that-is-at-least-32-characters';

async function withServer(options, callback) {
  const server = http.createServer(createApp({
    apiToken: API_TOKEN,
    sportsCacheMs: 5000,
    now: () => new Date('2026-07-19T12:00:00.000Z'),
    requestId: () => 'request-test',
    ...options,
  }));

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();
  try {
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    )));
  }
}

async function request(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json(),
  };
}

function authorized(options = {}) {
  return {
    ...options,
    headers: {
      authorization: `Bearer ${API_TOKEN}`,
      ...options.headers,
    },
  };
}

test('GET /health succeeds without authentication', async () => {
  await withServer({ upstream: createFakeUpstream() }, async (baseUrl) => {
    const response = await request(baseUrl, '/health');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      data: { status: 'ok' },
      source: 'k8-api',
      fetched_at: '2026-07-19T12:00:00.000Z',
      request_id: 'request-test',
    });
  });
});

test('protected API routes reject a missing bearer token', async () => {
  await withServer({ upstream: createFakeUpstream() }, async (baseUrl) => {
    const response = await request(baseUrl, '/api/sports');
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'UNAUTHORIZED');
    assert.equal(response.headers.get('www-authenticate'), 'Bearer realm="k8-api"');
  });
});

test('GET /api/sports returns a stable envelope and caches the upstream result', async () => {
  const upstream = createFakeUpstream({ sports: [{ event_id: 'event-1' }] });
  await withServer({ upstream }, async (baseUrl) => {
    const first = await request(baseUrl, '/api/sports', authorized());
    const second = await request(baseUrl, '/api/sports', authorized());
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, {
      data: [{ event_id: 'event-1' }],
      source: 'k81128',
      fetched_at: '2026-07-19T12:00:00.000Z',
      request_id: 'request-test',
    });
    assert.deepEqual(second.body.data, first.body.data);
    assert.equal(upstream.calls.sports.length, 1);
  });
});

test('GET /api/balance never caches account data', async () => {
  const upstream = createFakeUpstream({ balance: { currency: 'CNY', total: 10 } });
  await withServer({ upstream }, async (baseUrl) => {
    const first = await request(baseUrl, '/api/balance', authorized());
    const second = await request(baseUrl, '/api/balance', authorized());
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.data, { currency: 'CNY', total: 10 });
    assert.equal(second.status, 200);
    assert.equal(upstream.calls.balance.length, 2);
  });
});

test('GET /api/bets forwards validated limit and cursor without caching', async () => {
  const upstream = createFakeUpstream({ bets: [{ bet_id: 'bet-1' }] });
  await withServer({ upstream }, async (baseUrl) => {
    const response = await request(
      baseUrl,
      '/api/bets?limit=25&cursor=page%2F2+%2B+next',
      authorized(),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, [{ bet_id: 'bet-1' }]);
    assert.deepEqual(upstream.calls.bets, [{ limit: 25, cursor: 'page/2 + next' }]);
  });
});

for (const limit of ['0', '101', '1.5', 'abc', '']) {
  test(`GET /api/bets rejects invalid limit ${JSON.stringify(limit)}`, async () => {
    const upstream = createFakeUpstream();
    await withServer({ upstream }, async (baseUrl) => {
      const response = await request(baseUrl, `/api/bets?limit=${limit}`, authorized());
      assert.equal(response.status, 400);
      assert.equal(response.body.error.code, 'INVALID_REQUEST');
      assert.equal(upstream.calls.bets.length, 0);
    });
  });
}

test('GET /api/bets defaults limit to 25 and rejects an oversized cursor', async () => {
  const upstream = createFakeUpstream();
  await withServer({ upstream }, async (baseUrl) => {
    const ok = await request(baseUrl, '/api/bets', authorized());
    const invalid = await request(baseUrl, `/api/bets?cursor=${'x'.repeat(513)}`, authorized());
    assert.equal(ok.status, 200);
    assert.deepEqual(upstream.calls.bets, [{ limit: 25, cursor: undefined }]);
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'INVALID_REQUEST');
  });
});

test('unknown GET routes return 404', async () => {
  await withServer({ upstream: createFakeUpstream() }, async (baseUrl) => {
    const response = await request(baseUrl, '/unknown', authorized());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'NOT_FOUND');
  });
});

test('non-GET methods return 405 without calling the upstream', async () => {
  const upstream = createFakeUpstream();
  await withServer({ upstream }, async (baseUrl) => {
    const response = await request(baseUrl, '/api/sports', authorized({ method: 'POST' }));
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET');
    assert.equal(upstream.calls.sports.length, 0);
  });
});

for (const [upstreamCode, status, publicCode] of [
  [CODES.BROWSER_UNAVAILABLE, 503, 'BROWSER_UNAVAILABLE'],
  [CODES.AUTH_EXPIRED, 502, 'UPSTREAM_AUTH_EXPIRED'],
  [CODES.TIMEOUT, 504, 'UPSTREAM_TIMEOUT'],
  [CODES.BAD_RESPONSE, 502, 'UPSTREAM_BAD_RESPONSE'],
  [CODES.SCHEMA_CHANGED, 502, 'UPSTREAM_SCHEMA_CHANGED'],
]) {
  test(`${upstreamCode} maps to HTTP ${status} without exposing the upstream message`, async () => {
    const secret = 'upstream-secret-that-must-not-escape';
    const upstream = {
      async getSports() { throw upstreamError(upstreamCode, secret); },
      async getBalance() { throw new Error('unused'); },
      async getBets() { throw new Error('unused'); },
    };
    await withServer({ upstream }, async (baseUrl) => {
      const response = await request(baseUrl, '/api/sports', authorized());
      assert.equal(response.status, status);
      assert.equal(response.body.error.code, publicCode);
      assert.equal(JSON.stringify(response.body).includes(secret), false);
    });
  });
}

test('unexpected upstream errors map to a sanitized 500 response', async () => {
  const upstream = {
    async getSports() { throw new Error('private implementation detail'); },
    async getBalance() { throw new Error('unused'); },
    async getBets() { throw new Error('unused'); },
  };
  await withServer({ upstream }, async (baseUrl) => {
    const response = await request(baseUrl, '/api/sports', authorized());
    assert.equal(response.status, 500);
    assert.equal(response.body.error.code, 'INTERNAL_ERROR');
    assert.equal(JSON.stringify(response.body).includes('private implementation detail'), false);
  });
});
