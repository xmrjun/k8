'use strict';

const { randomUUID } = require('node:crypto');

const { isAuthorized } = require('./auth');
const { DraftError, createBetDraftService } = require('./bet-drafts');
const { PlacementError, createBetPlacementService } = require('./bet-placement');
const { JsonBodyError, readJsonBody } = require('./json-body');
const {
  sendError,
  success,
  unauthorized,
  methodNotAllowed,
  internalError,
} = require('./response');
const { CODES } = require('./upstream/errors');
const {
  SELECTABLE_SCOPE_KEYS,
  SELECTABLE_SPORT_KEYS,
} = require('./browser/readers/sports-selection');

const ACCOUNT_SOURCE = 'k81128';
const SPORTS_SOURCE = 'im-sports-browser';
const SPORTS_SCOPES = new Set(SELECTABLE_SCOPE_KEYS);
const SPORTS = new Set(SELECTABLE_SPORT_KEYS);
const SPORTS_CACHE_TTL_MS = Object.freeze({
  live: 1000,
  today: 3000,
  early: 10000,
});
const MAX_SPORTS_CACHE_ENTRIES = SELECTABLE_SCOPE_KEYS.length
  * SELECTABLE_SPORT_KEYS.length;

function parseSportsQuery(searchParams) {
  for (const name of searchParams.keys()) {
    if (name !== 'scope' && name !== 'sport') return null;
  }
  if (searchParams.getAll('scope').length !== 1
    || searchParams.getAll('sport').length !== 1) {
    return null;
  }

  const scope = searchParams.get('scope');
  if (!SPORTS_SCOPES.has(scope)) return null;

  const sport = searchParams.get('sport');
  if (!SPORTS.has(sport)) return null;
  return { scope, sport };
}

function parseBetsQuery(searchParams) {
  if (searchParams.getAll('limit').length > 1 || searchParams.getAll('cursor').length > 1) {
    return null;
  }

  let limit = 25;
  if (searchParams.has('limit')) {
    const rawLimit = searchParams.get('limit');
    if (!/^\d+$/.test(rawLimit)) return null;
    limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return null;
  }

  const cursor = searchParams.has('cursor') ? searchParams.get('cursor') : undefined;
  if (cursor !== undefined && (cursor.length === 0 || cursor.length > 512)) return null;

  return { limit, cursor };
}

function sendUpstreamError(response, error, requestId) {
  const mappings = {
    [CODES.BROWSER_UNAVAILABLE]: [503, CODES.BROWSER_UNAVAILABLE, 'Browser is unavailable'],
    [CODES.AUTH_EXPIRED]: [502, CODES.AUTH_EXPIRED, 'Upstream authentication expired'],
    [CODES.TIMEOUT]: [504, CODES.TIMEOUT, 'Upstream request timed out'],
    [CODES.BAD_RESPONSE]: [502, CODES.BAD_RESPONSE, 'Upstream returned a bad response'],
    [CODES.SCHEMA_CHANGED]: [502, CODES.SCHEMA_CHANGED, 'Upstream response schema changed'],
  };
  const mapping = mappings[error?.code];
  if (!mapping) {
    internalError(response, requestId);
    return;
  }
  sendError(response, mapping[0], mapping[1], mapping[2], requestId);
}

function sendDraftRouteError(response, error, requestId, request) {
  if (error instanceof JsonBodyError) {
    const headers = error.closeConnection ? { connection: 'close' } : undefined;
    if (error.closeConnection) request.pause?.();
    if (error.code === 'UNSUPPORTED_MEDIA_TYPE'
      || error.code === 'UNSUPPORTED_CHARSET') {
      sendError(response, 415, error.code, 'Unsupported media type', requestId, headers);
      return;
    }
    if (error.code === 'PAYLOAD_TOO_LARGE') {
      sendError(response, 413, error.code, 'Payload too large', requestId, headers);
      return;
    }
    if (error.code !== 'INVALID_OPTIONS') {
      sendError(response, 400, 'INVALID_REQUEST', 'Invalid request', requestId, headers);
      return;
    }
  }
  if (error instanceof DraftError) {
    if (error.code === 'DRAFT_CAPACITY_EXCEEDED') {
      sendError(
        response,
        503,
        error.code,
        'Draft capacity is temporarily unavailable',
        requestId,
      );
      return;
    }
    if (error.code === 'INVALID_DRAFT_INPUT') {
      sendError(response, 400, 'INVALID_REQUEST', 'Invalid request', requestId);
      return;
    }
    if ([
      'IDEMPOTENCY_CONFLICT',
      'EVENT_UNAVAILABLE',
      'SELECTION_UNAVAILABLE',
      'ODDS_DRIFT_EXCEEDED',
    ].includes(error.code)) {
      sendError(response, 409, error.code, 'Draft conflict', requestId);
      return;
    }
    if (error.code === 'MALFORMED_CURRENT_SNAPSHOT') {
      sendError(
        response,
        502,
        error.code,
        'Upstream returned a malformed sports snapshot',
        requestId,
      );
      return;
    }
  }
  sendUpstreamError(response, error, requestId);
}

