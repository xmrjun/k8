'use strict';

const { WebSocket, WebSocketServer } = require('ws');
const { isTokenEqual } = require('../auth');

const ALIVE = Symbol('k8Alive');

function rejectUpgrade(socket, status, reason) {
  if (!socket || socket.destroyed) return;
  const body = '';
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\n`
      + 'Connection: close\r\n'
      + 'Content-Type: text/plain; charset=utf-8\r\n'
      + `Content-Length: ${Buffer.byteLength(body)}\r\n`
      + '\r\n'
      + body,
  );
}

function requestTarget(request) {
  try {
    return new URL(request?.url || '', 'http://127.0.0.1');
  } catch {
    return null;
  }
}

function createWsFeedServer({
  server,
  feed,
  token,
  onDiagnostic = () => {},
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  heartbeatMs = 30_000,
  maxBufferedBytes = 1_000_000,
  getBufferedAmount = (client) => client.bufferedAmount,
  webSocketServerFactory = (options) => new WebSocketServer(options),
}) {
  if (!server?.on || !server?.off || !feed?.snapshot || !feed?.isStale
    || !feed?.subscribe || !feed?.nextSequence || typeof token !== 'string'
    || token.length === 0 || typeof onDiagnostic !== 'function'
    || typeof setIntervalImpl !== 'function' || typeof clearIntervalImpl !== 'function'
    || typeof getBufferedAmount !== 'function' || typeof webSocketServerFactory !== 'function') {
    throw new TypeError('WebSocket feed server dependencies are required');
  }
  if (!Number.isInteger(heartbeatMs) || heartbeatMs <= 0) {
    throw new TypeError('heartbeatMs must be a positive integer');
  }
  if (!Number.isInteger(maxBufferedBytes) || maxBufferedBytes <= 0) {
    throw new TypeError('maxBufferedBytes must be a positive integer');
  }

  const wss = webSocketServerFactory({
    noServer: true,
    clientTracking: true,
    perMessageDeflate: false,
    maxPayload: 1024,
  });
  let closed = false;

  function diagnostic(code) {
    try { onDiagnostic(code); } catch { /* isolated */ }
  }

  function closeClient(client, code, reason) {
    try { client.close(code, reason); } catch { /* ignored */ }
  }

  function sendJson(client, message) {
    if (client.readyState !== WebSocket.OPEN) return false;
    let buffered;
    try {
      buffered = getBufferedAmount(client);
    } catch {
      buffered = maxBufferedBytes + 1;
    }
    if (!Number.isFinite(buffered) || buffered > maxBufferedBytes) {
      closeClient(client, 1013, 'slow client');
      diagnostic('slow_client_closed');
      return false;
    }
    try {
      client.send(JSON.stringify(message));
      return true;
    } catch {
      closeClient(client, 1011, 'send failed');
      diagnostic('send_failed');
      return false;
    }
  }

  function broadcast(message) {
    if (closed) return;
    for (const client of wss.clients) sendJson(client, message);
  }

  wss.on('connection', (client) => {
    client[ALIVE] = true;
    client.on('pong', () => { client[ALIVE] = true; });
    client.on('message', () => closeClient(client, 1008, 'messages are not accepted'));
    const snapshot = feed.snapshot();
    if (!snapshot || feed.isStale()) {
      closeClient(client, 1012, 'source unavailable');
      return;
    }
    sendJson(client, snapshot);
  });

  function onUpgrade(request, socket, head) {
    if (closed) {
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }
    const target = requestTarget(request);
    if (!target || target.pathname !== '/ws/sports') {
      diagnostic('upgrade_not_found');
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    const tokens = target.searchParams.getAll('token');
    if (tokens.length !== 1 || tokens[0].length === 0 || !isTokenEqual(tokens[0], token)) {
      diagnostic('upgrade_unauthorized');
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    if (!feed.snapshot() || feed.isStale()) {
      diagnostic('upgrade_unavailable');
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }
    try {
      wss.handleUpgrade(request, socket, head, (client) => {
        wss.emit('connection', client, request);
      });
    } catch {
      diagnostic('upgrade_failed');
      try { socket.destroy(); } catch { /* ignored */ }
    }
  }

  server.on('upgrade', onUpgrade);
  const unsubscribe = feed.subscribe(broadcast);
  const heartbeatTimer = setIntervalImpl(() => {
    if (closed || wss.clients.size === 0) return;
    if (feed.isStale()) {
      for (const client of wss.clients) closeClient(client, 1012, 'source stale');
      diagnostic('stale_clients_closed');
      return;
    }

    const message = { type: 'ping', seq: feed.nextSequence() };
    for (const client of wss.clients) {
      if (client[ALIVE] === false) {
        try { client.terminate(); } catch { /* ignored */ }
        diagnostic('dead_client_terminated');
        continue;
      }
      client[ALIVE] = false;
      if (!sendJson(client, message)) continue;
      try { client.ping(); } catch {
        try { client.terminate(); } catch { /* ignored */ }
      }
    }
  }, heartbeatMs);

  let closingPromise;
  async function close() {
    if (closingPromise) return closingPromise;
    closed = true;
    server.off('upgrade', onUpgrade);
    clearIntervalImpl(heartbeatTimer);
    unsubscribe();
    for (const client of wss.clients) closeClient(client, 1001, 'server shutdown');
    closingPromise = new Promise((resolve) => {
      try { wss.close(() => resolve()); } catch { resolve(); }
    });
    return closingPromise;
  }

  function status() {
    return Object.freeze({ closed, clients: wss.clients.size });
  }

  return Object.freeze({ broadcast, close, status });
}

module.exports = { createWsFeedServer };
