const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Readable } = require('node:stream');

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

async function invokeApp(app, {
  method = 'GET',
  path = '/',
  headers = {},
  body = [],
} = {}) {
  const requestStream = body instanceof Readable
    ? body
    : Readable.from(Array.isArray(body) ? body : [body]);
  requestStream.method = method;
  requestStream.url = path;
  requestStream.headers = headers;
  const response = {
    writeHead(status, responseHeaders) {
      this.status = status;
      this.headers = responseHeaders;
    },
    end(serialized) {
      this.serialized = serialized;
    },
  };

  await app(requestStream, response);
  return {
    status: response.status,
    headers: new Headers(response.headers),
    body: JSON.parse(response.serialized),
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

function validDraftInput(overrides = {}) {
  return {
    scope: 'live',
    sport: 'football',
    event_id: '900000001',
    selection_key: '900000001:full_time:1x2:home',
    stake: '10.00',
    expected_odds: '1.9500',
    max_odds_drift: '0.05',
    idempotency_key: 'client-request-1',
    ...overrides,
  };
}

function realShapedSportsSnapshot({
  eventId = '900000001',
  decimalOdds = '1.98',
  available = true,
} = {}) {
  const selection = {
    selection_key: `${eventId}:full_time:1x2:home`,
    name: 'home',
    odds_format: 'hong_kong',
    available,
  };
  if (available) {
    selection.display_odds = String(Number(decimalOdds) - 1);
    selection.decimal_odds = decimalOdds;
  }
  return {
    events: [{
      event_id: eventId,
      sport: 'football',
      scope: 'live',
      league: 'Premier League',
      home: 'Home FC',
      away: 'Away FC',
      score: { home: 1, away: 0 },
      clock: '55:20',
      markets: [{
        period: 'full_time',
        type: '1x2',
        selections: [selection],
      }],
    }],
    count: 1,
    truncated: false,
  };
}

function draftRequest(input = validDraftInput(), options = {}) {
  return authorized({
    method: 'POST',
    body: JSON.stringify(input),
    ...options,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...options.headers,
    },
  });
}

async function invokeDraft(app, input = validDraftInput(), options = {}) {
  const requestOptions = draftRequest(input, options);
  return invokeApp(app, {
    method: requestOptions.method,
    path: options.path || '/api/bets/drafts',
    headers: requestOptions.headers,
    body: requestOptions.body,
  });
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

test('POST /api/bets/drafts returns a local manual-confirmation draft envelope', async () => {
  const upstream = createFakeUpstream({ sports: realShapedSportsSnapshot() });
  const app = createApp({
    apiToken: API_TOKEN,
    upstream,
    now: () => new Date('2026-07-19T12:00:00.000Z'),
    requestId: () => 'request-test',
    draftId: () => 'draft-http-1',
  });
  const options = draftRequest();
  const response = await invokeApp(app, {
    method: options.method,
    path: '/api/bets/drafts',
    headers: options.headers,
    body: options.body,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    data: {
      state: 'ready_for_manual_confirmation',
      scope: 'live',
      sport: 'football',
      event_id: '900000001',
      selection_key: '900000001:full_time:1x2:home',
      stake: '10',
      expected_odds: '1.95',
      current_odds: '1.98',
      max_odds_drift: '0.05',
      odds_changed: true,
      projected_gross_return: '19.80',
      created_at: '2026-07-19T12:00:00.000Z',
      expires_at: '2026-07-19T12:02:00.000Z',
      draft_id: 'draft-http-1',
    },
    source: 'im-sports-browser',
    fetched_at: '2026-07-19T12:00:00.000Z',
    request_id: 'request-test',
  });
  assert.deepEqual(upstream.calls.sports, [{ scope: 'live', sport: 'football' }]);
});

test('POST /api/bets/drafts succeeds over a real HTTP server', async () => {
  const upstream = createFakeUpstream({ sports: realShapedSportsSnapshot() });
  await withServer({
    upstream,
    draftId: () => 'draft-integration-1',
  }, async (baseUrl) => {
    const response = await request(baseUrl, '/api/bets/drafts', draftRequest());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.draft_id, 'draft-integration-1');
    assert.equal(response.body.data.state, 'ready_for_manual_confirmation');
    assert.equal(response.body.fetched_at, response.body.data.created_at);
  });
  assert.equal(upstream.calls.sports.length, 1);
});

test('POST /api/bets/drafts authenticates before validating or reading the body', async () => {
  let reads = 0;
  const body = new Readable({
    read() {
      reads += 1;
      this.push('{malformed-private-body');
      this.push(null);
    },
  });
  const upstream = createFakeUpstream({ sports: realShapedSportsSnapshot() });
  const app = createApp({ apiToken: API_TOKEN, upstream });

  const response = await invokeApp(app, {
    method: 'POST',
    path: '/api/bets/drafts?private=query',
    headers: { 'content-type': 'text/plain' },
    body,
  });

  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, 'UNAUTHORIZED');
  assert.equal(reads, 0);
  assert.equal(upstream.calls.sports.length, 0);
});