// Upstream placement-outcome codes, shared by every placement upstream (the
// JSON-API and the DOM bet-slip both raise these). Duck-typed by code so app
// stays independent of which upstream is wired. A drifted/withdrawn selection is
// a 409 conflict; a venue rejection is a 422; an unconfirmed or failed
// submission is a 502 (the wager's fate is uncertain — surface it, never 200).
const PLACEMENT_OUTCOME_STATUS = Object.freeze({
  ODDS_DRIFT_EXCEEDED: [409, 'Odds changed before placement'],
  SELECTION_UNAVAILABLE: [409, 'Selection is no longer available'],
  PLACEMENT_REJECTED: [422, 'The venue rejected the placement'],
  PLACEMENT_UNCONFIRMED: [502, 'Placement could not be confirmed'],
  PLACEMENT_FAILED: [502, 'Placement failed'],
});

function sendPlacementRouteError(response, error, requestId, request) {
  if (error instanceof PlacementError) {
    if (error.code === 'BET_PLACEMENT_DISABLED') {
      sendError(response, 503, error.code, 'Bet placement is disabled', requestId);
      return;
    }
    if (error.code === 'STAKE_LIMIT_EXCEEDED' || error.code === 'DAILY_LIMIT_EXCEEDED') {
      sendError(response, 422, error.code, 'Stake exceeds a configured limit', requestId);
      return;
    }
    internalError(response, requestId);
    return;
  }
  if (!(error instanceof DraftError)
    && !(error instanceof JsonBodyError)
    && Object.hasOwn(PLACEMENT_OUTCOME_STATUS, error?.code)) {
    const [status, message] = PLACEMENT_OUTCOME_STATUS[error.code];
    sendError(response, status, error.code, message, requestId);
    return;
  }
  // JsonBodyError and DraftError share the same taxonomy as the drafts route.
  sendDraftRouteError(response, error, requestId, request);
}

