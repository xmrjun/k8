'use strict';

// Guarded bet-placement service.
//
// This module deliberately crosses the boundary the manual-confirmation draft
// design refused to cross: it can submit a real wager. Every submission is
// gated behind explicit guardrails so a bug or a bad caller cannot silently
// spend money:
//
//   1. kill switch   - `enabled` must be true, otherwise every call fails.
//   2. dry-run       - when `dryRun` is true the request is fully validated but
//                      never submitted; the caller gets `would_place`.
//   3. odds drift    - reuses the draft service, which re-fetches the live
//                      snapshot and rejects a proposal that drifted too far.
//   4. stake caps    - single-bet and cumulative-daily limits, compared in
//                      integer cents (no binary float money math).
//   5. idempotency   - a real placement is recorded per client key and is
//                      never submitted twice, even across draft expiry.

const PLACEMENT_DISABLED = 'BET_PLACEMENT_DISABLED';
const STAKE_LIMIT_EXCEEDED = 'STAKE_LIMIT_EXCEEDED';
const DAILY_LIMIT_EXCEEDED = 'DAILY_LIMIT_EXCEEDED';
const INVALID_PLACEMENT_OPTIONS = 'INVALID_PLACEMENT_OPTIONS';

const STAKE_PATTERN = /^(\d+)(?:\.(\d{1,2}))?$/;

class PlacementError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PlacementError';
    this.code = code;
  }
}

// Convert a canonical stake string (integer, or up to two fractional digits)
// into integer cents as a BigInt. Returns null for anything unexpected.
function stakeToCents(value) {
  if (typeof value !== 'string') return null;
  const match = STAKE_PATTERN.exec(value);
  if (!match) return null;
  const fraction = (match[2] || '').padEnd(2, '0');
  try {
    return BigInt(match[1]) * 100n + BigInt(fraction);
  } catch {
    return null;
  }
}

function invalidOptions() {
  throw new PlacementError(INVALID_PLACEMENT_OPTIONS, 'Invalid bet-placement options');
}

function createBetPlacementService({
  draftService,
  placeBet,
  enabled,
  dryRun,
  maxStake,
  maxDailyStake,
  now = () => new Date(),
} = {}) {
  if (typeof draftService?.create !== 'function'
    || typeof placeBet !== 'function'
    || typeof enabled !== 'boolean'
    || typeof dryRun !== 'boolean'
    || typeof now !== 'function'
    || !Number.isSafeInteger(maxStake) || maxStake <= 0
    || !Number.isSafeInteger(maxDailyStake) || maxDailyStake <= 0
    || maxDailyStake < maxStake) {
    invalidOptions();
  }

  const maxStakeCents = BigInt(maxStake) * 100n;
  const maxDailyStakeCents = BigInt(maxDailyStake) * 100n;

  // In-memory, process-lifetime idempotency for real placements. Never evicted
  // on a timer: a placed wager must not be re-submitted just because time
  // passed. Dry-runs are intentionally not recorded so they stay repeatable.
  const placed = new Map();
  const inFlight = new Map();

  let dayKey = null;
  let dayTotalCents = 0n;

  function currentDayKey() {
    const value = now();
    const iso = value instanceof Date ? value.toISOString() : new Date(value).toISOString();
    return iso.slice(0, 10);
  }

  function rolloverIfNeeded() {
    const key = currentDayKey();
    if (key !== dayKey) {
      dayKey = key;
      dayTotalCents = 0n;
    }
  }

  async function execute(rawInput, idemKey) {
    // The draft service performs every proposal check (normalization, exact
    // selection lookup, availability, live odds drift) and throws DraftError.
    const draft = await draftService.create(rawInput);

    const cents = stakeToCents(draft.stake);
    if (cents === null) {
      throw new PlacementError(STAKE_LIMIT_EXCEEDED, 'Stake could not be evaluated');
    }
    if (cents > maxStakeCents) {
      throw new PlacementError(STAKE_LIMIT_EXCEEDED, 'Stake exceeds the single-bet limit');
    }
    rolloverIfNeeded();
    if (dayTotalCents + cents > maxDailyStakeCents) {
      throw new PlacementError(DAILY_LIMIT_EXCEEDED, 'Stake exceeds the daily limit');
    }

    if (dryRun) {
      return Object.freeze({ status: 'would_place', dry_run: true, draft });
    }

    const receipt = await placeBet(draft);
    dayTotalCents += cents;
    const result = Object.freeze({
      status: 'placed', dry_run: false, draft, receipt,
    });
    if (idemKey !== undefined) placed.set(idemKey, result);
    return result;
  }

  function place(rawInput) {
    if (!enabled) {
      return Promise.reject(
        new PlacementError(PLACEMENT_DISABLED, 'Bet placement is disabled'),
      );
    }

    const idemKey = rawInput !== null && typeof rawInput === 'object'
      && typeof rawInput.idempotency_key === 'string'
      ? rawInput.idempotency_key
      : undefined;

    if (idemKey !== undefined) {
      const existing = placed.get(idemKey);
      if (existing) return Promise.resolve(existing);
      const pending = inFlight.get(idemKey);
      if (pending) return pending;
    }

    const runner = execute(rawInput, idemKey);
    if (idemKey !== undefined) {
      inFlight.set(idemKey, runner);
      const cleanup = () => {
        if (inFlight.get(idemKey) === runner) inFlight.delete(idemKey);
      };
      void runner.then(cleanup, cleanup);
    }
    return runner;
  }

  return Object.freeze({ place });
}

module.exports = { PlacementError, createBetPlacementService, stakeToCents };