test('POST /api/bets/drafts rejects query parameters without reading or calling upstream', async () => {
  let reads = 0;
  const body = new Readable({
    read() {
      reads += 1;
      this.push(JSON.stringify(validDraftInput()));
      this.push(null);
    },
  });
  const upstream = createFakeUpstream({ sports: realShapedSportsSnapshot() });
  const app = createApp({ apiToken: API_TOKEN, upstream });

  const response = await invokeApp(app, {
    method: 'POST',
    path: '/api/bets/drafts?extra=value',
    headers: {
      authorization: `Bearer ${API_TOKEN}`,
      'content-type': 'application/json',
    },
    body,
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'INVALID_REQUEST');
  assert.equal(reads, 0);
  assert.equal(upstream.calls.sports.length, 0);
});

for (const [name, headers, body, status, code] of [
  ['missing content type', {}, '{}', 415, 'UNSUPPORTED_MEDIA_TYPE'],
  ['unsupported charset', { 'content-type': 'application/json; charset=utf-16' }, '{}', 415, 'UNSUPPORTED_CHARSET'],
  ['invalid content length', { 'content-type': 'application/json', 'content-length': '-1' }, '{}', 400, 'INVALID_REQUEST'],
  ['oversized declared body', { 'content-type': 'application/json', 'content-length': '8193' }, '{}', 413, 'PAYLOAD_TOO_LARGE'],
  ['oversized streamed body', { 'content-type': 'application/json' }, ' '.repeat(8193), 413, 'PAYLOAD_TOO_LARGE'],
  ['empty body', { 'content-type': 'application/json' }, '', 400, 'INVALID_REQUEST'],
  ['malformed JSON', { 'content-type': 'application/json' }, '{"private":"detail"', 400, 'INVALID_REQUEST'],
]) {
  test(`POST /api/bets/drafts maps ${name} to sanitized HTTP ${status}`, async () => {
    const upstream = createFakeUpstream({ sports: realShapedSportsSnapshot() });
    const app = createApp({ apiToken: API_TOKEN, upstream });
    const response = await invokeApp(app, {
      method: 'POST',
      path: '/api/bets/drafts',
      headers: {
        authorization: `Bearer ${API_TOKEN}`,
        ...headers,
      },
      body,
    });

    assert.equal(response.status, status);
    assert.equal(response.body.error.code, code);
    assert.equal(JSON.stringify(response.body).includes('private'), false);
    assert.equal(upstream.calls.sports.length, 0);
  });
}

test('POST /api/bets/drafts rejects invalid draft input before calling upstream', async () => {
  const upstream = createFakeUpstream({ sports: realShapedSportsSnapshot() });
  const app = createApp({ apiToken: API_TOKEN, upstream });

  const response = await invokeDraft(app, validDraftInput({ stake: 'private-invalid' }));

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'INVALID_REQUEST');
  assert.equal(JSON.stringify(response.body).includes('private-invalid'), false);
  assert.equal(upstream.calls.sports.length, 0);
});

for (const [name, sports, input, code] of [
  ['unavailable event', { events: [], count: 0, truncated: false }, validDraftInput(), 'EVENT_UNAVAILABLE'],
  ['unavailable selection', realShapedSportsSnapshot({ available: false }), validDraftInput(), 'SELECTION_UNAVAILABLE'],
  ['excessive odds drift', realShapedSportsSnapshot({ decimalOdds: '2.10' }), validDraftInput(), 'ODDS_DRIFT_EXCEEDED'],
]) {
  test(`POST /api/bets/drafts maps ${name} to a sanitized conflict`, async () => {
    const upstream = createFakeUpstream({ sports });
    const app = createApp({ apiToken: API_TOKEN, upstream });

    const response = await invokeDraft(app, input);

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, code);
    assert.equal(JSON.stringify(response.body).includes('private'), false);
    assert.equal(upstream.calls.sports.length, 1);
  });
}

