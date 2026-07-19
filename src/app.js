'use strict';

const { randomUUID } = require('node:crypto');

const { isAuthorized } = require('./auth');
const {
  sendError,
  success,
  unauthorized,
  methodNotAllowed,
  internalError,
} = require('./response');
const { CODES } = require('./upstream/errors');
const { SPORT_KEYS } = require('./browser/readers/sports');

const ACCOUNT_SOURCE = 'k81128';
const SPORTS_SOURCE = 'im-sports-browser';
const SPORTS_SCOPES = new Set(['all', 'live', 'today', 'early']);
const SPORTS = new Set(SPORT_KEYS);
const SPORTS_CACHE_TTL_MS = Object.freeze({
  all: 1000,
  live: 1000,
  today: 3000,
  early: 10000,
});
const MAX_SPORTS_CACHE_ENTRIES = 64;

function parseSportsQuery(searchParams) {
  for (const name of searchParams.keys()) {
    if (name !== 'scope' && name !== 'sport') return null;
  }
  if (searchParams.getAll('scope').length > 1
    || searchParams.getAll('sport').length > 1) {
    return null;
  }

  const scope = searchParams.has('scope') ? searchParams.get('scope') : 'all';
  if (!SPORTS_SCOPES.has(scope)) return null;

  const sport = searchParams.has('sport') ? searchParams.get('sport') : undefined;
  if (sport !== undefined && !SPORTS.has(sport)) return null;
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

function createApp({
  apiToken,
  upstream,
  now = () => new Date(),
  requestId = randomUUID,
}) {
  const sportsCache = new Map();

  return async function app(request, response) {
    const id = requestId();
    let url;
    try {
      url = new URL(request.url, 'http://localhost');
    } catch {
      sendError(response, 400, 'INVALID_REQUEST', 'Invalid request', id);
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

    const routes = new Set(['/api/sports', '/api/balance', '/api/bets']);
    if (!routes.has(url.pathname)) {
      sendError(response, 404, 'NOT_FOUND', 'Not found', id);
      return;
    }

    if (!isAuthorized(request.headers.authorization, apiToken)) {
      unauthorized(response, id);
      return;
    }

    try {
      if (url.pathname === '/api/sports') {
        const options = parseSportsQuery(url.searchParams);
        if (!options) {
          sendError(response, 400, 'INVALID_REQUEST', 'Invalid request', id);
          return;
        }
        const currentTime = now();
        const cacheKey = `${options.scope}:${options.sport || ''}`;
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
