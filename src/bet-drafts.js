'use strict';

const INVALID_DRAFT_INPUT = 'INVALID_DRAFT_INPUT';
const INVALID_DRAFT_DATA = 'INVALID_DRAFT_DATA';
const INVALID_DRAFT_STORE_OPTIONS = 'INVALID_DRAFT_STORE_OPTIONS';
const INVALID_DRAFT_SERVICE_OPTIONS = 'INVALID_DRAFT_SERVICE_OPTIONS';
const IDEMPOTENCY_CONFLICT = 'IDEMPOTENCY_CONFLICT';
const MALFORMED_CURRENT_SNAPSHOT = 'MALFORMED_CURRENT_SNAPSHOT';
const EVENT_UNAVAILABLE = 'EVENT_UNAVAILABLE';
const SELECTION_UNAVAILABLE = 'SELECTION_UNAVAILABLE';
const ODDS_DRIFT_EXCEEDED = 'ODDS_DRIFT_EXCEEDED';
const DEFAULT_DRAFT_TTL_MS = 120_000;
const DEFAULT_MAX_DRAFTS = 1000;
const DRAFT_STORE_OPTION_FIELDS = Object.freeze([
  'now',
  'idGenerator',
  'ttlMs',
  'maxDrafts',
]);
const DRAFT_SERVICE_OPTION_FIELDS = Object.freeze([
  'upstream',
  ...DRAFT_STORE_OPTION_FIELDS,
]);
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
const CURRENT_DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const CURRENT_EVENT_ID_PATTERN = /^\d{1,32}$/;
const CURRENT_LINE_PATTERN = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:\/(?:0|[1-9]\d*)(?:\.\d+)?)?$/;
const CURRENT_PERIODS = new Set(['full_time', 'first_half']);
const CURRENT_MARKET_SELECTIONS = Object.freeze({
  '1x2': new Set(['home', 'draw', 'away']),
  moneyline: new Set(['home', 'away']),
  handicap: new Set(['home', 'away']),
  total: new Set(['over', 'under']),
  odd_even: new Set(['odd', 'even']),
});
const CURRENT_SNAPSHOT_FIELDS = Object.freeze(['events', 'count', 'truncated']);
const CURRENT_EVENT_FIELDS = Object.freeze([
  'event_id',
  'sport',
  'scope',
  'league',
  'home',
  'away',
  'score',
  'clock',
  'markets',
]);
const CURRENT_SCORE_FIELDS = Object.freeze(['home', 'away']);
const CURRENT_MARKET_FIELDS = Object.freeze(['period', 'type', 'selections']);
const CURRENT_SELECTION_FIELDS = Object.freeze([
  'selection_key',
  'name',
  'line',
  'display_odds',
  'odds_format',
  'decimal_odds',
  'available',
]);
const CURRENT_SELECTION_REQUIRED_FIELDS = Object.freeze([
  'selection_key',
  'name',
  'odds_format',
  'available',
]);
const MAX_CURRENT_EVENTS = 500;
const MAX_CURRENT_MARKETS = 8;
const MAX_CURRENT_SELECTIONS = 3;
const MAX_CURRENT_TEXT_LENGTH = 500;
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

function decimalDifferenceEquals(actualValue, expectedValue, requiredDifferenceValue) {
  const actual = parseDecimal(actualValue);
  const expected = parseDecimal(expectedValue);
  const requiredDifference = parseDecimal(requiredDifferenceValue);
  const scale = Math.max(actual.scale, expected.scale, requiredDifference.scale);
  return scaledCoefficient(actual, scale) - scaledCoefficient(expected, scale)
    === scaledCoefficient(requiredDifference, scale);
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

  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (ALLOWED_FIELDS.some((field) => !Object.hasOwn(descriptors[field], 'value')
    || typeof descriptors[field].value !== 'string')) {
    invalidInput();
  }
  const values = Object.fromEntries(
    ALLOWED_FIELDS.map((field) => [field, descriptors[field].value]),
  );

  if (!ALLOWED_SCOPES.has(values.scope) || !ALLOWED_SPORTS.has(values.sport)) invalidInput();
  if (!/^\d{1,32}$/.test(values.event_id)) invalidInput();
  if (values.selection_key.length === 0 || values.selection_key.length > 500) invalidInput();
  if (values.idempotency_key.length === 0 || values.idempotency_key.length > 200) invalidInput();

  return {
    scope: values.scope,
    sport: values.sport,
    event_id: values.event_id,
    selection_key: values.selection_key,
    stake: normalizeStake(values.stake),
    expected_odds: requireDecimal(values.expected_odds, { positive: true }),
    max_odds_drift: requireDecimal(values.max_odds_drift),
    idempotency_key: values.idempotency_key,
  };
}