test('POST /api/bets/drafts maps a malformed current snapshot to sanitized 502', async () => {
  const upstream = createFakeUpstream({
    sports: { events: [], count: 0, truncated: false, private_detail: 'secret' },
  });
  const app = createApp({ apiToken: API_TOKEN, upstream });

  const response = await invokeDraft(app);

  assert.equal(response.status, 502);
  assert.equal(response.body.error.code, 'MALFORMED_CURRENT_SNAPSHOT');
  assert.equal(JSON.stringify(response.body).includes('secret'), false);
});

test('POST /api/bets/drafts maps invalid service state to sanitized 500', async () => {
  const upstream = createFakeUpstream({ sports: realShapedSportsSnapshot() });
  const app = createApp({
    apiToken: API_TOKEN,
    upstream,
    now: () => new Date('2026-07-19T12:00:00.000Z'),
    draftId: () => '',
  });

  const response = await invokeDraft(app);

  assert.equal(response.status, 500);
  assert.equal(response.body.error.code, 'INTERNAL_ERROR');
});

test('POST /api/bets/drafts replays one local draft without a second sports read', async () => {
  let generated = 0;
  const upstream = createFakeUpstream({ sports: realShapedSportsSnapshot() });
  const app = createApp({
    apiToken: API_TOKEN,
    upstream,
    now: () => new Date('2026-07-19T12:00:00.000Z'),
    draftId: () => `draft-replay-${++generated}`,
  });

  const first = await invokeDraft(app);
  const second = await invokeDraft(app);

  assert.equal(first.status, 200);
  assert.deepEqual(second.body.data, first.body.data);
  assert.equal(generated, 1);
  assert.equal(upstream.calls.sports.length, 1);
});

test('idempotent replay keeps fetched_at at the original draft verification time', async () => {
  let milliseconds = Date.parse('2026-07-19T12:00:00.000Z');
  const upstream = createFakeUpstream({ sports: realShapedSportsSnapshot() });
  const app = createApp({
    apiToken: API_TOKEN,
    upstream,
    now: () => new Date(milliseconds),
    draftId: () => 'draft-stable-time',
  });

  const first = await invokeDraft(app);
  milliseconds += 30_000;
  const replay = await invokeDraft(app);

  assert.equal(first.body.fetched_at, first.body.data.created_at);
  assert.equal(replay.body.fetched_at, first.body.data.created_at);
  assert.deepEqual(replay.body.data, first.body.data);
  assert.equal(upstream.calls.sports.length, 1);
});

test('POST /api/bets/drafts rejects idempotency conflicts before a second sports read', async () => {
  const upstream = createFakeUpstream({ sports: realShapedSportsSnapshot() });
  const app = createApp({
    apiToken: API_TOKEN,
    upstream,
    now: () => new Date('2026-07-19T12:00:00.000Z'),
  });

  assert.equal((await invokeDraft(app)).status, 200);
  const conflict = await invokeDraft(app, validDraftInput({ stake: '11.00' }));

  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(upstream.calls.sports.length, 1);
});

test('POST /api/bets/drafts bypasses the HTTP sports cache for a fresh snapshot', async () => {
  const snapshots = [
    realShapedSportsSnapshot({ decimalOdds: '1.95' }),
    realShapedSportsSnapshot({ decimalOdds: '1.98' }),
  ];
  const calls = [];
  const upstream = {
    async getSports(options) {
      calls.push(options);
      return snapshots.shift();
    },
  };
  const app = createApp({
    apiToken: API_TOKEN,
    upstream,
    now: () => new Date('2026-07-19T12:00:00.000Z'),
  });
  const authorization = { authorization: `Bearer ${API_TOKEN}` };

  const cachedRead = await invokeApp(app, {
    path: '/api/sports?scope=live&sport=football',
    headers: authorization,
  });
  const draft = await invokeDraft(app);

  assert.equal(cachedRead.body.data.events[0].markets[0].selections[0].decimal_odds, '1.95');
  assert.equal(draft.body.data.current_odds, '1.98');
  assert.deepEqual(calls, [
    { scope: 'live', sport: 'football' },
    { scope: 'live', sport: 'football' },
  ]);
});