function createApp({
  apiToken,
  upstream,
  placement,
  now = () => new Date(),
  requestId = randomUUID,
  draftId = randomUUID,
}) {
  const sportsCache = new Map();
  const draftService = createBetDraftService({
    upstream,
    now: () => {
      try {
        const milliseconds = Date.prototype.getTime.call(now());
        return Number.isSafeInteger(milliseconds) && milliseconds >= 0
          ? milliseconds
          : Number.NaN;
      } catch {
        return Number.NaN;
      }
    },
    idGenerator: draftId,
  });

  // Placement is opt-in: only build the service when the host wires a config.
  // Without it, POST /api/bets/place stays a 404 (the endpoint does not exist).
  const placementService = placement
    ? createBetPlacementService({
      draftService,
      placeBet: (draft) => upstream.placeBet(draft),
      enabled: placement.enabled,
      dryRun: placement.dryRun,
      maxStake: placement.maxStake,
      maxDailyStake: placement.maxDailyStake,
      now,
    })
    : null;

  return async function app(request, response) {
    const id = requestId();
    let url;
    try {
      url = new URL(request.url, 'http://localhost');
    } catch {
      sendError(response, 400, 'INVALID_REQUEST', 'Invalid request', id);
      return;
    }

    if (url.pathname === '/api/bets/drafts' && request.method === 'POST') {
      if (!isAuthorized(request.headers.authorization, apiToken)) {
        request.pause?.();
        unauthorized(response, id, { connection: 'close' });
        return;
      }
      try {
        if (Array.from(url.searchParams.keys()).length > 0) {
          request.pause?.();
          sendError(
            response,
            400,
            'INVALID_REQUEST',
            'Invalid request',
            id,
            { connection: 'close' },
          );
          return;
        }
        const input = await readJsonBody(request, { maxBytes: 8192 });
        const data = await draftService.create(input);
        success(response, {
          data,
          source: SPORTS_SOURCE,
          fetchedAt: data.created_at,
          requestId: id,
        });
      } catch (error) {
        sendDraftRouteError(response, error, id, request);
      }
      return;
    }

    if (url.pathname === '/api/bets/drafts') {
      methodNotAllowed(response, id, ['POST']);
      return;
    }

    if (placementService && url.pathname === '/api/bets/place'
      && request.method === 'POST') {
      if (!isAuthorized(request.headers.authorization, apiToken)) {
        request.pause?.();
        unauthorized(response, id, { connection: 'close' });
        return;
      }
      try {
        if (Array.from(url.searchParams.keys()).length > 0) {
          request.pause?.();
          sendError(
            response,
            400,
            'INVALID_REQUEST',
            'Invalid request',
            id,
            { connection: 'close' },
          );
          return;
        }
        const input = await readJsonBody(request, { maxBytes: 8192 });
        const data = await placementService.place(input);
        success(response, {
          data,
          source: SPORTS_SOURCE,
          fetchedAt: data.draft.created_at,
          requestId: id,
        });
      } catch (error) {
        sendPlacementRouteError(response, error, id, request);
      }
      return;
    }

    if (placementService && url.pathname === '/api/bets/place') {
      methodNotAllowed(response, id, ['POST']);
      return;
    }

    if (request.method !== 'GET') {
      methodNotAllowed(response, id);
      return;
    }

    if (url.pathname === '/health') {
      const fetchedAt = now().toISOString();
      success(response, {
        data: { status: 'ok' },
        source: 'k8-api',
        fetchedAt,
        requestId: id,
      });
      return;
    }

    const routes = new Set([
      '/api/sports',
      '/api/sports/account',
      '/api/sports/catalog',
      '/api/sports/boosts',
      '/api/balance',
      '/api/bets',
    ]);
    if (!routes.has(url.pathname)) {
      sendError(response, 404, 'NOT_FOUND', 'Not found', id);
      return;
    }

    if (!isAuthorized(request.headers.authorization, apiToken)) {
      unauthorized(response, id);
      return;
    }

    try {
      if (url.pathname === '/api/sports/catalog'
        || url.pathname === '/api/sports/boosts') {
        if (Array.from(url.searchParams.keys()).length > 0) {
          sendError(response, 400, 'INVALID_REQUEST', 'Invalid request', id);
          return;
        }
        const data = url.pathname === '/api/sports/catalog'
          ? await upstream.getSportsCatalog()
          : await upstream.getSportsBoosts();
        success(response, {
          data,
          source: SPORTS_SOURCE,
          fetchedAt: now().toISOString(),
          requestId: id,
        });
        return;
      }

      if (url.pathname === '/api/sports/account') {
        if (Array.from(url.searchParams.keys()).length > 0) {
          sendError(response, 400, 'INVALID_REQUEST', 'Invalid request', id);
          return;
        }
        const data = await upstream.getSportsAccount();
        success(response, {
          data,
          source: SPORTS_SOURCE,
          fetchedAt: now().toISOString(),
          requestId: id,
        });
        return;
      }

      if (url.pathname === '/api/sports') {
        const options = parseSportsQuery(url.searchParams);
        if (!options) {
          sendError(response, 400, 'INVALID_REQUEST', 'Invalid request', id);
          return;
        }
        const currentTime = now();
        const cacheKey = `${options.scope}:${options.sport}`;
        let cached = sportsCache.get(cacheKey);
        if (!cached || currentTime.getTime() >= cached.expiresAt) {
          const data = await upstream.getSports(options);
          cached = {
            data,
            fetchedAt: currentTime.toISOString(),
            expiresAt: currentTime.getTime() + SPORTS_CACHE_TTL_MS[options.scope],
          };
          if (!sportsCache.has(cacheKey)
            && sportsCache.size >= MAX_SPORTS_CACHE_ENTRIES) {
            sportsCache.delete(sportsCache.keys().next().value);
          }
          sportsCache.set(cacheKey, cached);
        }
        success(response, {
          data: cached.data,
          source: SPORTS_SOURCE,
          fetchedAt: cached.fetchedAt,
          requestId: id,
        });
        return;
      }

      if (url.pathname === '/api/balance') {
        const data = await upstream.getBalance();
        success(response, {
          data,
          source: ACCOUNT_SOURCE,
          fetchedAt: now().toISOString(),
          requestId: id,
        });
        return;
      }

      const options = parseBetsQuery(url.searchParams);
      if (!options) {
        sendError(response, 400, 'INVALID_REQUEST', 'Invalid request', id);
        return;
      }
      const data = await upstream.getBets(options);
      success(response, {
        data,
        source: ACCOUNT_SOURCE,
        fetchedAt: now().toISOString(),
        requestId: id,
      });
    } catch (error) {
      sendUpstreamError(response, error, id);
    }
  };
}

module.exports = { createApp };
