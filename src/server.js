'use strict';

const http = require('node:http');

const { createApp } = require('./app');
const { createBrowserGateway } = require('./browser/gateway');
const { createOperationQueue } = require('./browser/operation-queue');
const { loadConfig } = require('./config');
const { createBrowserUpstream } = require('./upstream/browser');
const { CODES, upstreamError } = require('./upstream/errors');

function createDisabledUpstream() {
  const unavailable = async () => {
    throw upstreamError(CODES.BAD_RESPONSE, 'Authenticated upstream adapter is not configured');
  };
  return Object.freeze({
    getSports: unavailable,
    getBalance: unavailable,
    getBets: unavailable,
    async close() {},
  });
}

function createConfiguredUpstream(config, {
  gatewayFactory = createBrowserGateway,
  queueFactory = createOperationQueue,
} = {}) {
  if (config.upstreamMode !== 'browser') return createDisabledUpstream();

  const queue = queueFactory({ timeoutMs: config.browserOperationTimeoutMs });
  const sportsGateway = gatewayFactory({
    cdpUrl: config.browserCdpUrl,
    pageOrigin: config.browserSportsOrigin,
  });
  const accountGateway = gatewayFactory({
    cdpUrl: config.browserCdpUrl,
    pageOrigin: config.browserPageOrigin,
  });
  return createBrowserUpstream({ sportsGateway, accountGateway, queue });
}

function createHttpServer(config, injectedUpstream) {
  const upstream = injectedUpstream || createConfiguredUpstream(config);
  const server = http.createServer(createApp({
    apiToken: config.apiToken,
    sportsCacheMs: config.sportsCacheMs,
    upstream,
  }));
  server.once('close', () => {
    Promise.resolve(upstream.close?.()).catch(() => {});
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
