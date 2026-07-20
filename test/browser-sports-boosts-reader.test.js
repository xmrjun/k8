'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSportsBoostsExpression,
  normalizeSportsBoostsPayload,
} = require('../src/browser/readers/sports-boosts');
const { CODES } = require('../src/upstream/errors');

function payload() {
  return {
    status: 'ready',
    offers: [
      {
        kind: '赛事串关', participants: '146 参与',
        description: '主队 vs 客队 1X2 客 双方球队皆进球 是',
        original_odds: '6.71', boosted_odds: '7.24',
      },
      {
        kind: '连串过关', participants: '',
        description: '双方球队皆进球 是 主队 vs 客队',
        original_odds: '6.91', boosted_odds: '7.60',
      },
    ],
  };
}

test('normalizes visible event and chain parlay boost cards', () => {
  assert.deepEqual(normalizeSportsBoostsPayload(payload()), {
    offers: [
      {
        kind: 'event_parlay', participants: 146,
        description: '主队 vs 客队 1X2 客 双方球队皆进球 是',
        original_odds: '6.71', boosted_odds: '7.24', available: true,
      },
      {
        kind: 'chain_parlay', participants: null,
        description: '双方球队皆进球 是 主队 vs 客队',
        original_odds: '6.91', boosted_odds: '7.60', available: true,
      },
    ],
    count: 2,
    truncated: false,
  });
});

test('keeps a visible boost card but marks a missing boosted price unavailable', () => {
  const value = payload();
  value.offers = [value.offers[0]];
  value.offers[0].boosted_odds = '';
  assert.deepEqual(normalizeSportsBoostsPayload(value).offers[0], {
    kind: 'event_parlay',
    participants: 146,
    description: '主队 vs 客队 1X2 客 双方球队皆进球 是',
    original_odds: '6.71',
    boosted_odds: null,
    available: false,
  });
});

test('boosts reject unknown kinds, malformed odds, and oversized results', () => {
  for (const mutate of [
    (value) => { value.offers[0].kind = '未知'; },
    (value) => { value.offers[0].boosted_odds = '免费'; },
    (value) => { value.offers[0].description = ''; },
    (value) => { value.offers = Array.from({ length: 51 }, () => value.offers[0]); },
  ]) {
    const value = payload();
    mutate(value);
    assert.throws(
      () => normalizeSportsBoostsPayload(value),
      (error) => error?.code === CODES.SCHEMA_CHANGED && !error.cause,
    );
  }
});

test('boosts login marker maps to UPSTREAM_AUTH_EXPIRED', () => {
  assert.throws(
    () => normalizeSportsBoostsPayload({ status: 'login_required' }),
    (error) => error?.code === CODES.AUTH_EXPIRED && !error.cause,
  );
});

test('boost expression is bounded and cannot invoke a betting action', () => {
  const expression = buildSportsBoostsExpression({ maxOffers: 50 });
  for (const selector of [
    '.ob_card', '.ob_pap_label', '.ob_bet_placed', '.ob_pap',
    '.odds.ob_odds.old', '.odds.ob_odds.new',
  ]) assert.equal(expression.includes(selector), true, selector);
  assert.match(expression, /slice\(0, maxOffers\)/);
  for (const forbidden of [
    'cookie', 'localstorage', 'sessionstorage', 'indexeddb', 'fetch(',
    'xmlhttprequest', 'websocket', 'location.href', '.click(', 'submit',
    'cashout', 'confirm',
  ]) assert.equal(expression.toLowerCase().includes(forbidden), false, forbidden);
});

test('boost expression rejects unsafe bounds', () => {
  for (const maxOffers of [0, 51, 1.5, '50']) {
    assert.throws(() => buildSportsBoostsExpression({ maxOffers }), /maxOffers/);
  }
});
