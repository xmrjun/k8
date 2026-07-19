'use strict';

const { createCdpClient } = require('../browser/cdp-client');
const { createTargetDiscovery } = require('../browser/target-discovery');
const { decodeImResponse } = require('./im-protocol');

const NETWORK_LIMITS = Object.freeze({
  maxTotalBufferSize: 10_000_000,
  maxResourceBufferSize: 2_000_000,
  maxPostDataSize: 0,
});

function exactHttpsOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('pageOrigin must be an exact HTTPS origin');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password
    || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new TypeError('pageOrigin must be an exact HTTPS origin');
  }
  return parsed.origin;
}

function matchesOrigin(value, expectedOrigin) {
  try {
    return new URL(value).origin === expectedOrigin;
  } catch {
    return false;
  }
}

function jsonMime(value) {
  if (typeof value !== 'string') return false;
  const mime = value.toLowerCase().split(';', 1)[0].trim();
  return mime === 'application/json'
    || mime === 'text/json'
    || mime.endsWith('+json');
}

function safeRequestId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200;
}

function createImNetworkMonitor({
  cdpUrl,
  pageOrigin,
  targetDiscovery,
  fetchImpl,
  cdpClientFactory = createCdpClient,
  onResponse,
  onDisconnect = () => {},
  onDiagnostic = () => {},
  now = Date.now,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  maxResponseBytes = 2_000_000,
  maxRequests = 1_000,
  reloadCooldownMs = 15_000,
}) {
  const allowedOrigin = exactHttpsOrigin(pageOrigin);
  if (typeof cdpClientFactory !== 'function' || typeof onResponse !== 'function'
    || typeof onDisconnect !== 'function' || typeof onDiagnostic !== 'function'
    || typeof now !== 'function' || typeof setTimeoutImpl !== 'function'
    || typeof clearTimeoutImpl !== 'function') {
    throw new TypeError('monitor dependencies must be functions');
  }
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes <= 0
    || maxResponseBytes > 2_000_000) {
    throw new TypeError('maxResponseBytes must be between 1 and 2000000');
  }
  if (!Number.isInteger(maxRequests) || maxRequests <= 0 || maxRequests > 10_000) {
    throw new TypeError('maxRequests must be between 1 and 10000');
  }
  if (!Number.isInteger(reloadCooldownMs) || reloadCooldownMs <= 0) {
    throw new TypeError('reloadCooldownMs must be a positive integer');
  }

  const discovery = targetDiscovery || createTargetDiscovery({
    cdpUrl,
    pageOrigin: allowedOrigin,
    fetchImpl,
  });
  if (!discovery || typeof discovery.discover !== 'function') {
    throw new TypeError('targetDiscovery must expose discover()');
  }

  let started = false;
  let stopped = true;
  let connecting = false;
  let activeClient = null;
  let connectionId = 0;
  let retryAttempt = 0;
  let retryTimer = null;
  let lastReloadAt = Number.NEGATIVE_INFINITY;
  let unsubscribers = [];
  const requests = new Map();

  function diagnostic(code) {
    try { onDiagnostic(code); } catch { /* isolated */ }
  }

  function clearSubscriptions() {
    const current = unsubscribers;
    unsubscribers = [];
    for (const unsubscribe of current) {
      try { unsubscribe(); } catch { /* ignored */ }
    }
  }

  function scheduleReconnect() {
    if (stopped || retryTimer) return;
    const delay = Math.min(250 * (2 ** retryAttempt), 10_000);
    retryAttempt += 1;
    retryTimer = setTimeoutImpl(async () => {
      retryTimer = null;
      await connect();
    }, delay);
  }

  function addRequest(requestId, state) {
    if (requests.size >= maxRequests) {
      const oldest = requests.keys().next().value;
      requests.delete(oldest);
    }
    requests.set(requestId, state);
  }

  async function requestResync(client, id) {
    if (stopped || activeClient !== client || connectionId !== id) return false;
    const currentTime = now();
    if (currentTime - lastReloadAt < reloadCooldownMs) return false;
    lastReloadAt = currentTime;
    try {
      await client.call('Page.reload', { ignoreCache: false });
      diagnostic('resync_requested');
      return true;
    } catch {
      diagnostic('resync_failed');
      return false;
    }
  }

  async function processFinished(client, id, requestId, state, encodedDataLength) {
    if (!state.requestEligible || !state.responseEligible
      || typeof encodedDataLength !== 'number'
      || !Number.isFinite(encodedDataLength)
      || encodedDataLength < 0
      || encodedDataLength > maxResponseBytes) {
      return;
    }

    let bodyResult;
    try {
      bodyResult = await client.call('Network.getResponseBody', { requestId });
    } catch {
      diagnostic('body_unavailable');
      return;
    }
    if (stopped || activeClient !== client || connectionId !== id) return;
    if (!bodyResult || bodyResult.base64Encoded !== false
      || typeof bodyResult.body !== 'string'
      || Buffer.byteLength(bodyResult.body) > maxResponseBytes) {
      diagnostic('response_discarded');
      return;
    }

    let decoded;
    try {
      decoded = decodeImResponse(bodyResult.body, { maxBytes: maxResponseBytes });
    } catch {
      diagnostic('response_discarded');
      return;
    }

    try {
      const result = await onResponse(decoded);
      if (result?.needsResync === true) await requestResync(client, id);
    } catch {
      diagnostic('consumer_failed');
    }
  }

  function subscribeToNetwork(client, id) {
    unsubscribers.push(client.subscribe('Network.requestWillBeSent', (params) => {
      if (stopped || activeClient !== client || connectionId !== id
        || !safeRequestId(params?.requestId)) return;
      const requestEligible = params.type === 'Fetch'
        && params.request?.method === 'POST'
        && matchesOrigin(params.request?.url, allowedOrigin);
      addRequest(params.requestId, { requestEligible, responseEligible: false });
    }));

    unsubscribers.push(client.subscribe('Network.responseReceived', (params) => {
      if (stopped || activeClient !== client || connectionId !== id
        || !safeRequestId(params?.requestId)) return;
      const state = requests.get(params.requestId);
      if (!state) return;
      state.responseEligible = state.requestEligible
        && params.type === 'Fetch'
        && params.response?.status === 200
        && jsonMime(params.response?.mimeType)
        && matchesOrigin(params.response?.url, allowedOrigin);
    }));

    unsubscribers.push(client.subscribe('Network.loadingFinished', (params) => {
      if (stopped || activeClient !== client || connectionId !== id
        || !safeRequestId(params?.requestId)) return;
      const state = requests.get(params.requestId);
      requests.delete(params.requestId);
      if (!state) return;
      void processFinished(
        client,
        id,
        params.requestId,
        state,
        params.encodedDataLength,
      );
    }));

    unsubscribers.push(client.subscribe('Network.loadingFailed', (params) => {
      if (safeRequestId(params?.requestId)) requests.delete(params.requestId);
    }));
  }

  function handleDisconnect(client, id) {
    if (stopped || activeClient !== client || connectionId !== id) return;
    clearSubscriptions();
    activeClient = null;
    requests.clear();
    try { onDisconnect(); } catch { /* isolated */ }
    diagnostic('source_disconnected');
    scheduleReconnect();
  }

  async function connect() {
    if (stopped || connecting || activeClient) return;
    connecting = true;
    let client;
    try {
      const target = await discovery.discover();
      if (stopped) return;
      if (typeof target?.webSocketDebuggerUrl !== 'string') throw new Error('target');
      client = cdpClientFactory({
        webSocketUrl: target.webSocketDebuggerUrl,
        maxMessageBytes: 4_100_000,
      });
      const id = connectionId + 1;
      connectionId = id;
      activeClient = client;
      subscribeToNetwork(client, id);
      unsubscribers.push(client.onDisconnect(() => handleDisconnect(client, id)));
      await client.call('Network.enable', NETWORK_LIMITS);
      if (stopped || activeClient !== client || connectionId !== id) {
        try { client.close(); } catch { /* ignored */ }
        return;
      }
      retryAttempt = 0;
      diagnostic('source_connected');
    } catch {
      if (client && activeClient === client) {
        clearSubscriptions();
        activeClient = null;
        requests.clear();
        try { client.close(); } catch { /* ignored */ }
      }
      diagnostic('connect_failed');
      scheduleReconnect();
    } finally {
      connecting = false;
    }
  }

  async function start() {
    if (started && !stopped) return;
    started = true;
    stopped = false;
    await connect();
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    if (retryTimer) {
      clearTimeoutImpl(retryTimer);
      retryTimer = null;
    }
    clearSubscriptions();
    requests.clear();
    const client = activeClient;
    activeClient = null;
    if (client) {
      try { client.close(); } catch { /* ignored */ }
    }
  }

  function status() {
    return Object.freeze({
      connected: activeClient !== null && !stopped,
      pendingRequests: requests.size,
    });
  }

  return Object.freeze({ start, stop, status });
}

module.exports = { createImNetworkMonitor };