function invalidStoreOptions() {
  throw new DraftError(INVALID_DRAFT_STORE_OPTIONS);
}

function invalidDraftData() {
  throw new DraftError(INVALID_DRAFT_DATA);
}

function cloneDraftValue(value, seen, freezeResult = true) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalidDraftData();
    return value;
  }
  if (typeof value !== 'object' || seen.has(value)) invalidDraftData();

  const array = Array.isArray(value);
  const expectedPrototype = array ? Array.prototype : Object.prototype;
  if (Object.getPrototypeOf(value) !== expectedPrototype) invalidDraftData();

  const keys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some((key) => typeof key !== 'string')) invalidDraftData();

  seen.add(value);
  if (array) {
    const lengthDescriptor = descriptors.length;
    const length = lengthDescriptor?.value;
    const elementKeys = keys.filter((key) => key !== 'length');
    if (!lengthDescriptor
      || !Object.hasOwn(lengthDescriptor, 'value')
      || elementKeys.length !== length
      || elementKeys.some((key) => !/^(?:0|[1-9]\d*)$/.test(key)
        || Number(key) >= length
        || !descriptors[key]?.enumerable
        || !Object.hasOwn(descriptors[key], 'value'))) {
      invalidDraftData();
    }

    const clone = new Array(length);
    for (let index = 0; index < length; index += 1) {
      clone[index] = cloneDraftValue(descriptors[String(index)].value, seen);
    }
    return freezeResult ? Object.freeze(clone) : clone;
  }

  const clone = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalidDraftData();
    Object.defineProperty(clone, key, {
      configurable: true,
      enumerable: true,
      value: cloneDraftValue(descriptor.value, seen),
      writable: true,
    });
  }
  return freezeResult ? Object.freeze(clone) : clone;
}

function cloneDraftData(draftData) {
  try {
    if (draftData === null || typeof draftData !== 'object' || Array.isArray(draftData)) {
      invalidDraftData();
    }
    return cloneDraftValue(draftData, new WeakSet(), false);
  } catch {
    invalidDraftData();
  }
}

function freezeDraft(draftData, draftId) {
  Object.defineProperty(draftData, 'draft_id', {
    configurable: true,
    enumerable: true,
    value: draftId,
    writable: true,
  });
  return Object.freeze(draftData);
}

function draftFingerprint(normalizedInput) {
  return JSON.stringify(ALLOWED_FIELDS.map((field) => normalizedInput[field]));
}

