'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DraftError,
  createDraftStore,
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

test('rejects an accessor that changes after its values pass validation', () => {
  const input = validInput();
  let reads = 0;
  Object.defineProperty(input, 'scope', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return reads < 3 ? 'live' : 'tomorrow';
    },
  });

  assertInvalid(input);
});

test('rejects an accessor without invoking a throwing getter', () => {
  const input = validInput();
  let getterCalled = false;
  Object.defineProperty(input, 'stake', {
    enumerable: true,
    configurable: true,
    get() {
      getterCalled = true;
      throw new Error('getter must not execute');
    },
  });

  assertInvalid(input);
  assert.equal(getterCalled, false);
});

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

function normalizedInput(overrides = {}) {
  return normalizeDraftInput(validInput(overrides));
}

function testStore({ initialNow = 0, ttlMs, maxDrafts } = {}) {
  let milliseconds = initialNow;
  let generatedIds = 0;
  const options = {
    now: () => milliseconds,
    idGenerator: () => `draft-${++generatedIds}`,
  };
  if (ttlMs !== undefined) options.ttlMs = ttlMs;
  if (maxDrafts !== undefined) options.maxDrafts = maxDrafts;

  return {
    store: createDraftStore(options),
    setNow(value) {
      milliseconds = value;
    },
    generatedIds() {
      return generatedIds;
    },
  };
}

test('returns the exact original draft for an identical normalized idempotent replay', () => {
  const { store, generatedIds } = testStore();
  const input = normalizedInput();
  const reorderedInput = Object.fromEntries(Object.entries(input).reverse());
  const original = store.save(input, {
    state: 'ready_for_manual_confirmation',
    proposal: { stake: input.stake },
  });

  assert.strictEqual(store.findReplay(reorderedInput), original);
  assert.strictEqual(store.save(reorderedInput, { state: 'unused' }), original);
  assert.equal(generatedIds(), 1);
});

test('rejects a reused idempotency key with different normalized input', () => {
  const { store } = testStore();
  const idempotencyKey = 'request-data-must-not-leak';
  store.save(normalizedInput({ idempotency_key: idempotencyKey }), { state: 'draft' });

  assert.throws(
    () => store.findReplay(normalizedInput({
      idempotency_key: idempotencyKey,
      stake: '11.00',
    })),
    (error) => error instanceof DraftError
      && error.name === 'DraftError'
      && error.code === 'IDEMPOTENCY_CONFLICT'
      && error.message === 'IDEMPOTENCY_CONFLICT'
      && !error.stack.includes(idempotencyKey),
  );
});

test('keeps a draft live before 120 seconds and expires it exactly at 120 seconds', () => {
  const { store, setNow } = testStore();
  const input = normalizedInput();
  const draft = store.save(input, { state: 'draft' });

  setNow(119_999);
  assert.strictEqual(store.findReplay(input), draft);

  setNow(120_000);
  assert.equal(store.findReplay(input), undefined);
});

test('allows an expired idempotency key to create a new draft', () => {
  const { store, setNow } = testStore();
  const firstInput = normalizedInput();
  const first = store.save(firstInput, { version: 1 });

  setNow(120_000);
  const second = store.save(normalizedInput({ stake: '11.00' }), { version: 2 });

  assert.notStrictEqual(second, first);
  assert.equal(second.draft_id, 'draft-2');
  assert.equal(second.version, 2);
});

test('cleans all expired entries before capacity eviction', () => {
  const { store, setNow } = testStore({ initialNow: 101, ttlMs: 120, maxDrafts: 2 });
  const liveInput = normalizedInput({ idempotency_key: 'live-oldest' });
  const liveDraft = store.save(liveInput, { state: 'live' });

  setNow(0);
  store.save(normalizedInput({ idempotency_key: 'expired-newest' }), { state: 'expires-first' });

  setNow(120);
  store.save(normalizedInput({ idempotency_key: 'new-entry' }), { state: 'new' });

  assert.strictEqual(store.findReplay(liveInput), liveDraft);
});

test('the 1001st live draft evicts the oldest when the default maximum is 1000', () => {
  const { store } = testStore();
  let secondDraft;
  let newestDraft;

  for (let index = 1; index <= 1001; index += 1) {
    const draft = store.save(normalizedInput({ idempotency_key: `request-${index}` }), {
      sequence: index,
    });
    if (index === 2) secondDraft = draft;
    if (index === 1001) newestDraft = draft;
  }

  assert.equal(store.findReplay(normalizedInput({ idempotency_key: 'request-1' })), undefined);
  assert.strictEqual(
    store.findReplay(normalizedInput({ idempotency_key: 'request-2' })),
    secondDraft,
  );
  assert.strictEqual(
    store.findReplay(normalizedInput({ idempotency_key: 'request-1001' })),
    newestDraft,
  );
});

