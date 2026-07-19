const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createApp } = require('../src/app');
const { createFakeUpstream } = require('../src/upstream/fake');
const { upstreamError, CODES } = require('../src/upstream/errors');
const { SPORT_KEYS } = require('../src/browser/readers/sports');

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
  const upstream = createFakeUpstream({
    sports: {
      events: [{ event_id: 'event-1' }],
      count: 1,
      truncated: false,
    },
  });
  await withServer({ upstream }, async (baseUrl) => {
    const first = await request(baseUrl, '/api/sports', authorized());
    const second = await request(baseUrl, '/api/sports', authorized());
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, {
      data: {
        events: [{ event_id: 'event-1' }],
        count: 1,
        truncated: false,
      },
      source: 'im-sports-browser',
      fetched_at: '2026-07-19T12:00:00.000Z',
      request_id: 'request-test',
    });
    assert.deepEqual(second.body.data, first.body.data);
    assert.deepEqual(upstream.calls.sports, [{ scope: 'all', sport: undefined }]);
  });
});

test('GET /api/sports forwards each supported scope and an optional sport', async () => {
  const upstream = createFakeUpstream({
    sports: { events: [], count: 0, truncated: false },
  });
  await withServer({ upstream }, async (baseUrl) => {
    for (const path of [
      '/api/sports?scope=live&sport=football',
      '/api/sports?scope=today',
      '/api/sports?scope=early',
      '/api/sports?scope=all',
    ]) {
      assert.equal((await request(baseUrl, path, authorized())).status, 200);
    }
  });

  assert.deepEqual(upstream.calls.sports, [
    { scope: 'live', sport: 'football' },
    { scope: 'today', sport: undefined },
    { scope: 'early', sport: undefined },
    { scope: 'all', sport: undefined },
  ]);
});

for (const query of [
  'scope=',
  'scope=unknown',
  'scope=live&scope=today',
  'sport=',
  'sport=unknown-sport',
  'sport=football&sport=tennis',
  'scope=live&extra=value',
]) {
  test(`GET /api/sports rejects invalid query ${JSON.stringify(query)}`, async () => {
    const upstream = createFakeUpstream();
    await withServer({ upstream }, async (baseUrl) => {
      const response = await request(baseUrl, `/api/sports?${query}`, authorized());
      assert.equal(response.status, 400);
      assert.equal(response.body.error.code, 'INVALID_REQUEST');
      assert.equal(upstream.calls.sports.length, 0);
    });
  });
}

test('sports cache is keyed independently by scope and sport', async () => {
  const upstream = createFakeUpstream({
    sports: { events: [], count: 0, truncated: false },
  });
  await withServer({ upstream }, async (baseUrl) => {
    for (const path of [
      '/api/sports?scope=live&sport=football',
      '/api/sports?scope=live&sport=football',
      '/api/sports?scope=live&sport=tennis',
      '/api/sports?scope=today&sport=football',
    ]) {
      assert.equal((await request(baseUrl, path, authorized())).status, 200);
    }
  });

  assert.deepEqual(upstream.calls.sports, [
    { scope: 'live', sport: 'football' },
    { scope: 'live', sport: 'tennis' },
    { scope: 'today', sport: 'football' },
  ]);
});

test('sports cache evicts old query keys instead of growing without a bound', async () => {
  const upstream = createFakeUpstream({
    sports: { events: [], count: 0, truncated: false },
  });
  const queries = [];
  for (const scope of ['live', 'today', 'early', 'all']) {
    for (const sport of SPORT_KEYS) {
      queries.push(`/api/sports?scope=${scope}&sport=${sport}`);
    }
  }
  const first65 = queries.slice(0, 65);

  await withServer({ upstream }, async (baseUrl) => {
    for (const query of first65) {
      assert.equal((await request(baseUrl, query, authorized())).status, 200);
    }
    assert.equal((await request(baseUrl, first65[0], authorized())).status, 200);
  });

  assert.equal(upstream.calls.sports.length, 66);
});

for (const [scope, ttlMs] of [
  ['live', 1000],
  ['all', 1000],
  ['today', 3000],
  ['early', 10000],
]) {
  test(`${scope} sports cache expires after ${ttlMs}ms`, async () => {
    let milliseconds = Date.parse('2026-07-19T12:00:00.000Z');
    const upstream = createFakeUpstream({
      sports: { events: [], count: 0, truncated: false },
    });
    await withServer({
      upstream,
      now: () => new Date(milliseconds),
    }, async (baseUrl) => {
      const path = `/api/sports?scope=${scope}`;
      await request(baseUrl, path, authorized());
      milliseconds += ttlMs - 1;
      await request(baseUrl, path, authorized());
      milliseconds += 1;
      await request(baseUrl, path, authorized());
    });

    assert.equal(upstream.calls.sports.length, 2);
  });
}

test('expired sports data is never returned when the refresh fails', async () => {
  let milliseconds = Date.parse('2026-07-19T12:00:00.000Z');
  let calls = 0;
  const upstream = {
    async getSports() {
      calls += 1;
      if (calls > 1) throw upstreamError(CODES.BROWSER_UNAVAILABLE, 'page missing');
      return { events: [{ event_id: 'old' }], count: 1, truncated: false };
    },
    async getBalance() { return {}; },
    async getBets() { return []; },
  };
  await withServer({ upstream, now: () => new Date(milliseconds) }, async (baseUrl) => {
    const first = await request(baseUrl, '/api/sports?scope=live', authorized());
    milliseconds += 1000;
    const second = await request(baseUrl, '/api/sports?scope=live', authorized());

    assert.equal(first.status, 200);
    assert.equal(second.status, 503);
    assert.equal(second.body.error.code, CODES.BROWSER_UNAVAILABLE);
    assert.equal(JSON.stringify(second.body).includes('old'), false);
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
