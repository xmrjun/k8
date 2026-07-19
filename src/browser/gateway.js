'use strict';

const { createCdpClient } = require('./cdp-client');
const { CODES, UpstreamError, upstreamError } = require('../upstream/errors');

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
    throw new TypeError('Page origin must be a valid https URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new TypeError('Page origin must be a valid https URL');
  }
  return parsed.origin;
}

function sameDebuggerEndpoint(webSocketDebuggerUrl, cdp) {
  try {
    const parsed = new URL(webSocketDebuggerUrl);
    const cdpPort = cdp.port || '80';
    const debuggerPort = parsed.port || '80';
    return parsed.protocol === 'ws:'
      && parsed.hostname === cdp.hostname
      && debuggerPort === cdpPort
      && !parsed.username
      && !parsed.password;
  } catch {
    return false;
  }
}

function trustedError(error, fallbackCode, fallbackMessage) {
  if (error instanceof UpstreamError && Object.values(CODES).includes(error.code)) {
    return error;
  }
  return upstreamError(fallbackCode, fallbackMessage);
}

function createBrowserGateway({
  cdpUrl,
  pageOrigin,
  fetchImpl = fetch,
  webSocketFactory,
  maxResponseBytes = 1_000_000,
  maxDiscoveryBytes = 1_000_000,
}) {
  const cdp = cdpOrigin(cdpUrl);
  const expectedPageOrigin = allowedPageOrigin(pageOrigin);
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new TypeError('maxResponseBytes must be a positive integer');
  }
  if (!Number.isInteger(maxDiscoveryBytes) || maxDiscoveryBytes <= 0) {
    throw new TypeError('maxDiscoveryBytes must be a positive integer');
  }

  let client;

  async function discoverTarget(signal) {
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
      let targetOrigin;
      try {
        targetOrigin = new URL(target.url).origin;
      } catch {
        return false;
      }
      return targetOrigin === expectedPageOrigin
        && sameDebuggerEndpoint(target.webSocketDebuggerUrl, cdp);
    });

    if (!match) {
      throw upstreamError(CODES.BROWSER_UNAVAILABLE, 'No allowed browser page is available');
    }
    return match;
  }

  async function connectedClient(signal) {
    if (client && !client.closed) return client;
    const target = await discoverTarget(signal);
    try {
      client = createCdpClient({
        webSocketUrl: target.webSocketDebuggerUrl,
        webSocketFactory,
        maxMessageBytes: Math.max(maxResponseBytes + 65536, 65536),
      });
      return client;
    } catch (error) {
      throw trustedError(
        error,
        CODES.BROWSER_UNAVAILABLE,
        'Could not connect to browser page',
      );
    }
  }

  async function evaluate(expression, { signal } = {}) {
    if (typeof expression !== 'string' || expression.length === 0) {
      throw new TypeError('expression must be a non-empty string');
    }

    let response;
    try {
      const currentClient = await connectedClient(signal);
      response = await currentClient.call('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      }, { signal });
    } catch (error) {
      throw trustedError(error, CODES.BROWSER_UNAVAILABLE, 'Browser evaluation failed');
    }

    if (response?.exceptionDetails || !response?.result
      || !Object.hasOwn(response.result, 'value')) {
      throw upstreamError(CODES.BAD_RESPONSE, 'Browser evaluation returned a bad response');
    }
    const value = response.result.value;
    let serialized;
    try {
      serialized = JSON.stringify(value);
    } catch {
      throw upstreamError(CODES.BAD_RESPONSE, 'Browser evaluation was not serializable');
    }
    if (serialized === undefined || Buffer.byteLength(serialized) > maxResponseBytes) {
      throw upstreamError(CODES.BAD_RESPONSE, 'Browser evaluation response was too large');
    }
    return value;
  }

  async function status() {
    if (client && !client.closed) return 'connected';
    try {
      await discoverTarget();
      return 'page_found';
    } catch {
      return 'unavailable';
    }
  }

  async function close() {
    client?.close();
    client = undefined;
  }

  return Object.freeze({ evaluate, status, close });
}

module.exports = { createBrowserGateway };