function createDraftStore(options) {
  let keys;
  let descriptors;
  try {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      invalidStoreOptions();
    }
    if (Object.getPrototypeOf(options) !== Object.prototype) invalidStoreOptions();
    keys = Reflect.ownKeys(options);
    descriptors = Object.getOwnPropertyDescriptors(options);
  } catch {
    invalidStoreOptions();
  }
  if (keys.some((key) => typeof key !== 'string'
    || !DRAFT_STORE_OPTION_FIELDS.includes(key))) {
    invalidStoreOptions();
  }

  const requiredDescriptors = [descriptors.now, descriptors.idGenerator];
  const optionalDescriptors = [descriptors.ttlMs, descriptors.maxDrafts].filter(Boolean);
  if ([...requiredDescriptors, ...optionalDescriptors]
    .some((descriptor) => !descriptor || !Object.hasOwn(descriptor, 'value'))) {
    invalidStoreOptions();
  }

  const now = descriptors.now.value;
  const idGenerator = descriptors.idGenerator.value;
  const ttlMs = descriptors.ttlMs?.value ?? DEFAULT_DRAFT_TTL_MS;
  const maxDrafts = descriptors.maxDrafts?.value ?? DEFAULT_MAX_DRAFTS;
  if (typeof now !== 'function'
    || typeof idGenerator !== 'function'
    || !Number.isSafeInteger(ttlMs)
    || ttlMs <= 0
    || ttlMs > DEFAULT_DRAFT_TTL_MS
    || !Number.isSafeInteger(maxDrafts)
    || maxDrafts <= 0
    || maxDrafts > DEFAULT_MAX_DRAFTS) {
    invalidStoreOptions();
  }

  const entries = new Map();

  function currentTime() {
    let value;
    try {
      value = now();
    } catch {
      invalidStoreOptions();
    }
    if (!Number.isSafeInteger(value) || value < 0) invalidStoreOptions();
    return value;
  }

  function cleanExpired(timestamp) {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= timestamp) entries.delete(key);
    }
  }

  function locate(normalizedInput) {
    const fingerprint = draftFingerprint(normalizedInput);
    const entry = entries.get(normalizedInput.idempotency_key);
    if (entry && entry.fingerprint !== fingerprint) {
      throw new DraftError(IDEMPOTENCY_CONFLICT);
    }
    return { entry, fingerprint };
  }

  function findReplay(input) {
    cleanExpired(currentTime());
    const normalizedInput = normalizeDraftInput(input);
    return locate(normalizedInput).entry?.draft;
  }

  function save(input, draftData) {
    const timestamp = currentTime();
    const expiresAt = timestamp + ttlMs;
    if (!Number.isSafeInteger(expiresAt)) invalidStoreOptions();
    cleanExpired(timestamp);
    const normalizedInput = normalizeDraftInput(input);
    const { entry, fingerprint } = locate(normalizedInput);
    if (entry) return entry.draft;
    const storedDraftData = cloneDraftData(draftData);

    let draftId;
    try {
      draftId = idGenerator();
    } catch {
      invalidStoreOptions();
    }
    if (typeof draftId !== 'string' || draftId.length === 0) invalidStoreOptions();

    const draft = freezeDraft(storedDraftData, draftId);
    entries.set(normalizedInput.idempotency_key, {
      draft,
      expiresAt,
      fingerprint,
    });

    while (entries.size > maxDrafts) {
      entries.delete(entries.keys().next().value);
    }
    return draft;
  }

  return Object.freeze({ findReplay, save });
}

function invalidServiceOptions() {
  throw new DraftError(INVALID_DRAFT_SERVICE_OPTIONS);
}

function malformedCurrentSnapshot() {
  throw new DraftError(MALFORMED_CURRENT_SNAPSHOT);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readCurrentRecord(value, allowedFields, requiredFields = allowedFields) {
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    malformedCurrentSnapshot();
  }
  const allowed = new Set(allowedFields);
  const keys = Reflect.ownKeys(value);
  if (keys.length > allowedFields.length
    || keys.some((key) => typeof key !== 'string' || !allowed.has(key))) {
    malformedCurrentSnapshot();
  }

  const values = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor
      || !descriptor.enumerable
      || !Object.hasOwn(descriptor, 'value')) {
      malformedCurrentSnapshot();
    }
    values[key] = descriptor.value;
  }
  if (requiredFields.some((field) => !Object.hasOwn(values, field))) {
    malformedCurrentSnapshot();
  }
  return values;
}

function isNormalizedText(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_CURRENT_TEXT_LENGTH
    && value === value.trim();
}

function isCurrentDecimal(value) {
  return typeof value === 'string'
    && value.length <= MAX_DECIMAL_LENGTH
    && CURRENT_DECIMAL_PATTERN.test(value);
}

