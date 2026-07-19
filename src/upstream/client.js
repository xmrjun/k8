'use strict';

const { normalizeSports, normalizeBalance, normalizeBets } = require('../normalize');
const { CODES, upstreamError } = require('./errors');

const JSON_CONTENT_TYPE = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/i;

function endpointUrl(baseUrl, endpoint, query) {
  const base = new URL(baseUrl);
  const url = new URL(endpoint, base);
  if (url.origin !== base.origin) {
    throw upstreamError(CODES.BAD_RESPONSE, 'Upstream endpoint must use the configured origin');
  }
  for (const [name, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(name, String(value));
    }
  }
  return url.toString();
}

async function readLimited(response, maximumBytes) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw upstreamError(CODES.BAD_RESPONSE, 'Upstream response is too large');
  }

  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw upstreamError(CODES.BAD_RESPONSE, 'Upstream response is too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function createUpstreamClient(configuration) {
  const {
    baseUrl,
    endpoints,
    credential,
    credentialHeaders,
    fetchImpl = globalThis.fetch,
    timeoutMs = 10_000,
    maxResponseBytes = 2 * 1024 * 1024,
  } = configuration;

  async function request(endpoint, query, normalize) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = endpointUrl(baseUrl, endpoint, query);
      let headers;
      try {
        headers = { Accept: 'application/json', ...credentialHeaders(credential) };
      } catch {
        throw upstreamError(CODES.BAD_RESPONSE, 'Upstream credential formatting failed');
      }

      let response;
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          headers,
          signal: controller.signal,
          redirect: 'manual',
        });
      } catch {
        if (controller.signal.aborted) {
          throw upstreamError(CODES.TIMEOUT, 'Upstream request timed out');
        }
        throw upstreamError(CODES.BAD_RESPONSE, 'Upstream request failed');
      }

      let status;
      let ok;
      let contentType;
      try {
        status = response.status;
        ok = response.ok;
        contentType = response.headers.get('content-type') || '';
      } catch {
        throw upstreamError(CODES.BAD_RESPONSE, 'Upstream returned an invalid response');
      }

      if (status === 401 || status === 403) {
        throw upstreamError(CODES.AUTH_EXPIRED, 'Upstream authentication expired');
      }
      if (!ok) {
        throw upstreamError(CODES.BAD_RESPONSE, 'Upstream returned an unsuccessful status');
      }
      if (!JSON_CONTENT_TYPE.test(contentType)) {
        throw upstreamError(CODES.BAD_RESPONSE, 'Upstream response is not JSON');
      }

      let text;
      try {
        text = await readLimited(response, maxResponseBytes);
      } catch {
        if (controller.signal.aborted) {
          throw upstreamError(CODES.TIMEOUT, 'Upstream request timed out');
        }
        throw upstreamError(CODES.BAD_RESPONSE, 'Upstream response could not be read');
      }
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw upstreamError(CODES.BAD_RESPONSE, 'Upstream returned malformed JSON');
      }

      try {
        return normalize(payload);
      } catch {
        throw upstreamError(CODES.SCHEMA_CHANGED, 'Upstream response schema changed');
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    getSports: () => request(endpoints.sports, undefined, normalizeSports),
    getBalance: () => request(endpoints.balance, undefined, normalizeBalance),
    getBets: ({ limit, cursor } = {}) => request(endpoints.bets, { limit, cursor }, normalizeBets),
  });
}

module.exports = { createUpstreamClient };
