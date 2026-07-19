'use strict';

const { createCdpClient } = require('./cdp-client');
const { createTargetDiscovery } = require('./target-discovery');
const { CODES, UpstreamError, upstreamError } = require('../upstream/errors');

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
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new TypeError('maxResponseBytes must be a positive integer');
  }
  if (!Number.isInteger(maxDiscoveryBytes) || maxDiscoveryBytes <= 0) {
    throw new TypeError('maxDiscoveryBytes must be a positive integer');
  }

  const discovery = createTargetDiscovery({
    cdpUrl,
    pageOrigin,
    fetchImpl,
    maxDiscoveryBytes,
  });
  let client;

  async function connectedClient(signal) {
    if (client && !client.closed) return client;
    const target = await discovery.discover({ signal });
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
      await discovery.discover();
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
