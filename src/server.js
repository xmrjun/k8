'use strict';

const http = require('node:http');

const { createApp } = require('./app');
const { loadConfig } = require('./config');
const { CODES, upstreamError } = require('./upstream/errors');

function createDisabledUpstream() {
  const unavailable = async () => {
    throw upstreamError(CODES.BAD_RESPONSE, 'Authenticated upstream adapter is not configured');
  };
  return Object.freeze({
    getSports: unavailable,
    getBalance: unavailable,
    getBets: unavailable,
  });
}

function createHttpServer(config, upstream = createDisabledUpstream()) {
  return http.createServer(createApp({
    apiToken: config.apiToken,
    sportsCacheMs: config.sportsCacheMs,
    upstream,
  }));
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

module.exports = { createDisabledUpstream, createHttpServer };