function isPositiveCurrentDecimal(value) {
  return isCurrentDecimal(value) && !/^0(?:\.0*)?$/.test(value);
}

function readCurrentArray(value, { minimum = 0, maximum }) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    malformedCurrentSnapshot();
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length = lengthDescriptor?.value;
  if (!lengthDescriptor
    || !Object.hasOwn(lengthDescriptor, 'value')
    || !Number.isSafeInteger(length)
    || length < minimum
    || length > maximum) {
    malformedCurrentSnapshot();
  }

  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1
    || keys.some((key) => key !== 'length'
      && (typeof key !== 'string'
        || !/^(?:0|[1-9]\d*)$/.test(key)
        || Number(key) >= length))) {
    malformedCurrentSnapshot();
  }

  const values = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor
      || !descriptor.enumerable
      || !Object.hasOwn(descriptor, 'value')) {
      malformedCurrentSnapshot();
    }
    values[index] = descriptor.value;
  }
  return values;
}

function validateCurrentScore(score) {
  if (score === null) return;
  const values = readCurrentRecord(score, CURRENT_SCORE_FIELDS);
  if (!Number.isSafeInteger(values.home)
    || values.home < 0
    || values.home > 999
    || !Number.isSafeInteger(values.away)
    || values.away < 0
    || values.away > 999) {
    malformedCurrentSnapshot();
  }
}

function validateCurrentSelection(selection, eventId, market) {
  const values = readCurrentRecord(
    selection,
    CURRENT_SELECTION_FIELDS,
    CURRENT_SELECTION_REQUIRED_FIELDS,
  );
  if (!isNormalizedText(values.selection_key)
    || !CURRENT_MARKET_SELECTIONS[market.type].has(values.name)
    || values.selection_key !== `${eventId}:${market.period}:${market.type}:${values.name}`
    || values.odds_format !== 'hong_kong'
    || typeof values.available !== 'boolean') {
    malformedCurrentSnapshot();
  }

  const lineMarket = market.type === 'handicap' || market.type === 'total';
  if (lineMarket) {
    if (!Object.hasOwn(values, 'line')
      || typeof values.line !== 'string'
      || values.line.length > MAX_DECIMAL_LENGTH
      || !CURRENT_LINE_PATTERN.test(values.line)) {
      malformedCurrentSnapshot();
    }
  } else if (Object.hasOwn(values, 'line')) {
    malformedCurrentSnapshot();
  }

  if (!values.available) {
    if (Object.hasOwn(values, 'display_odds')
      || Object.hasOwn(values, 'decimal_odds')) {
      malformedCurrentSnapshot();
    }
    return {
      available: false,
      currentOdds: undefined,
      selectionKey: values.selection_key,
    };
  }

  if (!Object.hasOwn(values, 'display_odds')
    || !Object.hasOwn(values, 'decimal_odds')
    || !isCurrentDecimal(values.display_odds)
    || !isPositiveCurrentDecimal(values.decimal_odds)
    || !decimalDifferenceEquals(values.decimal_odds, values.display_odds, '1')) {
    malformedCurrentSnapshot();
  }
  return {
    available: true,
    currentOdds: canonicalDecimal(values.decimal_odds),
    selectionKey: values.selection_key,
  };
}

