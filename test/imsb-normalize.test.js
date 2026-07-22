'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseSeEvents } = require('../src/upstream/imsb-api');
const { normalizeEvents, toHongKongOdds } = require('../src/upstream/imsb-normalize');
const { createBetDraftService } = require('../src/bet-drafts');

const footballFixture = require('./fixtures/imsb-getse-football-epl.json');
const basketballFixture = require('./fixtures/imsb-getse-basketball-nznbl.json');

// Wrap a fixture event in a GetSE result. Real captures carry wsi/mi; where a
// fixture omits them (opaque ids irrelevant to normalization) inject sequential
// values so parseSeEvents keeps the selection.
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

function normalizeFixture(fixture, scope, sport) {
  return normalizeEvents(
    parseSeEvents(toGetSeResult([fixture.event])),
    { scope, sport },
  );
}

function marketOf(snapshot, period, type) {
  return snapshot.events[0].markets.find((m) => m.period === period && m.type === type);
}

test('toHongKongOdds handles both odds types without float drift', () => {
  // European (ot 3): decimal = o, HK display = o - 1.
  assert.deepEqual(toHongKongOdds(1.15, 3), { decimal_odds: '1.15', display_odds: '0.15' });
  assert.deepEqual(toHongKongOdds(4.15, 3), { decimal_odds: '4.15', display_odds: '3.15' });
  // Hong Kong (ot 2): display = o, decimal = o + 1.
  assert.deepEqual(toHongKongOdds(0.96, 2), { decimal_odds: '1.96', display_odds: '0.96' });
  assert.deepEqual(toHongKongOdds(0.4, 2), { decimal_odds: '1.4', display_odds: '0.4' });
  assert.deepEqual(toHongKongOdds(1.08, 2), { decimal_odds: '2.08', display_odds: '1.08' });
  assert.equal(toHongKongOdds(1, 3), null); // European odds must be > 1
  assert.equal(toHongKongOdds(NaN, 2), null);
  assert.equal(toHongKongOdds(2, 5), null); // unknown odds type
});

test('normalizeEvents maps football 让球 / 大小 / 1X2 across full & first half', () => {
  const { snapshot } = normalizeFixture(footballFixture, 'early', 'football');
  assert.equal(snapshot.count, 1);
  const event = snapshot.events[0];
  assert.equal(event.event_id, '111756567');
  assert.equal(event.sport, 'football');
  assert.equal(event.scope, 'early');
  assert.equal(event.league, '厄瓜多尔甲级联赛');

  // 3 market types x 2 periods.
  assert.equal(event.markets.length, 6);

  const handicap = marketOf(snapshot, 'full_time', 'handicap');
  assert.deepEqual(handicap.selections.map((s) => s.name), ['home', 'away']);
  const hHome = handicap.selections[0];
  assert.equal(hHome.selection_key, '111756567:full_time:handicap:home');
  assert.equal(hHome.line, '+0.5/1'); // dih carried through
  assert.equal(hHome.display_odds, '0.77'); // ot 2 (Hong Kong): display = o
  assert.equal(hHome.decimal_odds, '1.77'); // decimal = o + 1

  const total = marketOf(snapshot, 'full_time', 'total');
  assert.deepEqual(total.selections.map((s) => s.name), ['over', 'under']);
  assert.equal(total.selections[0].line, '2/2.5');
  assert.equal(total.selections[0].decimal_odds, '2.08'); // o 1.08 + 1

  const oneXtwo = marketOf(snapshot, 'full_time', '1x2');
  assert.deepEqual(oneXtwo.selections.map((s) => s.name), ['home', 'draw', 'away']);
  assert.equal(Object.hasOwn(oneXtwo.selections[0], 'line'), false); // no line on 1X2
  assert.equal(oneXtwo.selections[0].decimal_odds, '4.15'); // ot 3 (European): decimal = o
  assert.equal(oneXtwo.selections[0].display_odds, '3.15'); // display = o - 1

  assert.ok(marketOf(snapshot, 'first_half', 'handicap'));
  assert.ok(marketOf(snapshot, 'first_half', '1x2'));
});