for (const [upstreamCode, status] of [
  [CODES.BROWSER_UNAVAILABLE, 503],
  [CODES.AUTH_EXPIRED, 502],
  [CODES.TIMEOUT, 504],
  [CODES.BAD_RESPONSE, 502],
  [CODES.SCHEMA_CHANGED, 502],
]) {
  test(`POST /api/bets/drafts preserves ${upstreamCode} mapping`, async () => {
    const upstream = {
      async getSports() {
        throw upstreamError(upstreamCode, 'private-upstream-detail');
      },
    };
    const app = createApp({ apiToken: API_TOKEN, upstream });

    const response = await invokeDraft(app);

    assert.equal(response.status, status);
    assert.equal(response.body.error.code, upstreamCode);
    assert.equal(JSON.stringify(response.body).includes('private-upstream-detail'), false);
  });
}

test('unsupported /api/bets/drafts methods advertise only POST', async () => {
  const app = createApp({ apiToken: API_TOKEN, upstream: createFakeUpstream() });

  for (const method of ['GET', 'DELETE']) {
    const response = await invokeApp(app, { method, path: '/api/bets/drafts' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
  }
});

test('other non-GET routes still advertise only GET', async () => {
  const app = createApp({ apiToken: API_TOKEN, upstream: createFakeUpstream() });

  const response = await invokeApp(app, {
    method: 'POST',
    path: '/api/sports',
  });

  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET');
});

for (const action of ['submit', 'confirm', 'cancel', 'settle', 'cashout']) {
  test(`does not expose a ${action} draft route`, async () => {
    const app = createApp({ apiToken: API_TOKEN, upstream: createFakeUpstream() });
    const path = `/api/bets/drafts/${action}`;

    const getResponse = await invokeApp(app, { path });
    const postResponse = await invokeApp(app, { method: 'POST', path });

    assert.equal(getResponse.status, 404);
    assert.equal(postResponse.status, 405);
    assert.equal(postResponse.headers.get('allow'), 'GET');
  });
}

test('protected API routes reject a missing bearer token', async () => {
  await withServer({ upstream: createFakeUpstream() }, async (baseUrl) => {
    for (const path of [
      '/api/sports',
      '/api/sports/account',
      '/api/sports/catalog',
      '/api/sports/boosts',
    ]) {
      const response = await request(baseUrl, path);
      assert.equal(response.status, 401);
      assert.equal(response.body.error.code, 'UNAUTHORIZED');
      assert.equal(response.headers.get('www-authenticate'), 'Bearer realm="k8-api"');
    }
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
    const path = '/api/sports?scope=live&sport=football';
    const first = await request(baseUrl, path, authorized());
    const second = await request(baseUrl, path, authorized());
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
    assert.deepEqual(upstream.calls.sports, [{ scope: 'live', sport: 'football' }]);
  });
});

test('GET /api/sports forwards every supported scope and sport combination', async () => {
  const upstream = createFakeUpstream({
    sports: { events: [], count: 0, truncated: false },
  });
  const expected = [];
  await withServer({ upstream }, async (baseUrl) => {
    for (const scope of ['live', 'today', 'early']) {
      for (const sport of ['football', 'basketball', 'tennis']) {
        const path = `/api/sports?scope=${scope}&sport=${sport}`;
        assert.equal((await request(baseUrl, path, authorized())).status, 200);
        expected.push({ scope, sport });
      }
    }
  });

  assert.deepEqual(upstream.calls.sports, expected);
});

test('GET /api/sports/account returns an uncached stable account envelope', async () => {
  const upstream = createFakeUpstream({
    sportsAccount: {
      currency: 'USD',
      available_balance: 12.5,
      unsettled_amount: 1234,
    },
  });
  await withServer({ upstream }, async (baseUrl) => {
    const first = await request(baseUrl, '/api/sports/account', authorized());
    const second = await request(baseUrl, '/api/sports/account', authorized());

    assert.equal(first.status, 200);
    assert.deepEqual(first.body, {
      data: {
        currency: 'USD',
        available_balance: 12.5,
        unsettled_amount: 1234,
      },
      source: 'im-sports-browser',
      fetched_at: '2026-07-19T12:00:00.000Z',
      request_id: 'request-test',
    });
    assert.equal(second.status, 200);
  });
  assert.equal(upstream.calls.sportsAccount.length, 2);
});

test('GET /api/sports/account rejects query parameters', async () => {
  const upstream = createFakeUpstream();
  await withServer({ upstream }, async (baseUrl) => {
    const response = await request(
      baseUrl,
      '/api/sports/account?extra=value',
      authorized(),
    );
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'INVALID_REQUEST');
  });
  assert.equal(upstream.calls.sportsAccount.length, 0);
});

test('GET /api/sports/account preserves sanitized upstream error mapping', async () => {
  const secret = 'private-account-page-detail';
  const upstream = createFakeUpstream();
  upstream.getSportsAccount = async () => {
    throw upstreamError(CODES.AUTH_EXPIRED, secret);
  };
  await withServer({ upstream }, async (baseUrl) => {
    const response = await request(baseUrl, '/api/sports/account', authorized());
    assert.equal(response.status, 502);
    assert.equal(response.body.error.code, CODES.AUTH_EXPIRED);
    assert.equal(JSON.stringify(response.body).includes(secret), false);
  });
});

test('GET /api/sports/catalog returns the uncached visible navigation catalog', async () => {
  const catalog = {
    scopes: ['live', 'today', 'early'],
    tabs: ['today', 'early', 'parlay'],
    live_sports: [],
    all_sports: [],
    popular_tournaments: [],
    odds_boost_sports: [],
  };
  const upstream = createFakeUpstream({ sportsCatalog: catalog });
  await withServer({ upstream }, async (baseUrl) => {
    const first = await request(baseUrl, '/api/sports/catalog', authorized());
    const second = await request(baseUrl, '/api/sports/catalog', authorized());
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.data, catalog);
    assert.equal(second.status, 200);
  });
  assert.equal(upstream.calls.sportsCatalog.length, 2);
});

