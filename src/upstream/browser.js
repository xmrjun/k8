'use strict';

const { buildSportsExpression, normalizeSportsPayload } = require('../browser/readers/sports');
const {
  buildSportsAccountExpression,
  normalizeSportsAccountPayload,
} = require('../browser/readers/sports-account');
const { buildBalanceExpression, normalizeBalancePayload } = require('../browser/readers/balance');
const { buildBetsExpression, normalizeBetsPayload } = require('../browser/readers/bets');
const { CODES, UpstreamError, upstreamError } = require('./errors');

const KNOWN_CODES = new Set(Object.values(CODES));

const sportsReader = Object.freeze({
  buildExpression: () => buildSportsExpression({ maxEvents: 500 }),
  normalize: normalizeSportsPayload,
});

const sportsAccountReader = Object.freeze({
  buildExpression: buildSportsAccountExpression,
  normalize: normalizeSportsAccountPayload,
});

const balanceReader = Object.freeze({
  buildExpression: () => buildBalanceExpression({ maxWallets: 20 }),
  normalize: normalizeBalancePayload,
});

const betsReader = Object.freeze({
  buildExpression: () => buildBetsExpression({ maxRows: 200 }),
  normalize: normalizeBetsPayload,
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
    sportsAccount: readers.sportsAccount || sportsAccountReader,
    balance: readers.balance || balanceReader,
    bets: readers.bets || betsReader,
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
    getSportsAccount: () => perform(sportsGateway, selectedReaders.sportsAccount),
    getBalance: () => perform(accountGateway, selectedReaders.balance),
    getBets: (options = {}) => perform(accountGateway, selectedReaders.bets, options),
    async close() {
      await sportsGateway.close();
      await accountGateway.close();
    },
  });
}

module.exports = { createBrowserUpstream };