test('normalizeEvents maps basketball 让分 / 大小 / 独赢 (moneyline)', () => {
  const { snapshot } = normalizeFixture(basketballFixture, 'today', 'basketball');
  const event = snapshot.events[0];
  assert.equal(event.sport, 'basketball');

  const spread = marketOf(snapshot, 'full_time', 'handicap');
  assert.equal(spread.selections[0].name, 'home');
  assert.equal(spread.selections[0].line, '-7');
  assert.equal(spread.selections[0].decimal_odds, '1.87'); // o 0.87 (HK) + 1

  const total = marketOf(snapshot, 'full_time', 'total');
  assert.equal(total.selections[0].line, '173');

  // 独赢 is a 2-way moneyline (home/away, no draw, no line).
  const moneyline = marketOf(snapshot, 'full_time', 'moneyline');
  assert.deepEqual(moneyline.selections.map((s) => s.name), ['home', 'away']);
  assert.equal(Object.hasOwn(moneyline.selections[0], 'line'), false);
  assert.equal(moneyline.selections[0].decimal_odds, '1.39'); // ot 3 European
  assert.equal(moneyline.selections[0].display_odds, '0.39');
});

test('normalizeEvents indexes every selection_key back to its placement ids', () => {
  const { index } = normalizeFixture(footballFixture, 'early', 'football');
  const home = index.get('111756567:full_time:handicap:home');
  assert.equal(home.eid, 111756567);
  assert.equal(home.bet_type_id, 1);
  assert.equal(home.game_period, 1);
  assert.equal(home.wager_selection_id, 32174501434);
  assert.equal(home.market_id, 2479223121);
  assert.equal(home.odds_type, 2);
  assert.equal(home.line, '+0.5/1');
});

test('normalizeEvents keeps only the main line (ml 1) to avoid key collisions', () => {
  const ev = structuredClone(footballFixture.event);
  // Add an alternate handicap line (ml 2) with the same si/type -> same key.
  ev.markets.push({
    mi: 999, bti: 1, btn: '让球', gp: 1, ml: 2,
    ws: [
      { wsi: 111, si: 1, hdp: -1, dih: '-1', o: 0.9, ot: 2 },
      { wsi: 112, si: 2, hdp: -1, dih: '+1', o: 0.9, ot: 2 },
    ],
  });
  const { snapshot } = normalizeEvents(parseSeEvents(toGetSeResult([ev])), { scope: 'early', sport: 'football' });
  const handicaps = snapshot.events[0].markets.filter((m) => m.period === 'full_time' && m.type === 'handicap');
  assert.equal(handicaps.length, 1); // alternate line dropped
  assert.equal(handicaps[0].selections[0].line, '+0.5/1'); // the ml 1 line
});

test('normalized snapshots are accepted by the bet-draft validator end to end', async () => {
  for (const [fixture, sport, key, expected] of [
    [footballFixture, 'football', '111756567:full_time:handicap:home', '1.77'],
    [footballFixture, 'football', '111756567:full_time:1x2:draw', '1.76'],
    [basketballFixture, 'basketball', '111760946:full_time:moneyline:home', '1.39'],
  ]) {
    const upstream = {
      getSports: async ({ scope, sport: s }) => normalizeFixture(fixture, scope, s).snapshot,
    };
    const service = createBetDraftService({
      upstream,
      now: () => 1_700_000_000_000,
      idGenerator: () => 'draft-1',
    });
    const eventId = key.split(':')[0];
    const draft = await service.create({
      scope: 'early',
      sport,
      event_id: eventId,
      selection_key: key,
      stake: '1.00',
      expected_odds: expected,
      max_odds_drift: '0.10',
      idempotency_key: `idem-${key}`,
    });
    assert.equal(draft.state, 'ready_for_manual_confirmation');
    assert.equal(draft.current_odds, expected);
  }
});
