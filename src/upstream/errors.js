'use strict';

const CODES = Object.freeze({
  AUTH_EXPIRED: 'UPSTREAM_AUTH_EXPIRED',
  TIMEOUT: 'UPSTREAM_TIMEOUT',
  BAD_RESPONSE: 'UPSTREAM_BAD_RESPONSE',
  SCHEMA_CHANGED: 'UPSTREAM_SCHEMA_CHANGED',
});

class UpstreamError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UpstreamError';
    this.code = code;
  }
}

function upstreamError(code, message) {
  return new UpstreamError(code, message);
}

module.exports = { CODES, UpstreamError, upstreamError };
