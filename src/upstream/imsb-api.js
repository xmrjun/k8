'use strict';

// IM Sports ("Sunflower 2.0") JSON-API integration.
//
// Instead of scraping/clicking the DOM, we execute the venue's own JSON API
// from the logged-in page context via the browser gateway's `evaluate`.
//
// AUTH (verified 2026-07-22): the venue authenticates each /api call with the
// session token in an `x-token` header plus a few constant headers. The token is
// the `?token=` value on the page URL (also mirrored in localStorage
// `siteProfile.t`), and it EXPIRES — a stale token yields StatusCode != 100 and
// the session must be re-seeded. The per-request `x-sc` signature the site also
// sends is NOT enforced by the server, so we do not reproduce it. The token
// stays in the browser: FETCH_HEADERS reads it in page context and never leaves.
// See docs/plans/2026-07-22-imsb-live-protocol.md.
//
// This module builds the page expressions and provides the pure parsers/
// interpreters (unit-tested). Reading odds = EventV6/GetSE (pre-match) /
// GetSEDelta (live). Placing = PlaceBetV6/GetBI then SPB.

const { CODES, upstreamError } = require('./errors');

// Headers snippet evaluated in page context on every call: reads the session
// token (URL ?token=, falling back to localStorage siteProfile.t) into x-token,
// plus the venue's constant headers. No x-sc (server does not enforce it).
const FETCH_HEADERS = "(()=>{let t='';try{t=new URLSearchParams(location.search).get('token')||'';}catch(e){}if(!t){try{const p=JSON.parse(localStorage.getItem('siteProfile'));if(p&&p.t)t=p.t;}catch(e){}}return{'Accept':'application/json','Content-Type':'application/json;charset=UTF-8','x-token':t,'x-v':'90594','x-platform':'3','x-lang':'hans','x-oddsTemp':'3','x-oddsTempBetType':'1'};})()";

// In-page projection. The raw GetSE/GetSEDelta payload is several MB (1600+
// events with every market), which blows the CDP evaluate message limit. Strip
// each event to the fields the server parser needs — mapped bet types (1-4) on
// the main line (ml 1) only — and cap the event count, so the response stays
// small. parseSeEvents/parseSeDelta read this reduced shape unchanged.
const REDUCE_EVENT = "(ev)=>({eid:ev.eid,htn:ev.htn,atn:ev.atn,cn:ev.cn,iop:ev.iop,edt:ev.edt,hs:ev.hs,as:ev.as,mls:(ev.mls||[]).filter(m=>m&&m.ml===1&&[1,2,3,4].indexOf(m.bti)>=0).map(m=>({mi:m.mi,bti:m.bti,btn:m.btn,gp:m.gp,ml:m.ml,ws:(m.ws||[]).map(w=>({wsi:w.wsi,si:w.si,hdp:w.hdp,dih:w.dih,s:w.s,o:w.o,ot:w.ot}))}))})";
const MAX_SNAPSHOT_EVENTS = 500;

// ---- Reading odds --------------------------------------------------------

function buildGetEventsExpression({ sportId = 1, oddsType = 2 } = {}) {
  const body = JSON.stringify({ Type: 2, OddsType: oddsType, SportId: sportId });
  return `(async () => {
    try {
      const res = await fetch('/api/EventV6/GetESI', { method:'POST', headers:${FETCH_HEADERS}, body: ${JSON.stringify(body)} });
      const text = await res.text();
      let data = null; try { data = JSON.parse(text); } catch (e) {}
      return { ok: res.status === 200 && !!data, status: res.status, data };
    } catch (e) { return { ok: false, status: 0, error: String(e && e.message) }; }
  })();`;
}

// EventV6/GetSE is the FULL pre-match/live snapshot (unlike GetESI, which is a
// "highlights" subset carrying single selections and no handicap/total). The
// filter selects a market group (1 = pre-match 早盘, 3 = live 滚球), the bet
// types, and periods. Events come back in `data.sel` (each with `mls` markets);
// `data.d` is a compressed side-dictionary we do not need — `sel` is complete.
function buildGetSeExpression({
  sportId = 1,
  market = 1,
  betTypeIds = [1, 2, 3, 4],
  gamePeriods = [1, 2],
  dateFrom = '',
  dateTo = '',
} = {}) {
  const body = JSON.stringify({
    SportId: sportId,
    Market: market,
    BetTypeIds: betTypeIds,
    GamePeriods: gamePeriods,
    IsCombo: false,
    OddsType: 2,
    DateFrom: dateFrom,
    DateTo: dateTo,
    CompetitionIds: [],
    SortType: 2,
    ProgrammeIds: [],
  });
  return `(async () => {
    try {
      const res = await fetch('/api/EventV6/GetSE', { method:'POST', headers:${FETCH_HEADERS}, body: ${JSON.stringify(body)} });
      const text = await res.text();
      let data = null; try { data = JSON.parse(text); } catch (e) {}
      if (data && Array.isArray(data.sel)) data = { StatusCode: data.StatusCode, sel: data.sel.slice(0, ${MAX_SNAPSHOT_EVENTS}).map(${REDUCE_EVENT}) };
      return { ok: res.status === 200 && !!data, status: res.status, data };
    } catch (e) { return { ok: false, status: 0, error: String(e && e.message) }; }
  })();`;
}

