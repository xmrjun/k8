'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const {
  DraftError,
  createBetDraftService,
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

test('rejects repeated draft references to keep stored data tree-shaped', () => {
  const { store } = testStore();
  const shared = { value: 'shared' };

  assert.throws(
    () => store.save(normalizedInput(), { left: shared, right: shared }),
    (error) => error instanceof DraftError
      && error.code === 'INVALID_DRAFT_DATA'
      && error.message === 'INVALID_DRAFT_DATA',
  );
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

test('rejects a draft TTL above the 120-second hard limit', () => {
  const options = {
    now: () => 0,
    idGenerator: () => 'draft-1',
  };

  assert.doesNotThrow(() => createDraftStore({ ...options, ttlMs: 120_000 }));
  assert.throws(
    () => createDraftStore({ ...options, ttlMs: 120_001 }),
    (error) => error instanceof DraftError
      && error.code === 'INVALID_DRAFT_STORE_OPTIONS'
      && error.message === 'INVALID_DRAFT_STORE_OPTIONS',
  );
});

test('rejects a draft capacity above the 1000-entry hard limit', () => {
  const options = {
    now: () => 0,
    idGenerator: () => 'draft-1',
  };

  assert.doesNotThrow(() => createDraftStore({ ...options, maxDrafts: 1000 }));
  assert.throws(
    () => createDraftStore({ ...options, maxDrafts: 1001 }),
    (error) => error instanceof DraftError
      && error.code === 'INVALID_DRAFT_STORE_OPTIONS'
      && error.message === 'INVALID_DRAFT_STORE_OPTIONS',
  );
});

test('rejects invalid millisecond clock values on every store operation', () => {
  for (const clockValue of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const store = createDraftStore({
      now: () => clockValue,
      idGenerator: () => 'draft-1',
    });
    const assertInvalidClock = (operation) => assert.throws(
      operation,
      (error) => error instanceof DraftError
        && error.code === 'INVALID_DRAFT_STORE_OPTIONS'
        && error.message === 'INVALID_DRAFT_STORE_OPTIONS',
    );

    assertInvalidClock(() => store.findReplay(normalizedInput()));
    assertInvalidClock(() => store.save(normalizedInput(), { state: 'draft' }));
  }
});

test('rejects an expiry timestamp outside the safe integer range', () => {
  const store = createDraftStore({
    now: () => Number.MAX_SAFE_INTEGER,
    idGenerator: () => 'draft-1',
    ttlMs: 1,
  });

  assert.throws(
    () => store.save(normalizedInput(), { state: 'draft' }),
    (error) => error instanceof DraftError
      && error.code === 'INVALID_DRAFT_STORE_OPTIONS'
      && error.message === 'INVALID_DRAFT_STORE_OPTIONS',
  );
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

function sportsSnapshot({
  eventId = '900000001',
  eventScope = 'live',
  eventSport = 'football',
  selectionKey = '900000001:full_time:1x2:home',
  selectionName = 'home',
  decimalOdds = '1.98',
  displayOdds = '0.98',
  available = true,
} = {}) {
  const selection = {
    selection_key: selectionKey,
    name: selectionName,
    odds_format: 'hong_kong',
    available,
  };
  if (available) {
    selection.display_odds = displayOdds;
    selection.decimal_odds = decimalOdds;
  }
  return {
    events: [{
      event_id: eventId,
      sport: eventSport,
      scope: eventScope,
      league: 'Premier League',
      home: 'Home FC',
      away: 'Away FC',
      score: { home: 1, away: 0 },
      clock: '67:12',
      markets: [{
        period: 'full_time',
        type: '1x2',
        selections: [selection],
      }],
    }],
    count: 1,
    truncated: false,
  };
}

function sportsEvent(eventId) {
  const event = structuredClone(sportsSnapshot().events[0]);
  event.event_id = eventId;
  for (const market of event.markets) {
    for (const selection of market.selections) {
      const parts = selection.selection_key.split(':');
      parts[0] = eventId;
      selection.selection_key = parts.join(':');
    }
  }
  return event;
}

function sportsMarket(eventId, period, type) {
  const selectionNames = {
    '1x2': 'home',
    moneyline: 'home',
    handicap: 'home',
    total: 'over',
    odd_even: 'odd',
  };
  const name = selectionNames[type];
  const selection = {
    selection_key: `${eventId}:${period}:${type}:${name}`,
    name,
    display_odds: '0.98',
    odds_format: 'hong_kong',
    decimal_odds: '1.98',
    available: true,
  };
  if (type === 'handicap') selection.line = '0';
  if (type === 'total') selection.line = '2.5';
  return { period, type, selections: [selection] };
}

function testService({
  snapshot = sportsSnapshot(),
  initialNow = Date.parse('2026-07-20T01:02:03.000Z'),
  ttlMs,
  maxDrafts,
  getSports,
} = {}) {
  let milliseconds = initialNow;
  let generatedIds = 0;
  const calls = [];
  const upstream = {
    async getSports(options) {
      calls.push(options);
      if (getSports) return getSports(options);
      return snapshot;
    },
  };
  const options = {
    upstream,
    now: () => milliseconds,
    idGenerator: () => `verified-draft-${++generatedIds}`,
  };
  if (ttlMs !== undefined) options.ttlMs = ttlMs;
  if (maxDrafts !== undefined) options.maxDrafts = maxDrafts;

  return {
    service: createBetDraftService(options),
    calls,
    generatedIds: () => generatedIds,
    setNow(value) {
      milliseconds = value;
    },
  };
}

function assertDraftError(code) {
  return (error) => error instanceof DraftError
    && error.name === 'DraftError'
    && error.code === code
    && error.message === code;
}

test('creates an immutable manual-confirmation draft from a fresh real-shaped snapshot', async () => {
  const { service, calls } = testService();

  const draft = await service.create(validInput());

  assert.deepEqual(calls, [{ scope: 'live', sport: 'football' }]);
  assert.deepEqual(draft, {
    state: 'ready_for_manual_confirmation',
    scope: 'live',
    sport: 'football',
    event_id: '900000001',
    selection_key: '900000001:full_time:1x2:home',
    stake: '10',
    expected_odds: '1.95',
    current_odds: '1.98',
    max_odds_drift: '0.05',
    odds_changed: true,
    projected_gross_return: '19.80',
    created_at: '2026-07-20T01:02:03.000Z',
    expires_at: '2026-07-20T01:04:03.000Z',
    draft_id: 'verified-draft-1',
  });
  assert.equal(Object.isFrozen(draft), true);
  assert.throws(() => {
    draft.stake = '999';
  }, TypeError);
});

test('allows current odds drift exactly equal to the configured maximum', async () => {
  const { service } = testService({
    snapshot: sportsSnapshot({ decimalOdds: '2.0000', displayOdds: '1.0000' }),
  });

  const draft = await service.create(validInput());

  assert.equal(draft.current_odds, '2');
  assert.equal(draft.odds_changed, true);
});

test('allows current odds drift below the configured maximum', async () => {
  const { service } = testService({
    snapshot: sportsSnapshot({ decimalOdds: '1.91', displayOdds: '0.91' }),
  });

  assert.equal((await service.create(validInput())).current_odds, '1.91');
});

test('rejects current odds drift above the configured maximum', async () => {
  const { service } = testService({
    snapshot: sportsSnapshot({ decimalOdds: '2.0001', displayOdds: '1.0001' }),
  });

  await assert.rejects(service.create(validInput()), assertDraftError('ODDS_DRIFT_EXCEEDED'));
});

test('treats canonically equal odds as unchanged', async () => {
  const { service } = testService({
    snapshot: sportsSnapshot({ decimalOdds: '1.9500', displayOdds: '0.9500' }),
  });

  const draft = await service.create(validInput());

  assert.equal(draft.current_odds, '1.95');
  assert.equal(draft.expected_odds, '1.95');
  assert.equal(draft.odds_changed, false);
});

test('calculates projected gross return from current odds with exact half-up rounding', async () => {
  const { service } = testService({
    snapshot: sportsSnapshot({ decimalOdds: '1.005', displayOdds: '0.005' }),
  });

  const draft = await service.create(validInput({
    stake: '1.00',
    expected_odds: '1.00',
    max_odds_drift: '0.005',
  }));

  assert.equal(draft.projected_gross_return, '1.01');
});

test('accepts zero Hong Kong display odds paired with decimal odds one', async () => {
  const { service } = testService({
    snapshot: sportsSnapshot({ displayOdds: '0', decimalOdds: '1' }),
  });

  const draft = await service.create(validInput({
    expected_odds: '1',
    max_odds_drift: '0',
  }));

  assert.equal(draft.current_odds, '1');
});

test('rejects display and decimal odds that do not differ by exactly one', async () => {
  const { service } = testService({
    snapshot: sportsSnapshot({ displayOdds: '0.25', decimalOdds: '1.98' }),
  });

  await assert.rejects(
    service.create(validInput()),
    assertDraftError('MALFORMED_CURRENT_SNAPSHOT'),
  );
});

test('accepts an exact odds relationship across different trailing-zero scales', async () => {
  const { service } = testService({
    snapshot: sportsSnapshot({ displayOdds: '0.2500', decimalOdds: '1.25' }),
  });

  const draft = await service.create(validInput({
    expected_odds: '1.25',
    max_odds_drift: '0',
  }));

  assert.equal(draft.current_odds, '1.25');
});

test('fails closed when the requested event is missing', async () => {
  const { service } = testService({
    snapshot: { events: [], count: 0, truncated: false },
  });

  await assert.rejects(service.create(validInput()), assertDraftError('EVENT_UNAVAILABLE'));
});

test('fails closed when the requested event appears more than once', async () => {
  const event = sportsSnapshot().events[0];
  const { service } = testService({
    snapshot: { events: [event, structuredClone(event)], count: 2, truncated: false },
  });

  await assert.rejects(service.create(validInput()), assertDraftError('EVENT_UNAVAILABLE'));
});

test('fails closed when the requested selection is missing', async () => {
  const { service } = testService({
    snapshot: sportsSnapshot({
      selectionKey: '900000001:full_time:1x2:away',
      selectionName: 'away',
    }),
  });

  await assert.rejects(service.create(validInput()), assertDraftError('SELECTION_UNAVAILABLE'));
});

test('fails closed when the requested selection appears more than once in its event', async () => {
  const snapshot = sportsSnapshot();
  snapshot.events[0].markets[0].selections.push({
    selection_key: validInput().selection_key,
    name: 'home',
    display_odds: '0.98',
    odds_format: 'hong_kong',
    decimal_odds: '1.98',
    available: true,
  });
  const { service } = testService({ snapshot });

  await assert.rejects(service.create(validInput()), assertDraftError('SELECTION_UNAVAILABLE'));
});

test('fails closed when the requested selection is locked', async () => {
  const snapshot = sportsSnapshot({ available: false, decimalOdds: undefined });
  const { service } = testService({ snapshot });

  await assert.rejects(service.create(validInput()), assertDraftError('SELECTION_UNAVAILABLE'));
});

test('rejects a matching event from a different scope', async () => {
  const { service } = testService({
    snapshot: sportsSnapshot({ eventScope: 'early' }),
  });

  await assert.rejects(
    service.create(validInput()),
    assertDraftError('MALFORMED_CURRENT_SNAPSHOT'),
  );
});

test('rejects a matching event from a different sport', async () => {
  const { service } = testService({
    snapshot: sportsSnapshot({ eventSport: 'tennis' }),
  });

  await assert.rejects(
    service.create(validInput()),
    assertDraftError('MALFORMED_CURRENT_SNAPSHOT'),
  );
});

for (const [name, mutate] of [
  ['missing count', (snapshot) => { delete snapshot.count; }],
  ['missing truncated flag', (snapshot) => { delete snapshot.truncated; }],
  ['count unequal to events length', (snapshot) => { snapshot.count = 0; }],
  ['non-boolean truncated flag', (snapshot) => { snapshot.truncated = 'false'; }],
  ['truncated true below the reader limit', (snapshot) => { snapshot.truncated = true; }],
]) {
  test(`rejects snapshot metadata with ${name}`, async () => {
    const snapshot = sportsSnapshot();
    mutate(snapshot);
    const { service } = testService({ snapshot });

    await assert.rejects(
      service.create(validInput()),
      assertDraftError('MALFORMED_CURRENT_SNAPSHOT'),
    );
  });
}

for (const [name, mutate] of [
  ['missing event league', (snapshot) => { delete snapshot.events[0].league; }],
  ['non-numeric event id', (snapshot) => { snapshot.events[0].event_id = 'event-1'; }],
  ['empty event home', (snapshot) => { snapshot.events[0].home = ''; }],
  ['invalid event score', (snapshot) => { snapshot.events[0].score.home = -1; }],
  ['invalid event clock', (snapshot) => { snapshot.events[0].clock = ''; }],
  ['missing market period', (snapshot) => { delete snapshot.events[0].markets[0].period; }],
  ['unknown market type', (snapshot) => { snapshot.events[0].markets[0].type = 'winner'; }],
  ['missing selection name', (snapshot) => {
    delete snapshot.events[0].markets[0].selections[0].name;
  }],
  ['missing selection odds format', (snapshot) => {
    delete snapshot.events[0].markets[0].selections[0].odds_format;
  }],
  ['missing selection display odds', (snapshot) => {
    delete snapshot.events[0].markets[0].selections[0].display_odds;
  }],
  ['malformed selection display odds', (snapshot) => {
    snapshot.events[0].markets[0].selections[0].display_odds = 'private-odds';
  }],
]) {
  test(`rejects real-shaped snapshot with ${name}`, async () => {
    const snapshot = sportsSnapshot();
    mutate(snapshot);
    const { service } = testService({ snapshot });

    await assert.rejects(
      service.create(validInput()),
      assertDraftError('MALFORMED_CURRENT_SNAPSHOT'),
    );
  });
}

test('rejects a selection key inconsistent with its event and market identity', async () => {
  const { service } = testService({
    snapshot: sportsSnapshot({ selectionName: 'away' }),
  });

  await assert.rejects(
    service.create(validInput()),
    assertDraftError('MALFORMED_CURRENT_SNAPSHOT'),
  );
});

test('rejects a selection name unsupported by its market type', async () => {
  const snapshot = sportsSnapshot({
    selectionKey: '900000001:full_time:1x2:over',
    selectionName: 'over',
  });
  const { service } = testService({ snapshot });

  await assert.rejects(
    service.create(validInput({ selection_key: '900000001:full_time:1x2:over' })),
    assertDraftError('MALFORMED_CURRENT_SNAPSHOT'),
  );
});

test('rejects a line market selection without its required line', async () => {
  const snapshot = sportsSnapshot({
    selectionKey: '900000001:full_time:handicap:home',
  });
  snapshot.events[0].markets[0].type = 'handicap';
  const { service } = testService({ snapshot });

  await assert.rejects(
    service.create(validInput({ selection_key: '900000001:full_time:handicap:home' })),
    assertDraftError('MALFORMED_CURRENT_SNAPSHOT'),
  );
});

test('accepts a complete line-market selection from the normalized reader shape', async () => {
  const snapshot = sportsSnapshot({
    selectionKey: '900000001:full_time:total:over',
    selectionName: 'over',
  });
  snapshot.events[0].markets[0].type = 'total';
  snapshot.events[0].markets[0].selections[0].line = '2.5/3';
  const { service } = testService({ snapshot });

  const draft = await service.create(validInput({
    selection_key: '900000001:full_time:total:over',
  }));

  assert.equal(draft.selection_key, '900000001:full_time:total:over');
});

test('validates malformed nonmatching events before selecting the requested event', async () => {
  const snapshot = sportsSnapshot();
  const otherEvent = structuredClone(snapshot.events[0]);
  otherEvent.event_id = '900000002';
  otherEvent.markets[0].selections[0].selection_key = '900000002:full_time:1x2:home';
  delete otherEvent.home;
  snapshot.events.push(otherEvent);
  snapshot.count = 2;
  const { service } = testService({ snapshot });

  await assert.rejects(
    service.create(validInput()),
    assertDraftError('MALFORMED_CURRENT_SNAPSHOT'),
  );
});

test('rejects a duplicated nonmatching event id', async () => {
  const snapshot = sportsSnapshot();
  const otherEvent = sportsEvent('900000002');
  snapshot.events.push(otherEvent, structuredClone(otherEvent));
  snapshot.count = 3;
  const { service } = testService({ snapshot });

  await assert.rejects(
    service.create(validInput()),
    assertDraftError('MALFORMED_CURRENT_SNAPSHOT'),
  );
});

test('rejects a duplicated selection key in a nonmatching event', async () => {
  const snapshot = sportsSnapshot();
  const otherEvent = sportsEvent('900000002');
  otherEvent.markets[0].selections.push(
    structuredClone(otherEvent.markets[0].selections[0]),
  );
  snapshot.events.push(otherEvent);
  snapshot.count = 2;
  const { service } = testService({ snapshot });

  await assert.rejects(
    service.create(validInput()),
    assertDraftError('MALFORMED_CURRENT_SNAPSHOT'),
  );
});

test('rejects a duplicated market identity in a nonmatching event', async () => {
  const snapshot = sportsSnapshot();
  const otherEvent = sportsEvent('900000002');
  otherEvent.markets.push(structuredClone(otherEvent.markets[0]));
  snapshot.events.push(otherEvent);
  snapshot.count = 2;
  const { service } = testService({ snapshot });

  await assert.rejects(
    service.create(validInput()),
    assertDraftError('MALFORMED_CURRENT_SNAPSHOT'),
  );
});

test('sanitizes an accessor-backed current snapshot without invoking its getter', async () => {
  const snapshot = sportsSnapshot();
  let getterCalled = false;
  Object.defineProperty(snapshot.events[0], 'league', {
    enumerable: true,
    get() {
      getterCalled = true;
      throw new Error('private-snapshot-detail');
    },
  });
  const { service } = testService({ snapshot });

  await assert.rejects(
    service.create(validInput()),
    assertDraftError('MALFORMED_CURRENT_SNAPSHOT'),
  );
  assert.equal(getterCalled, false);
});

test('rejects a non-plain current snapshot with the sanitized snapshot error', async () => {
  const snapshot = Object.assign(Object.create({ inherited: true }), sportsSnapshot());
  const { service } = testService({ snapshot });

  await assert.rejects(
    service.create(validInput()),
    assertDraftError('MALFORMED_CURRENT_SNAPSHOT'),
  );
});

test('sanitizes a revoked Proxy nested in the current snapshot', async () => {
  const snapshot = sportsSnapshot();
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  snapshot.events[0] = proxy;
  const { service } = testService({ snapshot });

  await assert.rejects(
    service.create(validInput()),
    assertDraftError('MALFORMED_CURRENT_SNAPSHOT'),
  );
});

test('rejects 501 events before traversing the oversized snapshot', async () => {
  const snapshot = sportsSnapshot();
  snapshot.events = Array.from(
    { length: 501 },
    (_, index) => sportsEvent(String(900000001 + index)),
  );
  snapshot.count = snapshot.events.length;
  const { service } = testService({ snapshot });
  const startedAt = performance.now();

  await assert.rejects(
    service.create(validInput()),
    assertDraftError('MALFORMED_CURRENT_SNAPSHOT'),
  );
  assert.ok(performance.now() - startedAt < 100);
});

test('rejects an event containing more than eight markets', async () => {
  const snapshot = sportsSnapshot();
  snapshot.events[0].markets = [
    sportsMarket('900000001', 'full_time', '1x2'),
    sportsMarket('900000001', 'full_time', 'moneyline'),
    sportsMarket('900000001', 'full_time', 'handicap'),
    sportsMarket('900000001', 'full_time', 'total'),
    sportsMarket('900000001', 'full_time', 'odd_even'),
    sportsMarket('900000001', 'first_half', '1x2'),
    sportsMarket('900000001', 'first_half', 'moneyline'),
    sportsMarket('900000001', 'first_half', 'handicap'),
    sportsMarket('900000001', 'first_half', 'total'),
  ];
  const { service } = testService({ snapshot });

  await assert.rejects(
    service.create(validInput()),
    assertDraftError('MALFORMED_CURRENT_SNAPSHOT'),
  );
});

test('rejects a market containing more than three selections', async () => {
  const snapshot = sportsSnapshot();
  snapshot.events[0].markets[0].selections.push(
    {
      ...structuredClone(snapshot.events[0].markets[0].selections[0]),
      selection_key: '900000001:full_time:1x2:draw',
      name: 'draw',
    },
    {
      ...structuredClone(snapshot.events[0].markets[0].selections[0]),
      selection_key: '900000001:full_time:1x2:away',
      name: 'away',
    },
    {
      ...structuredClone(snapshot.events[0].markets[0].selections[0]),
      selection_key: '900000001:full_time:1x2:away',
      name: 'away',
    },
  );
  const { service } = testService({ snapshot });

  await assert.rejects(
    service.create(validInput()),
    assertDraftError('MALFORMED_CURRENT_SNAPSHOT'),
  );
});

test('rejects a huge unknown snapshot field without traversing its contents', async () => {
  const snapshot = sportsSnapshot();
  snapshot.irrelevant = { rows: new Array(100_000).fill('private') };
  const { service } = testService({ snapshot });
  const startedAt = performance.now();

  await assert.rejects(
    service.create(validInput()),
    assertDraftError('MALFORMED_CURRENT_SNAPSHOT'),
  );
  assert.ok(performance.now() - startedAt < 100);
});

test('does not inspect a Proxy stored in an unknown snapshot field', async () => {
  const snapshot = sportsSnapshot();
  let proxyInspected = false;
  snapshot.irrelevant = new Proxy({}, {
    getPrototypeOf() {
      proxyInspected = true;
      throw new Error('private-unknown-field');
    },
  });
  const { service } = testService({ snapshot });

  await assert.rejects(
    service.create(validInput()),
    assertDraftError('MALFORMED_CURRENT_SNAPSHOT'),
  );
  assert.equal(proxyInspected, false);
});

for (const [name, mutate] of [
  ['event', (snapshot) => { snapshot.events[0].unexpected = 'value'; }],
  ['score', (snapshot) => { snapshot.events[0].score.unexpected = 1; }],
  ['market', (snapshot) => { snapshot.events[0].markets[0].unexpected = 'value'; }],
  ['selection', (snapshot) => {
    snapshot.events[0].markets[0].selections[0].unexpected = 'value';
  }],
  ['oversized event text', (snapshot) => { snapshot.events[0].league = 'x'.repeat(501); }],
]) {
  test(`rejects an unknown or unbounded ${name} snapshot field`, async () => {
    const snapshot = sportsSnapshot();
    mutate(snapshot);
    const { service } = testService({ snapshot });

    await assert.rejects(
      service.create(validInput()),
      assertDraftError('MALFORMED_CURRENT_SNAPSHOT'),
    );
  });
}

for (const [name, snapshot] of [
  ['missing events array', {}],
  ['non-array markets', { events: [{ event_id: '900000001', markets: {} }] }],
  ['non-array selections', {
    events: [{ event_id: '900000001', markets: [{ selections: null }] }],
  }],
  ['malformed current odds', sportsSnapshot({ decimalOdds: 'not-private-odds' })],
  ['non-positive current odds', sportsSnapshot({ decimalOdds: '0' })],
  ['malformed availability', sportsSnapshot({ available: 'true' })],
]) {
  test(`rejects ${name} with a sanitized malformed-snapshot error`, async () => {
    const { service } = testService({ snapshot });

    await assert.rejects(
      service.create(validInput()),
      assertDraftError('MALFORMED_CURRENT_SNAPSHOT'),
    );
  });
}

test('propagates an upstream rejection unchanged', async () => {
  const upstreamFailure = Object.assign(new Error('private-upstream-detail'), {
    code: 'UPSTREAM_TIMEOUT',
  });
  const { service } = testService({
    getSports: async () => {
      throw upstreamFailure;
    },
  });

  await assert.rejects(service.create(validInput()), (error) => error === upstreamFailure);
});

test('default draft timestamps match the store expiry boundary exactly', async () => {
  const createdAt = Date.parse('2026-07-20T01:02:03.000Z');
  const { service, calls, setNow } = testService({ initialNow: createdAt });
  const input = validInput();
  const draft = await service.create(input);

  assert.equal(Date.parse(draft.expires_at) - Date.parse(draft.created_at), 120_000);
  setNow(createdAt + 119_999);
  assert.strictEqual(await service.create(input), draft);
  setNow(createdAt + 120_000);
  assert.notStrictEqual(await service.create(input), draft);
  assert.equal(calls.length, 2);
});

test('custom TTL controls both returned timestamps and replay expiry', async () => {
  const createdAt = Date.parse('2026-07-20T01:02:03.000Z');
  const { service, calls, setNow } = testService({ initialNow: createdAt, ttlMs: 10_000 });
  const input = validInput();
  const draft = await service.create(input);

  assert.equal(Date.parse(draft.expires_at) - Date.parse(draft.created_at), 10_000);
  setNow(createdAt + 10_000);
  await service.create(input);
  assert.equal(calls.length, 2);
});

test('identical live replay returns the exact original draft without a second upstream read', async () => {
  const { service, calls, generatedIds } = testService();
  const first = await service.create(validInput());
  const second = await service.create(validInput({
    stake: '010.0',
    expected_odds: '01.950',
    max_odds_drift: '00.050',
  }));

  assert.strictEqual(second, first);
  assert.equal(calls.length, 1);
  assert.equal(generatedIds(), 1);
});

test('idempotency conflict occurs before a second upstream read', async () => {
  const { service, calls } = testService();
  await service.create(validInput());

  await assert.rejects(
    service.create(validInput({ stake: '11.00' })),
    assertDraftError('IDEMPOTENCY_CONFLICT'),
  );
  assert.equal(calls.length, 1);
});

test('rejects unsafe service construction options with a fixed sanitized error', () => {
  const validOptions = {
    upstream: { async getSports() { return sportsSnapshot(); } },
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
    { ...validOptions, upstream: null },
    { ...validOptions, upstream: {} },
    { ...validOptions, upstream: { getSports: true } },
    { ...validOptions, now: 0 },
    { ...validOptions, idGenerator: 'draft-1' },
    { ...validOptions, ttlMs: 120_001 },
    { ...validOptions, maxDrafts: 1001 },
  ];

  for (const options of invalidOptions) {
    assert.throws(
      () => createBetDraftService(options),
      assertDraftError('INVALID_DRAFT_SERVICE_OPTIONS'),
    );
  }
});

test('rejects accessor-backed service options without invoking getters', () => {
  let getterCalled = false;
  const options = {
    upstream: { async getSports() { return sportsSnapshot(); } },
    idGenerator: () => 'draft-1',
  };
  Object.defineProperty(options, 'now', {
    enumerable: true,
    get() {
      getterCalled = true;
      throw new Error('private-construction-detail');
    },
  });

  assert.throws(
    () => createBetDraftService(options),
    assertDraftError('INVALID_DRAFT_SERVICE_OPTIONS'),
  );
  assert.equal(getterCalled, false);
});

test('rejects an upstream whose getSports method is prototype-backed', () => {
  class SportsUpstream {
    async getSports() {
      return sportsSnapshot();
    }
  }

  assert.throws(
    () => createBetDraftService({
      upstream: new SportsUpstream(),
      now: () => 0,
      idGenerator: () => 'draft-1',
    }),
    assertDraftError('INVALID_DRAFT_SERVICE_OPTIONS'),
  );
});

test('ignores a getSports function injected through Object.prototype', () => {
  Object.defineProperty(Object.prototype, 'getSports', {
    configurable: true,
    value: async () => sportsSnapshot(),
  });
  try {
    assert.throws(
      () => createBetDraftService({
        upstream: {},
        now: () => 0,
        idGenerator: () => 'draft-1',
      }),
      assertDraftError('INVALID_DRAFT_SERVICE_OPTIONS'),
    );
  } finally {
    delete Object.prototype.getSports;
  }
});

test('rejects an accessor-backed upstream without invoking getSports', () => {
  let getterCalled = false;
  const upstream = {};
  Object.defineProperty(upstream, 'getSports', {
    enumerable: true,
    get() {
      getterCalled = true;
      throw new Error('private-upstream-getter');
    },
  });

  assert.throws(
    () => createBetDraftService({
      upstream,
      now: () => 0,
      idGenerator: () => 'draft-1',
    }),
    assertDraftError('INVALID_DRAFT_SERVICE_OPTIONS'),
  );
  assert.equal(getterCalled, false);
});

test('sanitizes an upstream Proxy descriptor failure', () => {
  const upstream = new Proxy({}, {
    getOwnPropertyDescriptor() {
      throw new Error('private-upstream-proxy');
    },
  });

  assert.throws(
    () => createBetDraftService({
      upstream,
      now: () => 0,
      idGenerator: () => 'draft-1',
    }),
    assertDraftError('INVALID_DRAFT_SERVICE_OPTIONS'),
  );
});

test('rejects a self-referential upstream prototype Proxy within 500ms', () => {
  const modulePath = require.resolve('../src/bet-drafts');
  const script = `
    const { createBetDraftService } = require(${JSON.stringify(modulePath)});
    let upstream;
    upstream = new Proxy({}, { getPrototypeOf: () => upstream });
    try {
      createBetDraftService({
        upstream,
        now: () => 0,
        idGenerator: () => 'draft-1',
      });
      process.exit(2);
    } catch (error) {
      process.exit(error?.code === 'INVALID_DRAFT_SERVICE_OPTIONS' ? 0 : 3);
    }
  `;

  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 500,
  });

  assert.equal(result.status, 0, result.error?.code || result.stderr);
});

test('sanitizes an invalid clock value returned after the upstream read', async () => {
  let clockReads = 0;
  const service = createBetDraftService({
    upstream: { async getSports() { return sportsSnapshot(); } },
    now: () => (++clockReads === 1 ? 0 : 0n),
    idGenerator: () => 'draft-1',
  });

  await assert.rejects(
    service.create(validInput()),
    assertDraftError('INVALID_DRAFT_SERVICE_OPTIONS'),
  );
});
