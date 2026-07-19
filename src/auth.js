'use strict';

const { createHash, timingSafeEqual } = require('node:crypto');

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

function isAuthorized(authorizationHeader, expectedToken) {
  if (typeof authorizationHeader !== 'string' || typeof expectedToken !== 'string') {
    return false;
  }

  const match = /^Bearer +([^\s]+)$/i.exec(authorizationHeader);
  if (!match) {
    return false;
  }

  return timingSafeEqual(digest(match[1]), digest(expectedToken));
}

module.exports = { isAuthorized };