test('GET /api/sports/boosts returns uncached visible read-only offers', async () => {
  const boosts = { offers: [], count: 0, truncated: false };
  const upstream = createFakeUpstream({ sportsBoosts: boosts });
  await withServer({ upstream }, async (baseUrl) => {
    const response = await request(baseUrl, '/api/sports/boosts', authorized());
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, boosts);
  });
  assert.equal(upstream.calls.sportsBoosts.length, 1);
});

for (const path of [
  '/api/sports/catalog?extra=value',
  '/api/sports/boosts?scope=live',
]) {
  test(`GET ${path} rejects query parameters`, async () => {
    const upstream = createFakeUpstream();
    await withServer({ upstream }, async (baseUrl) => {
      const response = await request(baseUrl, path, authorized());
      assert.equal(response.status, 400);
      assert.equal(response.body.error.code, 'INVALID_REQUEST');
    });
    assert.equal(upstream.calls.sportsCatalog.length, 0);
    assert.equal(upstream.calls.sportsBoosts.length, 0);
  });
}

for (const query of [
  '',
  'scope=',
  'scope=unknown',
  'scope=all&sport=football',
  'scope=live',
  'scope=live&scope=today',
  'sport=',
  'sport=football',
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

test('sports cache keeps all nine supported query keys separate', async () => {
  const upstream = createFakeUpstream({
    sports: { events: [], count: 0, truncated: false },
  });
  const queries = [];
  for (const scope of ['live', 'today', 'early']) {
    for (const sport of ['football', 'basketball', 'tennis']) {
      queries.push(`/api/sports?scope=${scope}&sport=${sport}`);
    }
  }

  await withServer({ upstream }, async (baseUrl) => {
    for (const query of queries) {
      assert.equal((await request(baseUrl, query, authorized())).status, 200);
    }
    assert.equal((await request(baseUrl, queries[0], authorized())).status, 200);
  });

  assert.equal(upstream.calls.sports.length, 9);
});

for (const [scope, ttlMs] of [
  ['live', 1000],
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
      const path = `/api/sports?scope=${scope}&sport=football`;
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
    const path = '/api/sports?scope=live&sport=football';
    const first = await request(baseUrl, path, authorized());
    milliseconds += 1000;
    const second = await request(baseUrl, path, authorized());

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
      const response = await request(
        baseUrl,
        '/api/sports?scope=live&sport=football',
        authorized(),
      );
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
    const response = await request(
      baseUrl,
      '/api/sports?scope=live&sport=football',
      authorized(),
    );
    assert.equal(response.status, 500);
    assert.equal(response.body.error.code, 'INTERNAL_ERROR');
    assert.equal(JSON.stringify(response.body).includes('private implementation detail'), false);
  });
});
