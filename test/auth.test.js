const test = require('node:test');
const assert = require('node:assert/strict');

const { isAuthorized } = require('../src/auth');

const expectedToken = 'expected-token-that-is-at-least-32-characters';

test('isAuthorized rejects a missing Authorization header', () => {
  assert.equal(isAuthorized(undefined, expectedToken), false);
});

test('isAuthorized rejects an authorization scheme other than Bearer', () => {
  assert.equal(isAuthorized(`Basic ${expectedToken}`, expectedToken), false);
});

test('isAuthorized rejects the wrong bearer token without echoing it', () => {
  const receivedToken = 'wrong-token-that-must-never-be-returned';
  assert.equal(isAuthorized(`Bearer ${receivedToken}`, expectedToken), false);
});

test('isAuthorized accepts the correct bearer token', () => {
  assert.equal(isAuthorized(`Bearer ${expectedToken}`, expectedToken), true);
});

test('isAuthorized accepts one or more ASCII spaces between scheme and token', () => {
  assert.equal(isAuthorized(`Bearer    ${expectedToken}`, expectedToken), true);
});

for (const [name, header] of [
  ['an empty credential', 'Bearer '],
  ['trailing whitespace', `Bearer ${expectedToken} `],
  ['embedded whitespace', 'Bearer expected token'],
  ['a tab separator', `Bearer\t${expectedToken}`],
]) {
  test(`isAuthorized rejects ${name}`, () => {
    assert.equal(isAuthorized(header, expectedToken), false);
  });
}

test('isAuthorized safely compares bearer tokens with different source lengths', () => {
  assert.doesNotThrow(() => isAuthorized('Bearer x', expectedToken));
  assert.equal(isAuthorized('Bearer x', expectedToken), false);
});
