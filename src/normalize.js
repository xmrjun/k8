'use strict';

const SCHEMA_ERROR_CODE = 'UPSTREAM_SCHEMA_CHANGED';
const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const OFFSET_ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/;

function schemaError(path) {
  const error = new Error(`Upstream schema changed at ${path}`);
  error.code = SCHEMA_ERROR_CODE;
  return error;
}

function required(value, path) {
  if (value === undefined || value === null || value === '') {
    throw schemaError(path);
  }
  return value;
}

function requiredText(value, path) {
  if (typeof value !== 'string' || value.length === 0) {
    throw schemaError(path);
  }
  return value;
}

function requiredArray(value, path) {
  if (!Array.isArray(value)) {
    throw schemaError(path);
  }
  return value;
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function hasValidIsoComponents(match) {
  const [, yearText, monthText, dayText, hourText, minuteText, secondText,
    zone, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]
    || hour > 23 || minute > 59 || second > 59) {
    return false;
  }

  if (zone !== 'Z') {
    const offsetHour = Number(offsetHourText);
    const offsetMinute = Number(offsetMinuteText);
    if (offsetHour > 23 || offsetMinute > 59) {
      return false;
    }
  }

  return true;
}

function isoTimestamp(value, path) {
  const isEpochMilliseconds = typeof value === 'number'
    && Number.isSafeInteger(value)
    && Math.abs(value) >= 1_000_000_000_000;
  const isoMatch = typeof value === 'string' ? value.match(OFFSET_ISO_PATTERN) : null;
  const isOffsetIsoString = isoMatch !== null && hasValidIsoComponents(isoMatch);
  if (!isEpochMilliseconds && !isOffsetIsoString) {
    throw schemaError(path);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw schemaError(path);
  }
  return date.toISOString();
}

function significantDigits(decimal) {
  const unsigned = decimal.replace(/^-/, '');
  const digits = unsigned.replace('.', '').replace(/^0+/, '').replace(/0+$/, '');
  return digits.length || 1;
}

function publicDecimal(value, path) {
  required(value, path);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw schemaError(path);
    }
    return value;
  }

  const decimal = value;
  if (typeof decimal !== 'string' || !DECIMAL_PATTERN.test(decimal)) {
    throw schemaError(path);
  }

  const number = Number(decimal);
  if (!Number.isFinite(number)) {
    throw schemaError(path);
  }

  const [integerPart, fractionalPart] = decimal.split('.');
  const isInteger = fractionalPart === undefined || /^0+$/.test(fractionalPart);
  if (isInteger) {
    const integer = BigInt(integerPart);
    return integer >= BigInt(Number.MIN_SAFE_INTEGER)
      && integer <= BigInt(Number.MAX_SAFE_INTEGER)
      ? number
      : decimal;
  }

  return significantDigits(decimal) <= 15 ? number : decimal;
}

function normalizeMarket(market, marketIndex, eventIndex) {
  const path = `data.events[${eventIndex}].markets[${marketIndex}]`;
  return {
    name: requiredText(market?.name, `${path}.name`),
    selections: requiredArray(market?.selections, `${path}.selections`).map(
      (selection, selectionIndex) => ({
        name: requiredText(selection?.name, `${path}.selections[${selectionIndex}].name`),
        odds: publicDecimal(selection?.odds, `${path}.selections[${selectionIndex}].odds`),
      }),
    ),
  };
}

function normalizeSports(payload) {
  return requiredArray(payload?.data?.events, 'data.events').map((event, index) => ({
    event_id: requiredText(event?.id, `data.events[${index}].id`),
    league: requiredText(event?.competition?.name, `data.events[${index}].competition.name`),
    starts_at: isoTimestamp(event?.start_time, `data.events[${index}].start_time`),
    home: requiredText(event?.participants?.home?.name, `data.events[${index}].participants.home.name`),
    away: requiredText(event?.participants?.away?.name, `data.events[${index}].participants.away.name`),
    markets: requiredArray(event?.markets, `data.events[${index}].markets`).map(
      (market, marketIndex) => normalizeMarket(market, marketIndex, index),
    ),
  }));
}

function normalizeBalance(payload) {
  const wallet = required(payload?.data?.wallet, 'data.wallet');
  return {
    currency: requiredText(wallet.currency_code, 'data.wallet.currency_code'),
    available: publicDecimal(wallet.available_amount, 'data.wallet.available_amount'),
    locked: publicDecimal(wallet.locked_amount, 'data.wallet.locked_amount'),
    total: publicDecimal(wallet.total_amount, 'data.wallet.total_amount'),
  };
}

function normalizeBets(payload) {
  return requiredArray(payload?.data?.bets, 'data.bets').map((bet, index) => {
    const path = `data.bets[${index}]`;
    return {
      bet_id: requiredText(bet?.id, `${path}.id`),
      placed_at: isoTimestamp(bet?.created_at, `${path}.created_at`),
      status: requiredText(bet?.state, `${path}.state`),
      stake: publicDecimal(bet?.stake_amount, `${path}.stake_amount`),
      currency: requiredText(bet?.currency_code, `${path}.currency_code`),
      selection: requiredText(bet?.pick, `${path}.pick`),
      odds: publicDecimal(bet?.decimal_odds, `${path}.decimal_odds`),
      payout: publicDecimal(bet?.payout_amount, `${path}.payout_amount`),
    };
  });
}

module.exports = { normalizeSports, normalizeBalance, normalizeBets };
