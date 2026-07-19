'use strict';

const { CODES, upstreamError } = require('../upstream/errors');

function byteLength(value) {
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return Infinity;
}

function textValue(value) {
  if (typeof value === 'string') return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString('utf8');
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8');
  }
  throw upstreamError(CODES.BAD_RESPONSE, 'CDP returned an unsupported message');
}

function createCdpClient({
  webSocketUrl,
  webSocketFactory = (url) => new WebSocket(url),
  maxMessageBytes = 1_000_000,
}) {
  if (!Number.isInteger(maxMessageBytes) || maxMessageBytes <= 0) {
    throw new TypeError('maxMessageBytes must be a positive integer');
  }

  let socket;
  try {
    socket = webSocketFactory(webSocketUrl);
  } catch {
    throw upstreamError(CODES.BROWSER_UNAVAILABLE, 'Could not connect to browser');
  }

  let nextId = 1;
  let closed = false;
  const pending = new Map();
  const subscriptions = new Map();
  const disconnectListeners = new Set();
  let resolveOpen;
  let rejectOpen;
  const opened = new Promise((resolve, reject) => {
    resolveOpen = resolve;
    rejectOpen = reject;
  });

  function rejectPending(error) {
    for (const entry of pending.values()) {
      entry.cleanup();
      entry.reject(error);
    }
    pending.clear();
  }

  function fail(error) {
    if (closed) return;
    closed = true;
    rejectOpen(error);
    rejectPending(error);
    subscriptions.clear();
    const listeners = [...disconnectListeners];
    disconnectListeners.clear();
    for (const listener of listeners) {
      try { listener(); } catch { /* ignored */ }
    }
  }

  socket.addEventListener('open', () => resolveOpen(), { once: true });
  socket.addEventListener('error', () => {
    fail(upstreamError(CODES.BROWSER_UNAVAILABLE, 'Browser connection failed'));
  });
  socket.addEventListener('close', () => {
    fail(upstreamError(CODES.BROWSER_UNAVAILABLE, 'Browser connection closed'));
  });
  socket.addEventListener('message', (event) => {
    if (closed) return;
    if (byteLength(event.data) > maxMessageBytes) {
      fail(upstreamError(CODES.BAD_RESPONSE, 'CDP response was too large'));
      try { socket.close(); } catch { /* ignored */ }
      return;
    }

    let frame;
    try {
      frame = JSON.parse(textValue(event.data));
    } catch {
      fail(upstreamError(CODES.BAD_RESPONSE, 'CDP returned invalid JSON'));
      try { socket.close(); } catch { /* ignored */ }
      return;
    }

    if (!Number.isInteger(frame?.id)) {
      if (typeof frame?.method !== 'string') return;
      for (const listener of [...(subscriptions.get(frame.method) || [])]) {
        try { listener(frame.params || {}); } catch { /* ignored */ }
      }
      return;
    }
    const entry = pending.get(frame.id);
    if (!entry) return;
    pending.delete(frame.id);
    entry.cleanup();
    if (frame.error) {
      entry.reject(upstreamError(CODES.BAD_RESPONSE, 'CDP command failed'));
      return;
    }
    entry.resolve(frame.result);
  });

  function subscribe(method, listener) {
    if (typeof method !== 'string' || method.length === 0 || typeof listener !== 'function') {
      throw new TypeError('CDP event method and listener are required');
    }
    if (closed) return () => {};
    const listeners = subscriptions.get(method) || new Set();
    listeners.add(listener);
    subscriptions.set(method, listeners);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      listeners.delete(listener);
      if (listeners.size === 0) subscriptions.delete(method);
    };
  }

  function onDisconnect(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('CDP disconnect listener is required');
    }
    if (closed) {
      try { listener(); } catch { /* ignored */ }
      return () => {};
    }
    disconnectListeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      disconnectListeners.delete(listener);
    };
  }

  async function call(method, params = {}, { signal } = {}) {
    if (closed) {
      throw upstreamError(CODES.BROWSER_UNAVAILABLE, 'Browser connection is closed');
    }
    if (signal?.aborted) {
      throw upstreamError(CODES.TIMEOUT, 'CDP command was aborted');
    }

    try {
      await opened;
    } catch {
      throw upstreamError(CODES.BROWSER_UNAVAILABLE, 'Browser connection failed');
    }
    if (closed) {
      throw upstreamError(CODES.BROWSER_UNAVAILABLE, 'Browser connection is closed');
    }

    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        entry.cleanup();
        reject(upstreamError(CODES.TIMEOUT, 'CDP command was aborted'));
        try { socket.close(); } catch { /* ignored */ }
      };
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener('abort', onAbort, { once: true });

      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch {
        pending.delete(id);
        cleanup();
        reject(upstreamError(CODES.BROWSER_UNAVAILABLE, 'Could not send CDP command'));
      }
    });
  }

  function close() {
    if (closed) return;
    try {
      socket.close();
    } catch {
      fail(upstreamError(CODES.BROWSER_UNAVAILABLE, 'Browser connection closed'));
    }
  }

  return Object.freeze({
    call,
    subscribe,
    onDisconnect,
    close,
    get closed() {
      return closed;
    },
  });
}

module.exports = { createCdpClient };