// Parse a GetSE result into a flat list of selections carrying the identifiers a
// placement needs plus the market descriptors (bti/gp/ml/si/hdp/dih/ot) the
// normalizer maps into the draft model. Pure — unit-tested against real captures.
function parseSeEvents(result) {
  if (!result || result.ok === false) {
    throw upstreamError(CODES.BROWSER_UNAVAILABLE, 'GetSE call failed');
  }
  const data = result.data;
  if (!data || data.StatusCode !== 100 || !Array.isArray(data.sel)) {
    throw upstreamError(CODES.BAD_RESPONSE, 'GetSE returned an unexpected shape');
  }
  const selections = [];
  for (const event of data.sel) {
    if (!event || typeof event.eid !== 'number') continue;
    const base = {
      eid: event.eid,
      home: event.htn,
      away: event.atn,
      competition: event.cn,
      live: !!event.iop,
      starts_at: event.edt,
    };
    for (const market of event.mls || []) {
      if (!Array.isArray(market.ws)) continue;
      for (const w of market.ws) {
        if (typeof w.wsi !== 'number' || typeof w.o !== 'number') continue;
        selections.push({
          ...base,
          bet_type_id: market.bti,
          bet_type_name: market.btn,
          game_period: market.gp,
          market_line: market.ml, // ml 1 = main line, 2+ = alternates
          market_id: market.mi, // -> SPB mlid
          selection_id: w.si,
          wager_selection_id: w.wsi, // -> SPB wsid
          handicap: typeof w.hdp === 'number' ? w.hdp : null,
          line: typeof w.dih === 'string' ? w.dih : (w.s || ''),
          odds: w.o,
          odds_type: w.ot, // 2 = Hong Kong, 3 = European decimal
        });
      }
    }
  }
  return { count: selections.length, selections };
}

// Parse a GetESI result into a flat list of selections carrying the identifiers
// SPB needs. Pure — unit-tested against captured shapes.
function parseEvents(result) {
  if (!result || result.ok === false) {
    throw upstreamError(CODES.BROWSER_UNAVAILABLE, 'GetESI call failed');
  }
  const data = result.data;
  if (!data || data.StatusCode !== 100 || !Array.isArray(data.es)) {
    throw upstreamError(CODES.BAD_RESPONSE, 'GetESI returned an unexpected shape');
  }
  const selections = [];
  for (const entry of data.es) {
    const event = Array.isArray(entry.e) ? entry.e[0] : entry.e;
    if (!event || typeof event.eid !== 'number') continue;
    const base = {
      eid: event.eid,
      home: event.htn,
      away: event.atn,
      competition: event.cn,
      live: !!event.iop,
      starts_at: event.edt,
    };
    for (const market of event.mls || []) {
      if (!Array.isArray(market.ws)) continue;
      for (const w of market.ws) {
        if (typeof w.wsi !== 'number' || typeof w.o !== 'number') continue;
        selections.push({
          ...base,
          bet_type_id: market.bti,
          bet_type_name: market.btn,
          game_period: market.gp,
          market_id: market.mi, // -> SPB mlid
          selection_id: w.si,
          wager_selection_id: w.wsi, // -> SPB wsid
          line: w.s,
          odds: w.o, // European decimal
          odds_type: w.ot,
        });
      }
    }
  }
  return { count: selections.length, odds_boost_count: data.obc, selections };
}

// ---- Placing a bet -------------------------------------------------------

