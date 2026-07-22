'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PlacementError,
  createBetPlacementService,
  stakeToCents,
} = require('../src/bet-placement');
const { DraftError } = require('../src/bet-drafts');

// A minimal draft service double: create() echoes a draft envelope, honoring
// idempotency replay and letting tests inject drift/validation failures.
function fakeDraftService({ stake = '10', fail = null } = {}) {
  const created = [];
  const byKey = new Map();
  let seq = 0;
  return {
    created,
    create(input) {
      created.push(input);
      if (fail) return Promise.reject(fail);
      const key = input?.idempotency_key;
      if (key !== undefined && byKey.has(key)) {
        return Promise.resolve(byKey.get(key));
      }
      seq += 1;
      const draft = Object.freeze({
        draft_id: `draft-${seq}`,
        state: 'ready_for_manual_confirmation',
        stake: input?.stake ?? stake,
        current_odds: '1.98',
        created_at: '2026-07-19T12:00:00.000Z',
      });
      if (key !== undefined) byKey.set(key, draft);
      return Promise.resolve(draft);
    },
  };
}

function baseOptions(overrides = {}) {
  return {
    draftService: fakeDraftService(),
    placeBet: async (draft) => ({ bet_id: `bet-${draft.draft_id}` }),
    enabled: true,
    dryRun: false,
    maxStake: 500,
    maxDailyStake: 5000,
    now: () => new Date('2026-07-19T12:00:00.000Z'),
    ...overrides,
  };
}

function validInput(overrides = {}) {
  return {
    scope: 'live',
    sport: 'football',
    event_id: '900000001',
    selection_key: '900000001:full_time:1x2:home',
    stake: '10',
    expected_odds: '1.95',
    max_odds_drift: '0.05',
    idempotency_key: 'client-1',
    ...overrides,
  };
}

test('stakeToCents parses integer and fractional stakes as integer cents', () => {
  assert.equal(stakeToCents('500'), 50000n);
  assert.equal(stakeToCents('10'), 1000n);
  assert.equal(stakeToCents('10.5'), 1050n);
  assert.equal(stakeToCents('0.99'), 99n);
  assert.equal(stakeToCents('abc'), null);
  assert.equal(stakeToCents('10.005'), null);
});

test('disabled service rejects every placement without touching the draft service', async () => {
  const draftService = fakeDraftService();
  const service = createBetPlacementService(baseOptions({ enabled: false, draftService }));
  await assert.rejects(service.place(validInput()), (error) => {
    assert.ok(error instanceof PlacementError);
    assert.equal(error.code, 'BET_PLACEMENT_DISABLED');
    return true;
  });
  assert.equal(draftService.created.length, 0);
});

test('dry-run validates but never submits and stays repeatable', async () => {
  const placeBetCalls = [];
  const service = createBetPlacementService(baseOptions({
    dryRun: true,
    placeBet: async (draft) => { placeBetCalls.push(draft); return {}; },
  }));

  const first = await service.place(validInput());
  const second = await service.place(validInput());

  assert.equal(first.status, 'would_place');
  assert.equal(first.dry_run, true);
  assert.equal(placeBetCalls.length, 0);
  // Dry-runs are not recorded, so a later real attempt could still proceed.
  assert.equal(second.status, 'would_place');
});

test('real placement submits once and returns the receipt', async () => {
  const placeBetCalls = [];
  const service = createBetPlacementService(baseOptions({
    placeBet: async (draft) => { placeBetCalls.push(draft); return { bet_id: 'bet-9' }; },
  }));

  const result = await service.place(validInput());
  assert.equal(result.status, 'placed');
  assert.equal(result.dry_run, false);
  assert.deepEqual(result.receipt, { bet_id: 'bet-9' });
  assert.equal(placeBetCalls.length, 1);
});

test('idempotent placement never submits the same key twice', async () => {
  let calls = 0;
  const service = createBetPlacementService(baseOptions({
    placeBet: async () => { calls += 1; return { bet_id: `bet-${calls}` }; },
  }));

  const first = await service.place(validInput());
  const second = await service.place(validInput());

  assert.equal(calls, 1);
  assert.equal(first.receipt.bet_id, 'bet-1');
  assert.deepEqual(second, first);
});

