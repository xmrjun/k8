'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const { createApp } = require('../src/app');
const { createFakeUpstream } = require('../src/upstream/fake');
const { upstreamError, CODES } = require('../src/upstream/errors');

const API_TOKEN = 'test-api-token-that-is-at-least-32-characters';

function realShapedSportsSnapshot({ decimalOdds = '1.98', available = true } = {}) {
  const selection = {
    selection_key: '900000001:full_time:1x2:home',
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
      event_id: '900000001',
      sport: 'football',
      scope: 'live',
      league: 'Premier League',
      home: 'Home FC',
      away: 'Away FC',
      score: { home: 1, away: 0 },
      clock: '55:20',
      markets: [{ period: 'full_time', type: '1x2', selections: [selection] }],
    }],
    count: 1,
    truncated: false,
  };
}

const DEFAULT_PLACEMENT = Object.freeze({
  enabled: true, dryRun: true, maxStake: 500, maxDailyStake: 5000,
});

function buildApp({ upstream, placement = DEFAULT_PLACEMENT, ...rest } = {}) {
  return createApp({
    apiToken: API_TOKEN,
    upstream: upstream || createFakeUpstream({ sports: realShapedSportsSnapshot() }),
    placement,
    now: () => new Date('2026-07-19T12:00:00.000Z'),
    requestId: () => 'request-test',
    draftId: () => 'draft-test-1',
    ...rest,
  });
}

function validInput(overrides = {}) {
  return {
    scope: 'live',
    sport: 'football',
    event_id: '900000001',
    selection_key: '900000001:full_time:1x2:home',
    stake: '10',
    expected_odds: '1.98',
    max_odds_drift: '0.05',
    idempotency_key: 'place-1',
    ...overrides,
  };
}

async function invoke(app, {
  method = 'POST', path = '/api/bets/place', headers = {}, body = '',
} = {}) {
  const requestStream = Readable.from([body]);
  requestStream.method = method;
  requestStream.url = path;
  requestStream.headers = headers;
  const response = {
    writeHead(status, responseHeaders) { this.status = status; this.headers = responseHeaders; },
    end(serialized) { this.serialized = serialized; },
  };
  await app(requestStream, response);
  return {
    status: response.status,
    headers: new Headers(response.headers),
    body: JSON.parse(response.serialized),
  };
}

function placeRequest(input = validInput(), headers = {}) {
  return {
    method: 'POST',
    path: '/api/bets/place',
    headers: {
      authorization: `Bearer ${API_TOKEN}`,
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    },
    body: JSON.stringify(input),
  };
}

test('POST /api/bets/place rejects unauthenticated requests', async () => {
  const app = buildApp();
  const response = await invoke(app, {
    ...placeRequest(),
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, 'UNAUTHORIZED');
});

test('POST /api/bets/place in dry-run returns would_place without submitting', async () => {
  const upstream = createFakeUpstream({ sports: realShapedSportsSnapshot() });
  const app = buildApp({ upstream });
  const response = await invoke(app, placeRequest());
  assert.equal(response.status, 200);
  assert.equal(response.body.data.status, 'would_place');
  assert.equal(response.body.data.dry_run, true);
  assert.equal(response.body.data.draft.draft_id, 'draft-test-1');
  assert.equal(upstream.calls.placeBet.length, 0);
});

test('POST /api/bets/place submits for real when dry-run is off', async () => {
  const upstream = createFakeUpstream({
    sports: realShapedSportsSnapshot(),
    placeBet: async () => ({ bet_id: 'bet-live-1' }),
  });
  const app = buildApp({
    upstream,
    placement: { ...DEFAULT_PLACEMENT, dryRun: false },
  });
  const response = await invoke(app, placeRequest());
  assert.equal(response.status, 200);
  assert.equal(response.body.data.status, 'placed');
  assert.deepEqual(response.body.data.receipt, { bet_id: 'bet-live-1' });
  assert.equal(upstream.calls.placeBet.length, 1);
});

test('POST /api/bets/place returns 503 when placement is disabled', async () => {
  const app = buildApp({ placement: { ...DEFAULT_PLACEMENT, enabled: false } });
  const response = await invoke(app, placeRequest());
  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, 'BET_PLACEMENT_DISABLED');
});

test('POST /api/bets/place returns 422 when the stake exceeds the single-bet cap', async () => {
  const app = buildApp();
  const response = await invoke(app, placeRequest(validInput({ stake: '501' })));
  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, 'STAKE_LIMIT_EXCEEDED');
});

test('POST /api/bets/place surfaces the not-wired upstream as 503 for a real bet', async () => {
  const upstream = createFakeUpstream({
    sports: realShapedSportsSnapshot(),
    placeBet: async () => {
      throw upstreamError(CODES.BROWSER_UNAVAILABLE, 'not wired');
    },
  });
  const app = buildApp({ upstream, placement: { ...DEFAULT_PLACEMENT, dryRun: false } });
  const response = await invoke(app, placeRequest());
  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, CODES.BROWSER_UNAVAILABLE);
});

test('POST /api/bets/place maps odds drift to 409', async () => {
  const app = buildApp();
  const response = await invoke(
    app,
    placeRequest(validInput({ expected_odds: '1.50', max_odds_drift: '0.01' })),
  );
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'ODDS_DRIFT_EXCEEDED');
});

test('GET /api/bets/place is 405 Method Not Allowed', async () => {
  const app = buildApp();
  const response = await invoke(app, { method: 'GET', path: '/api/bets/place', headers: {} });
  assert.equal(response.status, 405);
  assert.equal(response.body.error.code, 'METHOD_NOT_ALLOWED');
});

test('POST /api/bets/place is not exposed when the app has no placement config', async () => {
  const app = createApp({
    apiToken: API_TOKEN,
    upstream: createFakeUpstream({ sports: realShapedSportsSnapshot() }),
    now: () => new Date('2026-07-19T12:00:00.000Z'),
    requestId: () => 'request-test',
    draftId: () => 'draft-test-1',
  });
  const response = await invoke(app, placeRequest());
  // Falls through to the generic non-GET guard, like any unknown POST path.
  assert.equal(response.status, 405);
  assert.equal(response.body.error.code, 'METHOD_NOT_ALLOWED');
});

test('POST /api/bets/place rejects query parameters', async () => {
  const app = buildApp();
  const response = await invoke(app, {
    ...placeRequest(),
    path: '/api/bets/place?extra=1',
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'INVALID_REQUEST');
});

// A placement upstream (imsb_api or the DOM bet-slip) can fail after the draft
// is validated. The app maps those typed outcomes onto stable HTTP statuses,
// duck-typed by code so it stays independent of which upstream is wired.
const PLACEMENT_OUTCOME_CASES = [
  ['ODDS_DRIFT_EXCEEDED', 409],
  ['SELECTION_UNAVAILABLE', 409],
  ['PLACEMENT_REJECTED', 422],
  ['PLACEMENT_UNCONFIRMED', 502],
  ['PLACEMENT_FAILED', 502],
];

for (const [code, status] of PLACEMENT_OUTCOME_CASES) {
  test(`POST /api/bets/place maps a ${code} placement outcome to ${status}`, async () => {
    const upstream = createFakeUpstream({
      sports: realShapedSportsSnapshot(),
      placeBet: async () => {
        const error = new Error(code);
        error.name = 'ImsbPlacementError';
        error.code = code;
        throw error;
      },
    });
    const app = buildApp({ upstream, placement: { ...DEFAULT_PLACEMENT, dryRun: false } });
    const response = await invoke(app, placeRequest());
    assert.equal(response.status, status);
    assert.equal(response.body.error.code, code);
  });
}
