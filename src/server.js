'use strict';

const http = require('node:http');

const { createApp } = require('./app');
const { createAppleEventsGateway } = require('./browser/apple-events-gateway');
const { createBrowserGateway } = require('./browser/gateway');
const { createOperationQueue } = require('./browser/operation-queue');
const { loadConfig } = require('./config');
const { createFeedState } = require('./realtime/feed-state');
const { createImNetworkMonitor } = require('./realtime/im-network-monitor');
const { createWsFeedServer } = require('./realtime/ws-feed-server');
const { createBrowserUpstream } = require('./upstream/browser');
const { CODES, upstreamError } = require('./upstream/errors');

function createDisabledUpstream() {
  const unavailable = async () => {
    throw upstreamError(CODES.BAD_RESPONSE, 'Authenticated upstream adapter is not configured');
  };
  return Object.freeze({
    getSports: unavailable,
    getSportsAccount: unavailable,
    getSportsCatalog: unavailable,
    getSportsBoosts: unavailable,
    getBalance: unavailable,
    getBets: unavailable,
    async close() {},
  });
}

function createConfiguredUpstream(config, {
  appleEventsGatewayFactory = createAppleEventsGateway,
  cdpGatewayFactory = createBrowserGateway,
  queueFactory = createOperationQueue,
} = {}) {
  if (config.upstreamMode !== 'browser') return createDisabledUpstream();

  const queue = queueFactory({ timeoutMs: config.browserOperationTimeoutMs });
  let gatewayFactory;
  let sharedOptions;
  if (config.browserTransport === 'apple_events') {
    gatewayFactory = appleEventsGatewayFactory;
    sharedOptions = {};
  } else if (config.browserTransport === 'cdp') {
    gatewayFactory = cdpGatewayFactory;
    sharedOptions = { cdpUrl: config.browserCdpUrl };
  } else {
    throw new TypeError('Unsupported browser transport');
  }
  const sportsGateway = gatewayFactory({
    ...sharedOptions,
    pageOrigin: config.browserSportsOrigin,
    pagePathname: '/',
  });
  const accountGateway = gatewayFactory({
    ...sharedOptions,
    pageOrigin: config.browserPageOrigin,
    pagePathname: '/',
  });
  const betsGateway = gatewayFactory({
    ...sharedOptions,
    pageOrigin: config.browserSportsOrigin,
    pagePathname: '/popup/',
  });
  return createBrowserUpstream({ sportsGateway, accountGateway, betsGateway, queue });
}

function rejectUpgrade(socket, status, reason) {
  if (!socket || socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\n`
      + 'Connection: close\r\n'
      + 'Content-Length: 0\r\n'
      + '\r\n',
  );
}

function attachUnavailableRealtime(server) {
  function onUpgrade(request, socket) {
    let pathname;
    try {
      pathname = new URL(request?.url || '', 'http://127.0.0.1').pathname;
    } catch {
      pathname = '';
    }
    if (pathname === '/ws/sports') rejectUpgrade(socket, 503, 'Service Unavailable');
    else rejectUpgrade(socket, 404, 'Not Found');
  }
  server.on('upgrade', onUpgrade);
  return () => server.off('upgrade', onUpgrade);
}

function createHttpServer(config, injectedUpstream, {
  feedFactory = createFeedState,
  monitorFactory = createImNetworkMonitor,
  wsFeedFactory = createWsFeedServer,
} = {}) {
  const upstream = injectedUpstream || createConfiguredUpstream(config);
  const server = http.createServer(createApp({
    apiToken: config.apiToken,
    sportsCacheMs: config.sportsCacheMs,
    upstream,
  }));

  let monitor = null;
  let wsFeed = null;
  let detachUnavailable = null;
  const realtimeEnabled = config.upstreamMode === 'browser'
    && config.browserTransport === 'cdp';
  if (realtimeEnabled) {
    const feed = feedFactory({ staleMs: 15_000 });
    wsFeed = wsFeedFactory({ server, feed, token: config.wsToken });
    monitor = monitorFactory({
      cdpUrl: config.browserCdpUrl,
      pageOrigin: config.browserSportsOrigin,
      onResponse: (value) => feed.ingest(value),
      onDisconnect: () => feed.invalidate(),
    });
    Promise.resolve()
      .then(() => monitor.start())
      .catch(() => feed.invalidate());
  } else {
    detachUnavailable = attachUnavailableRealtime(server);
  }

  let shutdownPromise;
  function shutdown() {
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        detachUnavailable?.();
        if (monitor) {
          try { await monitor.stop(); } catch { /* continue shutdown */ }
        }
        if (wsFeed) {
          try { await wsFeed.close(); } catch { /* continue shutdown */ }
        }
        try { await upstream.close?.(); } catch { /* shutdown is best effort */ }
      })();
    }
    return shutdownPromise;
  }
  server.once('close', () => { void shutdown(); });
  Object.defineProperty(server, 'waitForShutdown', {
    enumerable: false,
    configurable: false,
    writable: false,
    value: () => shutdownPromise || Promise.resolve(),
  });
  return server;
}

function main() {
  const config = loadConfig();
  const server = createHttpServer(config);
  server.on('error', () => {
    process.stderr.write('k8-api failed to start\n');
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => {
    process.stdout.write(`k8-api listening on http://${config.host}:${config.port}\n`);
  });
}

if (require.main === module) main();

module.exports = { createConfiguredUpstream, createDisabledUpstream, createHttpServer };
