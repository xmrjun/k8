'use strict';

const { buildSportsExpression, normalizeSportsPayload } = require('../browser/readers/sports');
const { CODES, UpstreamError, upstreamError } = require('./errors');

const KNOWN_CODES = new Set(Object.values(CODES));

const sportsReader = Object.freeze({
  buildExpression: () => buildSportsExpression({ maxEvents: 500 }),
  normalize: normalizeSportsPayload,
});

const unavailableReader = Object.freeze({
  buildExpression() {
    throw upstreamError(CODES.SCHEMA_CHANGED, 'Browser account reader is not available');
  },
  normalize() {
    throw upstreamError(CODES.SCHEMA_CHANGED, 'Browser account reader is not available');
  },
});

function trustedError(error) {
  if (error instanceof UpstreamError && KNOWN_CODES.has(error.code)) return error;
  return upstreamError(CODES.BROWSER_UNAVAILABLE, 'Browser operation failed');
}

function createBrowserUpstream({
  sportsGateway,
  accountGateway,
  queue,
  readers = {},
}) {
  if (!sportsGateway?.evaluate || !sportsGateway?.close
    || !accountGateway?.evaluate || !accountGateway?.close
    || !queue?.run) {
    throw new TypeError('Browser gateways and operation queue are required');
  }

  const selectedReaders = {
    sports: readers.sports || sportsReader,
    balance: readers.balance || unavailableReader,
    bets: readers.bets || unavailableReader,
  };

  async function perform(gateway, reader, options) {
    try {
      if (typeof reader?.buildExpression !== 'function'
        || typeof reader?.normalize !== 'function') {
        throw new TypeError('Browser reader is invalid');
      }
      const expression = reader.buildExpression(options);
      const value = await queue.run(({ signal }) => gateway.evaluate(expression, { signal }));
      return reader.normalize(value, options);
    } catch (error) {
      throw trustedError(error);
    }
  }

  return Object.freeze({
    getSports: (options = {}) => perform(
      sportsGateway,
      selectedReaders.sports,
      options,
    ),
    getBalance: () => perform(accountGateway, selectedReaders.balance),
    getBets: (options = {}) => perform(accountGateway, selectedReaders.bets, options),
    async close() {
      await sportsGateway.close();
      await accountGateway.close();
    },
  });
}

module.exports = { createBrowserUpstream };