test('concurrent identical placements collapse into a single submission', async () => {
  let calls = 0;
  const service = createBetPlacementService(baseOptions({
    placeBet: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { bet_id: `bet-${calls}` };
    },
  }));

  const [a, b] = await Promise.all([
    service.place(validInput()),
    service.place(validInput()),
  ]);

  assert.equal(calls, 1);
  assert.deepEqual(a, b);
});

test('a stake above the single-bet cap is rejected before submitting', async () => {
  let calls = 0;
  const service = createBetPlacementService(baseOptions({
    placeBet: async () => { calls += 1; return {}; },
  }));

  await assert.rejects(service.place(validInput({ stake: '501' })), (error) => {
    assert.ok(error instanceof PlacementError);
    assert.equal(error.code, 'STAKE_LIMIT_EXCEEDED');
    return true;
  });
  assert.equal(calls, 0);
});

test('the cap boundary itself is allowed', async () => {
  const service = createBetPlacementService(baseOptions());
  const result = await service.place(validInput({ stake: '500' }));
  assert.equal(result.status, 'placed');
});

test('cumulative stakes past the daily cap are rejected, prior ones stand', async () => {
  const service = createBetPlacementService(baseOptions({ maxStake: 500, maxDailyStake: 800 }));

  const first = await service.place(validInput({ stake: '500', idempotency_key: 'a' }));
  assert.equal(first.status, 'placed');

  await assert.rejects(
    service.place(validInput({ stake: '400', idempotency_key: 'b' })),
    (error) => {
      assert.equal(error.code, 'DAILY_LIMIT_EXCEEDED');
      return true;
    },
  );

  // Something still within the remaining daily room goes through.
  const third = await service.place(validInput({ stake: '300', idempotency_key: 'c' }));
  assert.equal(third.status, 'placed');
});

test('the daily total resets on a new calendar day', async () => {
  let clock = new Date('2026-07-19T23:59:00.000Z');
  const service = createBetPlacementService(baseOptions({
    maxStake: 500,
    maxDailyStake: 500,
    now: () => clock,
  }));

  const first = await service.place(validInput({ stake: '500', idempotency_key: 'day1' }));
  assert.equal(first.status, 'placed');

  clock = new Date('2026-07-20T00:01:00.000Z');
  const second = await service.place(validInput({ stake: '500', idempotency_key: 'day2' }));
  assert.equal(second.status, 'placed');
});

test('a rejected placement does not consume daily budget', async () => {
  const service = createBetPlacementService(baseOptions({ maxStake: 500, maxDailyStake: 500 }));

  await assert.rejects(service.place(validInput({ stake: '600', idempotency_key: 'x' })));
  // Full budget remains for a valid bet.
  const ok = await service.place(validInput({ stake: '500', idempotency_key: 'y' }));
  assert.equal(ok.status, 'placed');
});

test('draft-service failures (e.g. odds drift) surface unchanged', async () => {
  const drift = new DraftError('ODDS_DRIFT_EXCEEDED');
  const service = createBetPlacementService(baseOptions({
    draftService: fakeDraftService({ fail: drift }),
  }));
  await assert.rejects(service.place(validInput()), (error) => {
    assert.ok(error instanceof DraftError);
    assert.equal(error.code, 'ODDS_DRIFT_EXCEEDED');
    return true;
  });
});

test('invalid service options are rejected at construction', () => {
  assert.throws(() => createBetPlacementService(baseOptions({ maxStake: 0 })), PlacementError);
  assert.throws(
    () => createBetPlacementService(baseOptions({ maxDailyStake: 100, maxStake: 500 })),
    PlacementError,
  );
  assert.throws(() => createBetPlacementService(baseOptions({ placeBet: null })), PlacementError);
  assert.throws(() => createBetPlacementService(baseOptions({ enabled: 'yes' })), PlacementError);
});