function validateCurrentEvent(event, normalizedInput) {
  const values = readCurrentRecord(event, CURRENT_EVENT_FIELDS);
  if (typeof values.event_id !== 'string'
    || !CURRENT_EVENT_ID_PATTERN.test(values.event_id)
    || values.sport !== normalizedInput.sport
    || values.scope !== normalizedInput.scope
    || !isNormalizedText(values.league)
    || !isNormalizedText(values.home)
    || !isNormalizedText(values.away)
    || !(values.clock === null || isNormalizedText(values.clock))) {
    malformedCurrentSnapshot();
  }
  validateCurrentScore(values.score);
  const markets = readCurrentArray(values.markets, { maximum: MAX_CURRENT_MARKETS });

  const selections = [];
  const marketKeys = new Set();
  for (const market of markets) {
    const marketValues = readCurrentRecord(market, CURRENT_MARKET_FIELDS);
    if (!CURRENT_PERIODS.has(marketValues.period)
      || !Object.hasOwn(CURRENT_MARKET_SELECTIONS, marketValues.type)) {
      malformedCurrentSnapshot();
    }
    const marketKey = `${marketValues.period}:${marketValues.type}`;
    if (marketKeys.has(marketKey)) malformedCurrentSnapshot();
    marketKeys.add(marketKey);

    const marketSelections = readCurrentArray(marketValues.selections, {
      minimum: 1,
      maximum: MAX_CURRENT_SELECTIONS,
    });
    for (const selection of marketSelections) {
      selections.push(validateCurrentSelection(
        selection,
        values.event_id,
        marketValues,
      ));
    }
  }
  return { eventId: values.event_id, selections };
}

function currentSelectionOdds(snapshot, normalizedInput) {
  try {
    const currentSnapshot = readCurrentRecord(snapshot, CURRENT_SNAPSHOT_FIELDS);
    const events = readCurrentArray(currentSnapshot.events, { maximum: MAX_CURRENT_EVENTS });
    if (!Number.isSafeInteger(currentSnapshot.count)
      || currentSnapshot.count < 0
      || currentSnapshot.count !== events.length
      || typeof currentSnapshot.truncated !== 'boolean'
      || (currentSnapshot.truncated && currentSnapshot.count !== MAX_CURRENT_EVENTS)) {
      malformedCurrentSnapshot();
    }

    const matchingEvents = [];
    const eventIds = new Set();
    const selectionKeys = new Set();
    for (const event of events) {
      const validatedEvent = validateCurrentEvent(event, normalizedInput);
      if (eventIds.has(validatedEvent.eventId)
        && validatedEvent.eventId !== normalizedInput.event_id) {
        malformedCurrentSnapshot();
      }
      eventIds.add(validatedEvent.eventId);

      for (const selection of validatedEvent.selections) {
        if (selectionKeys.has(selection.selectionKey)
          && selection.selectionKey !== normalizedInput.selection_key) {
          malformedCurrentSnapshot();
        }
        selectionKeys.add(selection.selectionKey);
      }
      if (validatedEvent.eventId === normalizedInput.event_id) {
        matchingEvents.push(validatedEvent);
      }
    }
    if (matchingEvents.length !== 1) throw new DraftError(EVENT_UNAVAILABLE);

    const matchingSelections = matchingEvents[0].selections.filter(
      (selection) => selection.selectionKey === normalizedInput.selection_key,
    );

    if (matchingSelections.length !== 1 || !matchingSelections[0].available) {
      throw new DraftError(SELECTION_UNAVAILABLE);
    }
    return matchingSelections[0].currentOdds;
  } catch (error) {
    if (error instanceof DraftError
      && [
        MALFORMED_CURRENT_SNAPSHOT,
        EVENT_UNAVAILABLE,
        SELECTION_UNAVAILABLE,
      ].includes(error.code)) {
      throw error;
    }
    malformedCurrentSnapshot();
  }
}

