'use strict';

const { CODES, upstreamError } = require('../../upstream/errors');

const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const CURRENCY_PATTERN = /^[A-Z0-9]{2,12}$/;

function schemaError(message = 'Browser page schema changed') {
  return upstreamError(CODES.SCHEMA_CHANGED, message);
}

function authError(message = 'Browser authentication expired') {
  return upstreamError(CODES.AUTH_EXPIRED, message);
}

function requiredText(value) {
  if (typeof value !== 'string' || value.trim().length === 0) throw schemaError();
  return value.trim();
}

function currency(value) {
  const normalized = requiredText(value).toUpperCase();
  if (!CURRENCY_PATTERN.test(normalized)) throw schemaError();
  return normalized;
}

function significantDigits(decimal) {
  const digits = decimal.replace('.', '').replace(/^0+/, '').replace(/0+$/, '');
  return digits.length || 1;
}

function publicDecimal(value) {
  const decimal = requiredText(value);
  if (!DECIMAL_PATTERN.test(decimal)) throw schemaError();
  const numeric = Number(decimal);
  if (!Number.isFinite(numeric)) throw schemaError();
  return significantDigits(decimal) <= 15 ? numeric : decimal;
}

module.exports = { authError, currency, publicDecimal, requiredText, schemaError };
