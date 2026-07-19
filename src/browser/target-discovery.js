'use strict';

const { CODES, upstreamError } = require('../upstream/errors');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]']);

function cdpOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('CDP URL must use a loopback IP address');
  }
  if (parsed.protocol !== 'http:'
    || !LOOPBACK_HOSTS.has(parsed.hostname)
    || parsed.username
    || parsed.password) {
    throw new TypeError('CDP URL must use a loopback IP address');
  }
  return parsed;
}

function allowedPageOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('Page origin must be a valid https origin without path, query, or fragment');
  }
  if (parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash) {
    throw new TypeError('Page origin must be a valid https origin without path, query, or fragment');
  }
  return parsed.origin;
}

function allowedPagePathname(value = '/') {
  if (typeof value !== 'string' || !value.startsWith('/')
    || value.includes('?') || value.includes('#') || value.includes('\\')) {
    throw new TypeError('Page pathname must be an absolute path without query or fragment');
  }
  const parsed = new URL(value, 'https://path.invalid');
  if (parsed.origin !== 'https://path.invalid' || parsed.pathname !== value) {
    throw new TypeError('Page pathname must be an absolute path without query or fragment');
  }
  return value;
}

function sameDebuggerEndpoint(webSocketDebuggerUrl, cdp) {
  try {
    const parsed = new URL(webSocketDebuggerUrl);
    return parsed.protocol === 'ws:'
      && parsed.hostname === cdp.hostname
      && (parsed.port || '80') === (cdp.port || '80')
      && !parsed.username
      && !parsed.password;
  } catch {
    return false;
  }
}

function createTargetDiscovery({
  cdpUrl,
  pageOrigin,
  pagePathname = '/',
  fetchImpl = fetch,
  maxDiscoveryBytes = 1_000_000,
}) {
  const cdp = cdpOrigin(cdpUrl);
  const expectedPageOrigin = allowedPageOrigin(pageOrigin);
  const expectedPagePathname = allowedPagePathname(pagePathname);
  if (!Number.isInteger(maxDiscoveryBytes) || maxDiscoveryBytes <= 0) {
    throw new TypeError('maxDiscoveryBytes must be a positive integer');
  }

  async function discover({ signal } = {}) {
    let response;
    try {
      response = await fetchImpl(`${cdp.origin}/json/list`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal,
      });
    } catch {
      throw upstreamError(CODES.BROWSER_UNAVAILABLE, 'Could not discover browser pages');
    }
    if (!response?.ok) {
      throw upstreamError(CODES.BROWSER_UNAVAILABLE, 'Could not discover browser pages');
    }

    let body;
    try {
      body = await response.text();
    } catch {
      throw upstreamError(CODES.BROWSER_UNAVAILABLE, 'Could not read browser pages');
    }
    if (Buffer.byteLength(body) > maxDiscoveryBytes) {
      throw upstreamError(CODES.BAD_RESPONSE, 'Browser target list was too large');
    }

    let targets;
    try {
      targets = JSON.parse(body);
    } catch {
      throw upstreamError(CODES.BAD_RESPONSE, 'Browser target list was invalid');
    }
    if (!Array.isArray(targets)) {
      throw upstreamError(CODES.BAD_RESPONSE, 'Browser target list was invalid');
    }

    const match = targets.find((target) => {
      if (target?.type !== 'page'
        || typeof target.url !== 'string'
        || typeof target.webSocketDebuggerUrl !== 'string') {
        return false;
      }
      try {
        const page = new URL(target.url);
        return page.origin === expectedPageOrigin
          && page.pathname === expectedPagePathname
          && sameDebuggerEndpoint(target.webSocketDebuggerUrl, cdp);
      } catch {
        return false;
      }
    });
    if (!match) {
      throw upstreamError(CODES.BROWSER_UNAVAILABLE, 'No allowed browser page is available');
    }
    return match;
  }

  return Object.freeze({
    discover,
    cdpOrigin: cdp.origin,
    pageOrigin: expectedPageOrigin,
    pagePathname: expectedPagePathname,
  });
}

module.exports = { createTargetDiscovery };
