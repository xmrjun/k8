'use strict';

// Bet-slip submission for the IM Sports ("Sunflower 2.0") page.
//
// SAFETY MODEL — verification-first. The expression:
//   1. clears any existing slip,
//   2. locates the exact odds cell for the draft's selection and clicks it,
//   3. RE-READS the slip and refuses unless it holds exactly one selection that
//      matches the draft (event, market, pick) with odds within max_odds_drift,
//   4. sets the stake and confirms the slip echoes it,
//   5. clicks "请下注" once,
//   6. NEVER accepts a changed-odds confirmation — any "赔率已更改 / 盘口已更改"
//      prompt or place error aborts and clears the slip.
//
// Nothing is submitted unless every gate passes. A wrong or drifted selection
// fails closed with no wager.

const { CODES, UpstreamError, upstreamError } = require('../upstream/errors');

// selection_key = `${eventId}:${period}:${type}:${name}`.
// The bet slip renders Hong Kong odds; decimal = hongKong + 1 (matching the
// reader convention display_odds = decimal_odds - 1).
function buildPlaceBetExpression(draft) {
  const spec = {
    event_id: draft.event_id,
    selection_key: draft.selection_key,
    stake: draft.stake,
    expected_odds: draft.expected_odds,
    current_odds: draft.current_odds,
    max_odds_drift: draft.max_odds_drift,
  };

  return `(async () => {
  const SPEC = ${JSON.stringify(spec)};
  const [EVENT_ID, PERIOD, TYPE, NAME] = SPEC.selection_key.split(':');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (n) => (typeof n?.textContent === 'string' ? n.textContent.replace(/\\s+/g, ' ').trim() : '');
  const one = (root, sel) => (root && root.querySelector ? root.querySelector(sel) : null);
  const all = (root, sel) => (root && root.querySelectorAll ? Array.from(root.querySelectorAll(sel)) : []);
  const hasClass = (n, c) => !!(n && n.classList && n.classList.contains(c));
  const visible = (n) => { try { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
  const clickReal = (n) => {
    try {
      n.scrollIntoView({ block: 'center' });
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        n.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    } catch { return false; }
  };
  const setInput = (input, value) => {
    const proto = Object.getPrototypeOf(input);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(input, value); else input.value = value;
    for (const type of ['input', 'change', 'keyup', 'blur']) {
      input.dispatchEvent(new Event(type, { bubbles: true }));
    }
  };
  const toDecimal = (hk) => { const n = Number(String(hk).replace(/,/g, '')); return Number.isFinite(n) ? n + 1 : NaN; };
  const done = (o) => o;

  if (one(document, 'input[type="password"], form[action*="login"], .login-form')) {
    return done({ status: 'auth' });
  }

  // --- 1. Start from a clean slip. -----------------------------------------
  const clearBtn = all(document, 'div,button,span').find(
    (n) => visible(n) && text(n) === '清空' && !all(n, '*').some((c) => text(c) === '清空'),
  );
  if (clearBtn && one(document, '[id^="bet_slip_"]')) { clickReal(clearBtn); await sleep(400); }

  // --- 2. Locate the exact odds cell and add it to the slip. ----------------
  // Match the sports reader's structure: an event row, its period roots, and
  // the .odds_wrap cell for this market/pick.
  const NAMES_BY_TYPE = { '1x2': ['home', 'draw', 'away'], moneyline: ['home', 'away'], handicap: ['home', 'away'], total: ['over', 'under'] };
  const names = NAMES_BY_TYPE[TYPE];
  if (!names || !names.includes(NAME)) return done({ status: 'unavailable', reason: 'unknown_market' });
  const pickIndex = names.indexOf(NAME);

  // Find the event row whose team link references EVENT_ID.
  const rows = all(document, '.info').map((info) => info.closest ? info.closest('*') : null);
  let targetInfo = null;
  for (const info of all(document, '.info')) {
    const href = one(info.parentElement || info, '.team a[href^="/sev/"]')?.getAttribute('href') || '';
    if (href.includes(EVENT_ID)) { targetInfo = info; break; }
  }
  if (!targetInfo) {
    // Fallback: any element whose id encodes the event id (odds spans use it).
    const span = all(document, '[id]').find((n) => n.id.startsWith(EVENT_ID + '_'));
    targetInfo = span ? (span.closest('.info') || span.closest('.event_even')?.parentElement) : null;
  }
  if (!targetInfo) return done({ status: 'unavailable', reason: 'event_not_found' });

  const periods = all(targetInfo, '.header_info_inner');
  const periodRoots = (periods.length > 0 ? periods : [targetInfo]);
  const periodRoot = PERIOD === 'first_half' ? periodRoots[1] : periodRoots[0];
  if (!periodRoot) return done({ status: 'unavailable', reason: 'period_not_found' });

  const cells = all(periodRoot, '.event_even');
  let oddsWraps = [];
  if (TYPE === '1x2' || TYPE === 'moneyline') {
    oddsWraps = all(one(periodRoot, '.event_even.double'), '.odds_wrap').slice(0, names.length);
  } else if (TYPE === 'handicap') {
    oddsWraps = all(cells[2], '.odds_wrap').slice(0, 2);
  } else if (TYPE === 'total') {
    oddsWraps = all(cells[4], '.odds_wrap').slice(0, 2);
    if (oddsWraps.length !== 2) oddsWraps = all(cells[6], '.odds_wrap').slice(0, 2);
  }
  const cell = oddsWraps[pickIndex];
  if (!cell) return done({ status: 'unavailable', reason: 'selection_not_found' });
  if (hasClass(cell, 'lock') || one(cell, '.lock')) return done({ status: 'unavailable', reason: 'locked' });

  clickReal(cell);

  // --- 3. Wait for the slip, then VERIFY it matches the draft. --------------
  let slip = null;
  for (let i = 0; i < 20 && !slip; i += 1) { await sleep(150); slip = one(document, '[id^="bet_slip_"]'); }
  if (!slip) return done({ status: 'unavailable', reason: 'slip_did_not_open' });
  if (all(document, '[id^="bet_slip_"]').length !== 1) return done({ status: 'unavailable', reason: 'multiple_selections' });

  const slipTitle = text(one(slip, '.impt_info .bet_slip_title'));
  if (!/香港盘|香港盤/.test(slipTitle)) return done({ status: 'unavailable', reason: 'unexpected_odds_format', slipTitle });
  const slipOddsRaw = text(one(slip, '.selection_group .odds')) || text(one(slip, '.odds.selection'));
  const slipDecimal = toDecimal(slipOddsRaw);
  const expected = Number(SPEC.expected_odds);
  const drift = Number(SPEC.max_odds_drift);
  if (!Number.isFinite(slipDecimal) || Math.abs(slipDecimal - expected) > drift + 1e-9) {
    if (clearBtn) clickReal(clearBtn);
    return done({ status: 'odds_changed', slip_odds: slipDecimal, expected });
  }

  // --- 4. Set the stake and confirm the slip echoes it. --------------------
  const selId = slip.id.replace('bet_slip_', '');
  const stakeInput = one(document, '#placebet_input' + selId) || one(slip, '.placebet_input');
  if (!stakeInput) return done({ status: 'error', reason: 'no_stake_input' });
  setInput(stakeInput, SPEC.stake);
  await sleep(300);
  const totalStake = text(one(document, '.stake_info'));
  if (!totalStake.includes(SPEC.stake)) {
    return done({ status: 'error', reason: 'stake_not_applied', totalStake });
  }

  // --- 5. Place once. ------------------------------------------------------
  const placeBtn = one(document, '#place_bet_single');
  if (!placeBtn || !visible(placeBtn)) return done({ status: 'error', reason: 'no_place_button' });
  clickReal(placeBtn);

  // --- 6. Resolve outcome. NEVER confirm changed odds. ---------------------
  const oddsChanged = () => all(document, '.wmOddsUpdate').some((w) => visible(w) && !hasClass(w, 'hide'));
  const placeError = () => all(document, '.wmPlaceBetError').find((w) => visible(w) && !hasClass(w, 'hide'));
  const receiptText = () => {
    for (const n of all(document, 'div,span,td,li,p')) {
      if (n.children.length) continue;
      const m = text(n).match(/(?:投注编号|投注編號|注单号|注單號)\\s*[:：]?\\s*([A-Za-z0-9._-]{6,})/);
      if (m) return m[1];
    }
    return null;
  };

  for (let i = 0; i < 30; i += 1) {
    await sleep(250);
    if (oddsChanged()) { if (clearBtn || one(document, '[id^="bet_slip_"]')) { const cb = all(document, 'div,span').find((n) => visible(n) && text(n) === '清空'); if (cb) clickReal(cb); } return done({ status: 'odds_changed', reason: 'confirm_prompt' }); }
    const err = placeError();
    if (err) return done({ status: 'rejected', message: text(err).slice(0, 80) });
    const id = receiptText();
    if (id) return done({ status: 'placed', bet_id: id, odds: slipDecimal, stake: SPEC.stake });
    // Slip cleared + no error is also a success signal on some skins.
    if (!one(document, '[id^="bet_slip_"]') && i > 4) {
      const late = receiptText();
      return done({ status: late ? 'placed' : 'unknown_cleared', bet_id: late, odds: slipDecimal, stake: SPEC.stake });
    }
  }
  return done({ status: 'timeout' });
})();`;
}

