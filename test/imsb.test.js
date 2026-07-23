'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createImsbUpstream } = require('../src/upstream/imsb');
const { UpstreamError } = require('../src/upstream/errors');

const footballFixture = require('./fixtures/imsb-getse-football-epl.json');
const basketballFixture = require('./fixtures/imsb-getse-basketball-nznbl.json');

// Build a GetSE result ({ data: { StatusCode, sel } }) from fixture events,
// injecting sequential wsi/mi where the fixture omits them.
function toGetSeResult(events) {
  let wsiSeq = 32000000000;
  let miSeq = 2470000000;
  const sel = events.map((ev) => ({
    eid: ev.eid,
    htn: ev.home,
    atn: ev.away,
    cn: ev.comp,
    iop: ev.iop ?? false,
    edt: ev.edt,
    mls: ev.markets.map((m) => ({
      mi: m.mi ?? (miSeq += 1),
      bti: m.bti,
      btn: m.btn,
      gp: m.gp,
      ml: m.ml ?? 1,
      ws: m.ws.map((w) => ({
        wsi: w.wsi ?? (wsiSeq += 1),
        si: w.si,
        hdp: w.hdp,
        dih: w.dih,
        s: w.s ?? '',
        o: w.o,
        ot: w.ot,
      })),
    })),
  }));
  return { ok: true, status: 200, data: { StatusCode: 100, sel } };
}

// Gateway stub routing by the API path in the expression. GetSE (pre-match with
// Market 1, live with Market 3) returns the fixture for the requested SportId;
// the SPB placement expression returns the programmed result.
function stubGateway({ place, onEvaluate } = {}) {
  const calls = [];
  let closed = 0;
  return {
    calls,
    closedCount: () => closed,
    async evaluate(expression) {
      calls.push(expression);
      if (onEvaluate) onEvaluate(expression);
      // The body is embedded as a JS string literal, so quotes are
      // backslash-escaped (\"SportId\":2). Tolerate escaped or raw form.
      const fixture = /SportId\\?":2/.test(expression) ? basketballFixture : footballFixture;
      if (expression.includes('/api/EventV6/GetSE')) return toGetSeResult([fixture.event]);
      if (expression.includes('/api/PlaceBetV6/SPB')) return place;
      throw new Error(`unexpected expression: ${expression.slice(0, 40)}`);
    },
    async close() { closed += 1; },
  };
}

const passthroughQueue = { run: (fn) => fn({ signal: undefined }) };

function draftFor(overrides = {}) {
  return {
    scope: 'early',
    sport: 'football',
    event_id: '111756567',
    selection_key: '111756567:full_time:handicap:home',
    stake: '1.00',
    expected_odds: '1.77',
    max_odds_drift: '0.10',
    ...overrides,
  };
}

test('createImsbUpstream validates its gateway and queue', () => {
  assert.throws(() => createImsbUpstream({ gateway: {}, queue: passthroughQueue }), TypeError);
  assert.throws(() => createImsbUpstream({ gateway: stubGateway(), queue: {} }), TypeError);
});

test('getSports evaluates GetSE and returns a normalized football snapshot', async () => {
  const gateway = stubGateway();
  const upstream = createImsbUpstream({ gateway, queue: passthroughQueue });
  const snapshot = await upstream.getSports({ scope: 'early', sport: 'football' });
  assert.equal(snapshot.count, 1);
  assert.equal(snapshot.events[0].event_id, '111756567');
  const types = snapshot.events[0].markets.map((m) => m.type);
  assert.ok(types.includes('handicap') && types.includes('total') && types.includes('1x2'));
  assert.match(gateway.calls[0], /\/api\/EventV6\/GetSE/);
});

