'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DraftError,
  decimalDifferenceExceeds,
  multiplyMoneyByOdds,
  normalizeDraftInput,
} = require('../src/bet-drafts');

function validInput(overrides = {}) {
  return {
    scope: 'live',
    sport: 'football',
    event_id: '900000001',
    selection_key: '900000001:full_time:1x2:home',
    stake: '10.00',
    expected_odds: '1.9500',
    max_odds_drift: '0.05',
    idempotency_key: 'client-request-1',
    ...overrides,
  };
}

function assertInvalid(input) {
  assert.throws(
    () => normalizeDraftInput(input),
    (error) => error instanceof DraftError
      && error.code === 'INVALID_DRAFT_INPUT',
  );
}

test('normalizes every allowed draft field and canonicalizes decimal strings', () => {
  assert.deepEqual(normalizeDraftInput(validInput({
    stake: '000010.00',
    expected_odds: '001.9500',
    max_odds_drift: '000.0500',
  })), {
    scope: 'live',
    sport: 'football',
    event_id: '900000001',
    selection_key: '900000001:full_time:1x2:home',
    stake: '10',
    expected_odds: '1.95',
    max_odds_drift: '0.05',
    idempotency_key: 'client-request-1',
  });
});

for (const scope of ['live', 'today', 'early']) {
  test(`accepts the ${scope} scope`, () => {
    assert.equal(normalizeDraftInput(validInput({ scope })).scope, scope);
  });
}

for (const sport of ['football', 'basketball', 'tennis']) {
  test(`accepts the ${sport} sport`, () => {
    assert.equal(normalizeDraftInput(validInput({ sport })).sport, sport);
  });
}

for (const [name, overrides] of [
  ['unknown scope', { scope: 'tomorrow' }],
  ['unknown sport', { sport: 'baseball' }],
  ['non-numeric event id', { event_id: 'event-1' }],
  ['empty event id', { event_id: '' }],
  ['event id longer than 32 digits', { event_id: '1'.repeat(33) }],
  ['empty selection key', { selection_key: '' }],
  ['selection key longer than 500 characters', { selection_key: 's'.repeat(501) }],
  ['empty idempotency key', { idempotency_key: '' }],
  ['idempotency key longer than 200 characters', { idempotency_key: 'k'.repeat(201) }],
]) {
  test(`rejects ${name}`, () => assertInvalid(validInput(overrides)));
}

for (const stake of ['0.01', '1', '999999.99', '1000000.00']) {
  test(`accepts stake ${stake}`, () => {
    assert.equal(normalizeDraftInput(validInput({ stake })).stake,
      stake === '1000000.00' ? '1000000' : stake);
  });
}

for (const stake of [
  '0', '-1', '0.001', '1000000.01', '1.', '.5', '+1', '1e2',
  `${'1'.repeat(62)}.00`,
]) {
  test(`rejects invalid stake ${stake}`, () => assertInvalid(validInput({ stake })));
}

for (const [field, values] of [
  ['expected_odds', ['0.01', '1', '0001.2300']],
  ['max_odds_drift', ['0', '0.000', '0001.2300']],
]) {
  for (const value of values) {
    test(`accepts ${field} decimal ${value}`, () => {
      assert.equal(typeof normalizeDraftInput(validInput({ [field]: value }))[field], 'string');
    });
  }
}

for (const [field, values] of [
  ['expected_odds', ['0', '-0.1', '', '1.', '.1', '+1', '1e2', '1'.repeat(65)]],
  ['max_odds_drift', ['-0.1', '', '1.', '.1', '+1', '1e2', '1'.repeat(65)]],
]) {
  for (const value of values) {
    test(`rejects invalid ${field} decimal ${value || '<empty>'}`, () => {
      assertInvalid(validInput({ [field]: value }));
    });
  }
}

for (const field of [
  'scope',
  'sport',
  'event_id',
  'selection_key',
  'stake',
  'expected_odds',
  'max_odds_drift',
  'idempotency_key',
]) {
  test(`rejects missing field ${field}`, () => {
    const input = validInput();
    delete input[field];
    assertInvalid(input);
  });

  test(`rejects a number in place of string field ${field}`, () => {
    assertInvalid(validInput({ [field]: 1 }));
  });
}

test('rejects unknown fields', () => {
  assertInvalid(validInput({ unexpected: 'value' }));
});

for (const [name, input] of [
  ['null', null],
  ['an array', []],
  ['a string', 'draft'],
  ['a number', 1],
  ['an object with a custom prototype', Object.assign(Object.create({ inherited: true }), validInput())],
  ['an object with a null prototype', Object.assign(Object.create(null), validInput())],
  ['a class instance', Object.assign(new (class DraftInput {})(), validInput())],
]) {
  test(`rejects ${name} input`, () => assertInvalid(input));
}

for (const [actual, expected, maximumDrift, exceeds] of [
  ['1.9500', '1.95', '0', false],
  ['2.00', '1.95', '0.0500', false],
  ['2.0001', '1.95', '0.05', true],
  ['1.90', '1.95', '0.05', false],
  ['1.8999', '1.95', '0.05', true],
  ['9007199254740993.000000000000000001', '9007199254740993', '0', true],
]) {
  test(`compares exact decimal drift ${actual} vs ${expected} with limit ${maximumDrift}`, () => {
    assert.equal(decimalDifferenceExceeds(actual, expected, maximumDrift), exceeds);
  });
}

for (const [stake, odds, grossReturn] of [
  ['10.00', '1.9500', '19.50'],
  ['1.00', '1.005', '1.01'],
  ['1.00', '1.0049', '1.00'],
  ['2.00', '1.3375', '2.68'],
  ['0.01', '0.5', '0.01'],
  ['0.01', '0.4999', '0.00'],
  ['0002.500', '02.0000', '5.00'],
]) {
  test(`multiplies ${stake} by ${odds} and rounds half-up to ${grossReturn}`, () => {
    assert.equal(multiplyMoneyByOdds(stake, odds), grossReturn);
  });
}