function createBetDraftService(options) {
  let keys;
  let descriptors;
  try {
    if (!isRecord(options) || Object.getPrototypeOf(options) !== Object.prototype) {
      invalidServiceOptions();
    }
    keys = Reflect.ownKeys(options);
    descriptors = Object.getOwnPropertyDescriptors(options);
  } catch {
    invalidServiceOptions();
  }

  if (keys.some((key) => typeof key !== 'string'
    || !DRAFT_SERVICE_OPTION_FIELDS.includes(key))) {
    invalidServiceOptions();
  }
  const requiredDescriptors = [
    descriptors.upstream,
    descriptors.now,
    descriptors.idGenerator,
  ];
  const optionalDescriptors = [descriptors.ttlMs, descriptors.maxDrafts].filter(Boolean);
  if ([...requiredDescriptors, ...optionalDescriptors]
    .some((descriptor) => !descriptor || !Object.hasOwn(descriptor, 'value'))) {
    invalidServiceOptions();
  }

  const upstream = descriptors.upstream.value;
  const now = descriptors.now.value;
  const idGenerator = descriptors.idGenerator.value;
  const ttlMs = descriptors.ttlMs?.value ?? DEFAULT_DRAFT_TTL_MS;
  const maxDrafts = descriptors.maxDrafts?.value ?? DEFAULT_MAX_DRAFTS;
  let getSportsDescriptor;
  try {
    if (!isRecord(upstream)) invalidServiceOptions();
    getSportsDescriptor = Object.getOwnPropertyDescriptor(upstream, 'getSports');
  } catch {
    invalidServiceOptions();
  }
  if (!getSportsDescriptor
    || !Object.hasOwn(getSportsDescriptor, 'value')
    || typeof getSportsDescriptor.value !== 'function'
    || typeof now !== 'function'
    || typeof idGenerator !== 'function'
    || !Number.isSafeInteger(ttlMs)
    || ttlMs <= 0
    || ttlMs > DEFAULT_DRAFT_TTL_MS
    || !Number.isSafeInteger(maxDrafts)
    || maxDrafts <= 0
    || maxDrafts > DEFAULT_MAX_DRAFTS) {
    invalidServiceOptions();
  }

  const getSports = getSportsDescriptor.value;
  let saveTimestamp;
  const store = createDraftStore({
    now: () => saveTimestamp ?? now(),
    idGenerator,
    ttlMs,
    maxDrafts,
  });

  function serviceTimestamp() {
    let timestamp;
    try {
      timestamp = now();
    } catch {
      invalidServiceOptions();
    }
    if (!Number.isSafeInteger(timestamp)
      || timestamp < 0) {
      invalidServiceOptions();
    }
    const expiresAt = timestamp + ttlMs;
    if (!Number.isSafeInteger(expiresAt)) invalidServiceOptions();
    try {
      return {
        createdAt: new Date(timestamp).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
        timestamp,
      };
    } catch {
      invalidServiceOptions();
    }
  }

  async function create(rawInput) {
    const normalizedInput = normalizeDraftInput(rawInput);
    const replay = store.findReplay(normalizedInput);
    if (replay) return replay;

    const snapshot = await getSports.call(upstream, {
      scope: normalizedInput.scope,
      sport: normalizedInput.sport,
    });
    const currentOdds = currentSelectionOdds(snapshot, normalizedInput);
    if (decimalDifferenceExceeds(
      currentOdds,
      normalizedInput.expected_odds,
      normalizedInput.max_odds_drift,
    )) {
      throw new DraftError(ODDS_DRIFT_EXCEEDED);
    }

    const { createdAt, expiresAt, timestamp } = serviceTimestamp();
    saveTimestamp = timestamp;
    try {
      return store.save(normalizedInput, {
        state: 'ready_for_manual_confirmation',
        scope: normalizedInput.scope,
        sport: normalizedInput.sport,
        event_id: normalizedInput.event_id,
        selection_key: normalizedInput.selection_key,
        stake: normalizedInput.stake,
        expected_odds: normalizedInput.expected_odds,
        current_odds: currentOdds,
        max_odds_drift: normalizedInput.max_odds_drift,
        odds_changed: currentOdds !== normalizedInput.expected_odds,
        projected_gross_return: multiplyMoneyByOdds(normalizedInput.stake, currentOdds),
        created_at: createdAt,
        expires_at: expiresAt,
      });
    } finally {
      saveTimestamp = undefined;
    }
  }

  return Object.freeze({ create });
}

module.exports = {
  DraftError,
  createBetDraftService,
  createDraftStore,
  decimalDifferenceExceeds,
  multiplyMoneyByOdds,
  normalizeDraftInput,
};
