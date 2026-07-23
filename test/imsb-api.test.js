'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildGetEventsExpression,
  parseEvents,
  buildPlaceExpression,
  interpretPlaceResult,
  ImsbPlacementError,
} = require('../src/upstream/imsb-api');
const { UpstreamError, CODES } = require('../src/upstream/errors');

// A GetESI result shaped like the live capture (2026-07-21).
function getEsiResult() {
  return {
    ok: true,
    status: 200,
    data: {
      StatusCode: 100,
      obc: 9,
      es: [
        {
          e: [{
            eid: 111395794,
            htn: '乌拉圭民族', htid: 1, atn: '堤格雷', atid: 2,
            cn: '南美洲球会杯', cid: 7, iop: true, edt: '2026-07-21T18:30:00',
            mls: [
              {
                mi: 2470401972, ico: true, bti: 3, btn: '1X2', gp: 1, ml: 1, il: false,
                ws: [
                  { wsi: 32135608307, si: 5, s: '', o: 2.31, ot: 3 },
                  { wsi: 32135608308, si: 6, s: '', o: 3.10, ot: 3 },
                  { wsi: 32135608309, si: 7, s: '', o: 2.90, ot: 3 },
                ],
              },
              {
                mi: 2470401977, ico: true, bti: 18, btn: '双方球队皆进球', gp: 1, ml: 1, il: false,
                ws: [{ wsi: 32113918134, si: 88, s: '', o: 1.62, ot: 3 }],
              },
            ],
          }],
          obi: [{ pbo: 0, o: 2.31, cs: 0, bc: '', ft: 0 }],
        },
      ],
    },
  };
}

test('buildGetEventsExpression embeds the GetESI request and returns a string', () => {
  const expr = buildGetEventsExpression({ sportId: 1, oddsType: 2 });
  assert.equal(typeof expr, 'string');
  assert.match(expr, /\/api\/EventV6\/GetESI/);
  // The request body is embedded as a JS string literal, so the inner JSON
  // quotes are backslash-escaped (\"SportId\":1). Tolerate escaped or raw form.
  assert.match(expr, /\\?"SportId\\?":1/);
  assert.match(expr, /\\?"OddsType\\?":2/);
});

test('parseEvents flattens events into selections carrying placement ids', () => {
  const parsed = parseEvents(getEsiResult());
  assert.equal(parsed.count, 4);
  assert.equal(parsed.odds_boost_count, 9);
  const home = parsed.selections[0];
  assert.equal(home.eid, 111395794);
  assert.equal(home.home, '乌拉圭民族');
  assert.equal(home.away, '堤格雷');
  assert.equal(home.live, true);
  assert.equal(home.bet_type_id, 3);
  assert.equal(home.bet_type_name, '1X2');
  assert.equal(home.game_period, 1);
  assert.equal(home.market_id, 2470401972); // -> mlid
  assert.equal(home.wager_selection_id, 32135608307); // -> wsid
  assert.equal(home.odds, 2.31);
  assert.equal(home.odds_type, 3);
});

test('parseEvents throws on a failed call', () => {
  assert.throws(() => parseEvents({ ok: false, status: 0 }), (e) => {
    assert.ok(e instanceof UpstreamError);
    assert.equal(e.code, CODES.BROWSER_UNAVAILABLE);
    return true;
  });
});

test('parseEvents throws on a non-100 status code', () => {
  assert.throws(
    () => parseEvents({ ok: true, status: 200, data: { StatusCode: 401, es: [] } }),
    (e) => { assert.equal(e.code, CODES.BAD_RESPONSE); return true; },
  );
});

test('buildPlaceExpression embeds GetBI then SPB and a drift guard', () => {
  const expr = buildPlaceExpression({
    eid: 111395794, bet_type_id: 3, game_period: 1, odds_type: 2,
    market_id: 2470401972, wager_selection_id: 32135608307, odds: 2.31,
    stake: '1.00', expected_odds: '2.31', max_odds_drift: '0.05',
  });
  assert.match(expr, /\/api\/PlaceBetV6\/GetBI/);
  assert.match(expr, /\/api\/PlaceBetV6\/SPB/);
  assert.match(expr, /odds_changed/);
  assert.match(expr, /"stake":"1.00"/);
});

test('interpretPlaceResult returns a receipt on success', () => {
  const receipt = interpretPlaceResult({
    status: 'placed', bet_id: '2607210946442701', accepted_odds: 2.31, balance: 1000.37,
  });
  assert.equal(receipt.bet_id, '2607210946442701');
  assert.equal(receipt.accepted_odds, 2.31);
  assert.equal(receipt.balance, 1000.37);
});

test('interpretPlaceResult maps odds_changed to a drift error', () => {
  assert.throws(() => interpretPlaceResult({ status: 'odds_changed', current_odds: 2.5, expected: 2.31 }), (e) => {
    assert.ok(e instanceof ImsbPlacementError);
    assert.equal(e.code, 'ODDS_DRIFT_EXCEEDED');
    return true;
  });
});

test('interpretPlaceResult maps limit and rejection to PLACEMENT_REJECTED', () => {
  for (const v of [{ status: 'limit', reason: 'above_max' }, { status: 'rejected', code: 402 }]) {
    assert.throws(() => interpretPlaceResult(v), (e) => {
      assert.equal(e.code, 'PLACEMENT_REJECTED');
      return true;
    });
  }
});

test('interpretPlaceResult maps unavailable and unknown', () => {
  assert.throws(() => interpretPlaceResult({ status: 'unavailable', stage: 'GetBI' }), (e) => {
    assert.equal(e.code, 'SELECTION_UNAVAILABLE');
    return true;
  });
  assert.throws(() => interpretPlaceResult({ status: 'weird' }), (e) => {
    assert.equal(e.code, 'PLACEMENT_FAILED');
    return true;
  });
});

test('interpretPlaceResult treats a placed-but-idless result as unconfirmed', () => {
  assert.throws(() => interpretPlaceResult({ status: 'placed', bet_id: 'undefined' }), (e) => {
    assert.equal(e.code, 'PLACEMENT_UNCONFIRMED');
    return true;
  });
});

test('interpretPlaceResult maps infra error to an UpstreamError', () => {
  assert.throws(() => interpretPlaceResult({ status: 'error', error: 'network' }), (e) => {
    assert.ok(e instanceof UpstreamError);
    assert.equal(e.code, CODES.BROWSER_UNAVAILABLE);
    return true;
  });
});