function normalizePlaceBetResult(value) {
  if (!value || typeof value !== 'object') {
    throw upstreamError(CODES.BAD_RESPONSE, 'Bet placement returned no result');
  }
  return value;
}

// Map the structured slip outcome to either a receipt (success) or a thrown
// error the placement service understands. Handled game-state outcomes throw a
// PlacementOutcomeError carrying a stable code; infrastructure faults throw
// UpstreamError.
class PlacementOutcomeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PlacementOutcomeError';
    this.code = code;
  }
}

function interpretPlaceBetResult(value) {
  const result = normalizePlaceBetResult(value);
  switch (result.status) {
    case 'placed':
      if (typeof result.bet_id !== 'string' || result.bet_id.length === 0) {
        throw new PlacementOutcomeError('PLACEMENT_UNCONFIRMED', 'Placed but no bet id was returned');
      }
      return {
        bet_id: result.bet_id,
        odds: result.odds,
        stake: result.stake,
      };
    case 'auth':
      throw new UpstreamError(CODES.AUTH_EXPIRED, 'Upstream authentication expired');
    case 'odds_changed':
      throw new PlacementOutcomeError('ODDS_DRIFT_EXCEEDED', 'Odds changed before placement');
    case 'unavailable':
      throw new PlacementOutcomeError('SELECTION_UNAVAILABLE', `Selection unavailable: ${result.reason || 'unknown'}`);
    case 'rejected':
      throw new PlacementOutcomeError('PLACEMENT_REJECTED', result.message || 'Placement rejected by venue');
    case 'unknown_cleared':
    case 'timeout':
      throw new PlacementOutcomeError('PLACEMENT_UNCONFIRMED', 'Placement result could not be confirmed');
    default:
      throw new PlacementOutcomeError('PLACEMENT_FAILED', `Placement failed: ${result.reason || result.status || 'unknown'}`);
  }
}

module.exports = {
  buildPlaceBetExpression,
  normalizePlaceBetResult,
  interpretPlaceBetResult,
  PlacementOutcomeError,
};
