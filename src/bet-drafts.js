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

function currentSelectionOdds(snapshot, normalizedInput) {
  try {
    if (!isRecord(snapshot) || !Array.isArray(snapshot.events)) {
      malformedCurrentSnapshot();
    }

    const matchingEvents = [];
    for (const event of snapshot.events) {
      if (!isRecord(event)
        || typeof event.event_id !== 'string'
        || !Array.isArray(event.markets)) {
        malformedCurrentSnapshot();
      }
      if (event.event_id === normalizedInput.event_id) matchingEvents.push(event);
    }
    if (matchingEvents.length !== 1) throw new DraftError(EVENT_UNAVAILABLE);

    const matchingSelections = [];
    for (const market of matchingEvents[0].markets) {
      if (!isRecord(market) || !Array.isArray(market.selections)) {
        malformedCurrentSnapshot();
      }
      for (const selection of market.selections) {
        if (!isRecord(selection)
          || typeof selection.selection_key !== 'string'
          || typeof selection.available !== 'boolean') {
          malformedCurrentSnapshot();
        }

        let decimalOdds;
        if (selection.available) {
          try {
            decimalOdds = requireDecimal(selection.decimal_odds, { positive: true });
          } catch {
            malformedCurrentSnapshot();
          }
        }
        if (selection.selection_key === normalizedInput.selection_key) {
          matchingSelections.push({ available: selection.available, decimalOdds });
        }
      }
    }

    if (matchingSelections.length !== 1 || !matchingSelections[0].available) {
      throw new DraftError(SELECTION_UNAVAILABLE);
    }
    return matchingSelections[0].decimalOdds;
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
    let owner = upstream;
    while (owner !== null && !getSportsDescriptor) {
      getSportsDescriptor = Object.getOwnPropertyDescriptor(owner, 'getSports');
      owner = Object.getPrototypeOf(owner);
    }
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
