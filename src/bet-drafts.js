'use strict';

const INVALID_DRAFT_INPUT = 'INVALID_DRAFT_INPUT';
const ALLOWED_FIELDS = Object.freeze([
  'scope',
  'sport',
  'event_id',
  'selection_key',
  'stake',
  'expected_odds',
  'max_odds_drift',
  'idempotency_key',
]);
const ALLOWED_SCOPES = new Set(['live', 'today', 'early']);
const ALLOWED_SPORTS = new Set(['football', 'basketball', 'tennis']);
const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;
const STAKE_PATTERN = /^\d+(?:\.\d{1,2})?$/;
const MAX_DECIMAL_LENGTH = 64;

class DraftError extends Error {
  constructor(code) {
    super(code);
    this.name = 'DraftError';
    this.code = code;
  }
}

function invalidInput() {
  throw new DraftError(INVALID_DRAFT_INPUT);
}

function canonicalDecimal(value) {
  const [integerPart, fractionalPart = ''] = value.split('.');
  const integer = integerPart.replace(/^0+(?=\d)/, '');
  const fraction = fractionalPart.replace(/0+$/, '');
  return fraction.length > 0 ? `${integer}.${fraction}` : integer;
}

function powerOfTen(exponent) {
  return 10n ** BigInt(exponent);
}

function requireDecimal(value, { positive = false, stake = false } = {}) {
  const pattern = stake ? STAKE_PATTERN : DECIMAL_PATTERN;
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_DECIMAL_LENGTH
    || !pattern.test(value)) {
    invalidInput();
  }

  const canonical = canonicalDecimal(value);
  if (positive && /^0(?:\.0*)?$/.test(canonical)) invalidInput();
  return canonical;
}

function normalizeStake(value) {
  const canonical = requireDecimal(value, { positive: true, stake: true });
  const [integerPart, fractionalPart = ''] = canonical.split('.');
  const cents = (BigInt(integerPart) * 100n)
    + BigInt(fractionalPart.padEnd(2, '0'));
  if (cents < 1n || cents > 100_000_000n) invalidInput();
  return canonical;
}

function parseDecimal(value) {
  const canonical = requireDecimal(value);
  const [integerPart, fractionalPart = ''] = canonical.split('.');
  return {
    coefficient: BigInt(`${integerPart}${fractionalPart}`),
    scale: fractionalPart.length,
  };
}

function scaledCoefficient(decimal, scale) {
  return decimal.coefficient * powerOfTen(scale - decimal.scale);
}

function decimalDifferenceExceeds(actualValue, expectedValue, maximumDriftValue) {
  const actual = parseDecimal(actualValue);
  const expected = parseDecimal(expectedValue);
  const maximumDrift = parseDecimal(maximumDriftValue);
  const scale = Math.max(actual.scale, expected.scale, maximumDrift.scale);
  const difference = scaledCoefficient(actual, scale) - scaledCoefficient(expected, scale);
  const absoluteDifference = difference < 0n ? -difference : difference;
  return absoluteDifference > scaledCoefficient(maximumDrift, scale);
}

function multiplyMoneyByOdds(moneyValue, oddsValue) {
  const money = parseDecimal(moneyValue);
  const odds = parseDecimal(oddsValue);
  const coefficient = money.coefficient * odds.coefficient;
  const scale = money.scale + odds.scale;
  let cents;

  if (scale <= 2) {
    cents = coefficient * powerOfTen(2 - scale);
  } else {
    const divisor = powerOfTen(scale - 2);
    const quotient = coefficient / divisor;
    const remainder = coefficient % divisor;
    cents = quotient + (remainder * 2n >= divisor ? 1n : 0n);
  }

  const whole = cents / 100n;
  const fraction = String(cents % 100n).padStart(2, '0');
  return `${whole}.${fraction}`;
}

function normalizeDraftInput(input) {
  if (input === null
    || typeof input !== 'object'
    || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype) {
    invalidInput();
  }

  const keys = Reflect.ownKeys(input);
  if (keys.length !== ALLOWED_FIELDS.length
    || keys.some((key) => typeof key !== 'string' || !ALLOWED_FIELDS.includes(key))) {
    invalidInput();
  }

  if (ALLOWED_FIELDS.some((field) => typeof input[field] !== 'string')) invalidInput();
  if (!ALLOWED_SCOPES.has(input.scope) || !ALLOWED_SPORTS.has(input.sport)) invalidInput();
  if (!/^\d{1,32}$/.test(input.event_id)) invalidInput();
  if (input.selection_key.length === 0 || input.selection_key.length > 500) invalidInput();
  if (input.idempotency_key.length === 0 || input.idempotency_key.length > 200) invalidInput();

  return {
    scope: input.scope,
    sport: input.sport,
    event_id: input.event_id,
    selection_key: input.selection_key,
    stake: normalizeStake(input.stake),
    expected_odds: requireDecimal(input.expected_odds, { positive: true }),
    max_odds_drift: requireDecimal(input.max_odds_drift),
    idempotency_key: input.idempotency_key,
  };
}

module.exports = {
  DraftError,
  decimalDifferenceExceeds,
  multiplyMoneyByOdds,
  normalizeDraftInput,
};