// `sel` carries the identifiers from parseEvents plus the caller's guardrail
// inputs. The expression: GetBI (validate + live odds + venue limits) ->
// enforce drift and venue min/max -> build SPB from GetBI's canonical wss[0] ->
// submit. It never accepts drift beyond `maxOddsDrift`.
function buildPlaceExpression(sel) {
  const spid = sel.spid ?? 1;
  const gbi = {
    wss: [{
      spid,
      eid: sel.eid,
      btid: sel.bet_type_id,
      gp: sel.game_period,
      otid: sel.odds_type,
      mlid: sel.market_id,
      wsid: sel.wager_selection_id,
      btsid: sel.bet_type_sub_id ?? 0,
      h: sel.line_value ?? 0,
      o: sel.odds,
      spf: '',
      md: 0,
      sid: 0,
      refid: sel.wager_selection_id,
      wt: 1,
    }],
    wt: 1,
  };
  const params = {
    stake: String(sel.stake),
    expected: Number(sel.expected_odds),
    drift: Number(sel.max_odds_drift),
    spid,
    gp: sel.game_period,
  };
  return `(async () => {
    const P = ${JSON.stringify(params)};
    const post = async (path, body) => {
      const r = await fetch(path, { method:'POST', headers:${FETCH_HEADERS}, body: JSON.stringify(body) });
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
      return { status: r.status, data: j };
    };
    try {
      const bi = await post('/api/PlaceBetV6/GetBI', ${JSON.stringify(gbi)});
      if (!bi.data || bi.data.StatusCode !== 100) return { status:'unavailable', stage:'GetBI', code: bi.data && bi.data.StatusCode };
      const info = (bi.data.wss || [])[0];
      const lim = (bi.data.bset || [])[0];
      if (!info) return { status:'unavailable', stage:'GetBI', reason:'no_selection' };
      const curOdds = Number(info.o);
      if (!Number.isFinite(curOdds) || Math.abs(curOdds - P.expected) > P.drift + 1e-9) {
        return { status:'odds_changed', current_odds: curOdds, expected: P.expected };
      }
      if (lim) {
        const stakeNum = Number(P.stake);
        if (Number.isFinite(Number(lim.mib)) && stakeNum < Number(lim.mib)) return { status:'limit', reason:'below_min', mib: lim.mib, mab: lim.mab };
        if (Number.isFinite(Number(lim.mab)) && stakeNum > Number(lim.mab)) return { status:'limit', reason:'above_max', mib: lim.mib, mab: lim.mab };
      }
      // Build SPB from GetBI's canonical selection (authoritative field values).
      // Field set verified against a real placement (2026-07-22, see
      // test/fixtures/imsb-placement-flow.json): no hs/as — the venue omits the
      // score from a pre-match SPB, and extra fields risk rejection.
      const ws = {
        spid: info.spid ?? P.spid, eid: info.eid, m: info.m, otid: info.otid, btid: info.btid,
        mlid: info.mlid, wsid: info.wsid, btsid: info.btsid,
        h: info.h, o: info.o, ortid: info.ortid ?? 0, spf: '', Matchday: 0, SeasonId: 0, gp: P.gp,
      };
      const spb = await post('/api/PlaceBetV6/SPB', { s: P.stake, ws, fpf: 'MacIntel' });
      if (spb.data && spb.data.StatusCode === 100) {
        return { status:'placed', bet_id: String(spb.data.wid), accepted_odds: spb.data.ao, balance: spb.data.ab };
      }
      return { status:'rejected', code: spb.data && spb.data.StatusCode };
    } catch (e) { return { status:'error', error: String(e && e.message) }; }
  })();`;
}

// Interpret the structured result of buildPlaceExpression into a receipt or a
// thrown, categorized error. Pure — unit-tested.
class ImsbPlacementError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ImsbPlacementError';
    this.code = code;
  }
}

function interpretPlaceResult(value) {
  if (!value || typeof value !== 'object') {
    throw upstreamError(CODES.BAD_RESPONSE, 'Placement returned no result');
  }
  switch (value.status) {
    case 'placed':
      if (typeof value.bet_id !== 'string' || value.bet_id.length === 0 || value.bet_id === 'undefined') {
        throw new ImsbPlacementError('PLACEMENT_UNCONFIRMED', 'Placed but no bet id was returned');
      }
      return { bet_id: value.bet_id, accepted_odds: value.accepted_odds, balance: value.balance };
    case 'odds_changed':
      throw new ImsbPlacementError('ODDS_DRIFT_EXCEEDED', 'Odds changed beyond tolerance before placement');
    case 'limit':
      throw new ImsbPlacementError('PLACEMENT_REJECTED', `Stake outside venue limits (${value.reason || 'limit'})`);
    case 'unavailable':
      throw new ImsbPlacementError('SELECTION_UNAVAILABLE', `Selection unavailable (${value.reason || value.stage || 'unknown'})`);
    case 'rejected':
      throw new ImsbPlacementError('PLACEMENT_REJECTED', `Venue rejected placement (code ${value.code})`);
    case 'error':
      throw upstreamError(CODES.BROWSER_UNAVAILABLE, `Placement failed: ${value.error || 'unknown'}`);
    default:
      throw new ImsbPlacementError('PLACEMENT_FAILED', `Placement failed: ${value.status || 'unknown'}`);
  }
}

module.exports = {
  buildGetEventsExpression,
  parseEvents,
  buildGetSeExpression,
  parseSeEvents,
  buildPlaceExpression,
  interpretPlaceResult,
  ImsbPlacementError,
};
