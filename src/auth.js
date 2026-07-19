'use strict';

const { createHash, timingSafeEqual } = require('node:crypto');

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

function isTokenEqual(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string') return false;
  return timingSafeEqual(digest(received), digest(expected));
}

function isAuthorized(authorizationHeader, expectedToken) {
  if (typeof authorizationHeader !== 'string' || typeof expectedToken !== 'string') {
    return false;
  }

  const match = /^Bearer +([^\s]+)$/i.exec(authorizationHeader);
  if (!match) {
    return false;
  }

  return isTokenEqual(match[1], expectedToken);
}

module.exports = { isAuthorized, isTokenEqual };