test('getSports returns a basketball snapshot with a moneyline market', async () => {
  const gateway = stubGateway();
  const upstream = createImsbUpstream({ gateway, queue: passthroughQueue });
  const snapshot = await upstream.getSports({ scope: 'today', sport: 'basketball' });
  assert.equal(snapshot.count, 1);
  const types = snapshot.events[0].markets.map((m) => m.type);
  assert.ok(types.includes('moneyline'));
  assert.match(gateway.calls[0], /SportId\\?":2/);
});

test('getSports (live) evaluates GetSE with Market 3 and projects the snapshot', async () => {
  const gateway = stubGateway();
  const upstream = createImsbUpstream({ gateway, queue: passthroughQueue });
  const snapshot = await upstream.getSports({ scope: 'live', sport: 'football' });
  assert.equal(snapshot.count, 1);
  assert.equal(snapshot.events[0].scope, 'live');
  assert.equal(snapshot.events[0].event_id, '111756567');
  const types = snapshot.events[0].markets.map((m) => m.type);
  assert.ok(types.includes('handicap') && types.includes('1x2'));
  assert.match(gateway.calls[0], /\/api\/EventV6\/GetSE/);
  assert.match(gateway.calls[0], /\\?"Market\\?":3/); // live market group
});

test('getSports returns empty for an unsupported sport with no API call', async () => {
  const gateway = stubGateway();
  const upstream = createImsbUpstream({ gateway, queue: passthroughQueue });
  const snapshot = await upstream.getSports({ scope: 'early', sport: 'tennis' });
  assert.deepEqual(snapshot, { events: [], count: 0, truncated: false });
  assert.equal(gateway.calls.length, 0);
});

test('getSports maps a gateway failure to a trusted UpstreamError', async () => {
  const gateway = stubGateway();
  gateway.evaluate = async () => { throw new Error('cdp exploded'); };
  const upstream = createImsbUpstream({ gateway, queue: passthroughQueue });
  await assert.rejects(
    () => upstream.getSports({ scope: 'early', sport: 'football' }),
    (error) => error instanceof UpstreamError && error.code === 'BROWSER_UNAVAILABLE',
  );
});

test('placeBet re-resolves the selection then submits SPB, returning the receipt', async () => {
  const gateway = stubGateway({
    place: {
      status: 'placed', bet_id: '2607220153304812', accepted_odds: 1.77, balance: 1105.37,
    },
  });
  const upstream = createImsbUpstream({ gateway, queue: passthroughQueue });
  const receipt = await upstream.placeBet(draftFor());
  assert.deepEqual(receipt, {
    bet_id: '2607220153304812', accepted_odds: 1.77, balance: 1105.37,
  });
  // GetSE re-resolves the venue ids, then the SPB submission.
  assert.equal(gateway.calls.length, 2);
  assert.match(gateway.calls[0], /GetSE/);
  assert.match(gateway.calls[1], /PlaceBetV6\/SPB/);
});

test('placeBet throws SELECTION_UNAVAILABLE when the key is gone and never submits', async () => {
  const gateway = stubGateway();
  const upstream = createImsbUpstream({ gateway, queue: passthroughQueue });
  await assert.rejects(
    () => upstream.placeBet(draftFor({ selection_key: '999:full_time:handicap:home' })),
    (error) => error.name === 'ImsbPlacementError' && error.code === 'SELECTION_UNAVAILABLE',
  );
  assert.equal(gateway.calls.length, 1); // GetSE only, no SPB
});

test('placeBet surfaces a venue rejection as a typed placement error', async () => {
  const gateway = stubGateway({ place: { status: 'rejected', code: 402 } });
  const upstream = createImsbUpstream({ gateway, queue: passthroughQueue });
  await assert.rejects(
    () => upstream.placeBet(draftFor()),
    (error) => error.name === 'ImsbPlacementError' && error.code === 'PLACEMENT_REJECTED',
  );
});

test('placeBet reports an odds-changed result as ODDS_DRIFT_EXCEEDED', async () => {
  const gateway = stubGateway({ place: { status: 'odds_changed', current_odds: 2.0, expected: 1.77 } });
  const upstream = createImsbUpstream({ gateway, queue: passthroughQueue });
  await assert.rejects(
    () => upstream.placeBet(draftFor()),
    (error) => error.name === 'ImsbPlacementError' && error.code === 'ODDS_DRIFT_EXCEEDED',
  );
});

test('the read features with no JSON-API equivalent fail closed', async () => {
  const upstream = createImsbUpstream({ gateway: stubGateway(), queue: passthroughQueue });
  for (const method of ['getSportsAccount', 'getSportsCatalog', 'getSportsBoosts', 'getBalance', 'getBets']) {
    await assert.rejects(
      () => upstream[method](),
      (error) => error instanceof UpstreamError && error.code === 'BROWSER_UNAVAILABLE',
    );
  }
});

test('close closes the gateway once, even if called repeatedly', async () => {
  const gateway = stubGateway();
  const upstream = createImsbUpstream({ gateway, queue: passthroughQueue });
  await upstream.close();
  await upstream.close();
  assert.equal(gateway.closedCount(), 1);
});