test('stores an immutable detached draft that caller mutation cannot corrupt', () => {
  const { store } = testStore();
  const input = normalizedInput();
  const draftData = {
    state: 'ready_for_manual_confirmation',
    proposal: { stake: '10' },
    notices: ['manual-only'],
  };
  const saved = store.save(input, draftData);

  draftData.proposal.stake = '999999';
  draftData.notices.push('corrupted');

  assert.equal(Object.isFrozen(saved), true);
  assert.equal(Object.isFrozen(saved.proposal), true);
  assert.equal(Object.isFrozen(saved.notices), true);
  assert.throws(() => {
    saved.proposal.stake = '0.01';
  }, TypeError);
  assert.deepEqual(saved.proposal, { stake: '10' });
  assert.deepEqual(saved.notices, ['manual-only']);
  assert.strictEqual(store.findReplay(input), saved);
});

for (const [name, invalidValue] of [
  ['Map', () => new Map([['state', 'mutable']])],
  ['Set', () => new Set(['mutable'])],
  ['Date', () => new Date(0)],
  ['custom-prototype object', () => Object.assign(Object.create({ inherited: true }), {
    state: 'draft',
  })],
  ['cycle', () => {
    const cycle = {};
    cycle.self = cycle;
    return cycle;
  }],
  ['undefined', () => undefined],
  ['function', () => () => 'unsupported'],
  ['symbol', () => Symbol('unsupported')],
  ['bigint', () => 1n],
  ['NaN', () => Number.NaN],
  ['infinity', () => Number.POSITIVE_INFINITY],
]) {
  test(`rejects draft data containing ${name}`, () => {
    const { store } = testStore();

    assert.throws(
      () => store.save(normalizedInput(), { metadata: invalidValue() }),
      (error) => error instanceof DraftError
        && error.code === 'INVALID_DRAFT_DATA'
        && error.message === 'INVALID_DRAFT_DATA',
    );
    assert.equal(store.findReplay(normalizedInput()), undefined);
  });
}

test('rejects accessor-backed draft data without invoking its getter', () => {
  const { store } = testStore();
  let getterCalled = false;
  const draftData = { state: 'draft' };
  Object.defineProperty(draftData, 'metadata', {
    enumerable: true,
    get() {
      getterCalled = true;
      throw new Error('draft-data-must-not-leak');
    },
  });

  assert.throws(
    () => store.save(normalizedInput(), draftData),
    (error) => error instanceof DraftError
      && error.code === 'INVALID_DRAFT_DATA'
      && error.message === 'INVALID_DRAFT_DATA'
      && !error.stack.includes('draft-data-must-not-leak'),
  );
  assert.equal(getterCalled, false);
  assert.equal(store.findReplay(normalizedInput()), undefined);
});

test('rejects invalid draft store construction options with a stable sanitized error', () => {
  const validOptions = {
    now: () => 0,
    idGenerator: () => 'draft-1',
  };
  const invalidOptions = [
    undefined,
    null,
    [],
    {},
    Object.assign(Object.create({ inherited: true }), validOptions),
    { ...validOptions, unexpected: true },
    { ...validOptions, now: 0 },
    { ...validOptions, idGenerator: 'draft-1' },
    ...[0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '120000']
      .map((ttlMs) => ({ ...validOptions, ttlMs })),
    ...[0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1000']
      .map((maxDrafts) => ({ ...validOptions, maxDrafts })),
  ];

  for (const options of invalidOptions) {
    assert.throws(
      () => createDraftStore(options),
      (error) => error instanceof DraftError
        && error.name === 'DraftError'
        && error.code === 'INVALID_DRAFT_STORE_OPTIONS'
        && error.message === 'INVALID_DRAFT_STORE_OPTIONS',
    );
  }
});

test('rejects accessor-backed draft store options without invoking their getters', () => {
  let getterCalled = false;
  const options = {
    idGenerator: () => 'draft-1',
  };
  Object.defineProperty(options, 'now', {
    enumerable: true,
    get() {
      getterCalled = true;
      throw new Error('construction-data-must-not-leak');
    },
  });

  assert.throws(
    () => createDraftStore(options),
    (error) => error instanceof DraftError
      && error.code === 'INVALID_DRAFT_STORE_OPTIONS'
      && error.message === 'INVALID_DRAFT_STORE_OPTIONS'
      && !error.stack.includes('construction-data-must-not-leak'),
  );
  assert.equal(getterCalled, false);
});

test('sanitizes revoked Proxy draft store options', () => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();

  assert.throws(
    () => createDraftStore(proxy),
    (error) => error instanceof DraftError
      && error.name === 'DraftError'
      && error.code === 'INVALID_DRAFT_STORE_OPTIONS'
      && error.message === 'INVALID_DRAFT_STORE_OPTIONS',
  );
});
