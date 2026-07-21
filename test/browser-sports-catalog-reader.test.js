'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSportsCatalogExpression,
  normalizeSportsCatalogPayload,
} = require('../src/browser/readers/sports-catalog');
const { CODES } = require('../src/upstream/errors');

function readyPayload() {
  return {
    status: 'ready',
    tabs: ['今日', '早盘', '串关'],
    live_sports: [
      { label: '足球', count: '5' },
      { label: '篮球', count: '16' },
      { label: '棒球', count: '2' },
    ],
    all_sports: [
      { label: '足球', count: '714', live: true },
      { label: '电子足球', count: '664', live: true },
      { label: '篮球', count: '189', live: true },
      { label: '电子篮球', count: '145', live: true },
      { label: '电竞体育', count: '16', live: false },
      { label: '网球', count: '159', live: true },
      { label: '魔幻弹珠', count: '4', live: true },
      { label: '乒乓球', count: '222', live: true },
      { label: '羽毛球', count: '56', live: true },
      { label: '排球', count: '7', live: false },
      { label: '棒球', count: '10', live: true },
      { label: '虚拟体育', count: '320', live: false },
      { label: '拳击 / 综合格斗', count: '2', live: false },
      { label: '斯诺克/ 台球', count: '20', live: false },
    ],
    popular_tournaments: [
      { name: '*英格兰超级联赛', count: '17' },
      { name: 'WNBA美国女子职业篮球联赛', count: '14' },
    ],
    odds_boost_sports: [{ label: '足球', count: '5' }],
  };
}

test('normalizes sports catalog, popular tournaments, and navigation tabs', () => {
  assert.deepEqual(normalizeSportsCatalogPayload(readyPayload()), {
    scopes: ['live', 'today', 'early'],
    tabs: ['today', 'early', 'parlay'],
    live_sports: [
      { sport: 'football', label: '足球', count: 5 },
      { sport: 'basketball', label: '篮球', count: 16 },
      { sport: 'baseball', label: '棒球', count: 2 },
    ],
    all_sports: [
      { sport: 'football', label: '足球', count: 714, live: true },
      { sport: 'electronic_football', label: '电子足球', count: 664, live: true },
      { sport: 'basketball', label: '篮球', count: 189, live: true },
      { sport: 'electronic_basketball', label: '电子篮球', count: 145, live: true },
      { sport: 'esports', label: '电竞体育', count: 16, live: false },
      { sport: 'tennis', label: '网球', count: 159, live: true },
      { sport: 'fantasy_marble', label: '魔幻弹珠', count: 4, live: true },
      { sport: 'table_tennis', label: '乒乓球', count: 222, live: true },
      { sport: 'badminton', label: '羽毛球', count: 56, live: true },
      { sport: 'volleyball', label: '排球', count: 7, live: false },
      { sport: 'baseball', label: '棒球', count: 10, live: true },
      { sport: 'virtual_sports', label: '虚拟体育', count: 320, live: false },
      { sport: 'combat_sports', label: '拳击 / 综合格斗', count: 2, live: false },
      { sport: 'snooker_billiards', label: '斯诺克/ 台球', count: 20, live: false },
    ],
    popular_tournaments: [
      { name: '英格兰超级联赛', count: 17, featured: true },
      { name: 'WNBA美国女子职业篮球联赛', count: 14, featured: false },
    ],
    odds_boost_sports: [{ sport: 'football', label: '足球', count: 5 }],
  });
});

test('catalog rejects unknown sports, missing tabs, and malformed counts', () => {
  for (const mutate of [
    (payload) => { payload.all_sports[0].label = '未知体育'; },
    (payload) => { payload.tabs = ['今日', '早盘']; },
    (payload) => { payload.live_sports[0].count = '-1'; },
    (payload) => { payload.popular_tournaments[0].name = ''; },
  ]) {
    const payload = readyPayload();
    mutate(payload);
    assert.throws(
      () => normalizeSportsCatalogPayload(payload),
      (error) => error?.code === CODES.SCHEMA_CHANGED && !error.cause,
    );
  }
});

test('catalog login marker maps to UPSTREAM_AUTH_EXPIRED', () => {
  assert.throws(
    () => normalizeSportsCatalogPayload({ status: 'login_required' }),
    (error) => error?.code === CODES.AUTH_EXPIRED && !error.cause,
  );
});

test('catalog expression is bounded to verified read-only navigation selectors', () => {
  const expression = buildSportsCatalogExpression();
  for (const selector of [
    '#leftpanel_live',
    '#leftpanel_popular_tournament',
    '#leftpanel_all_sports',
    '#leftpanel_oddsboost',
    '.leftmenu_sports_item',
  ]) assert.equal(expression.includes(selector), true, selector);
  assert.match(expression, /slice\(0, 30\)/);
  for (const forbidden of [
    'cookie', 'localstorage', 'sessionstorage', 'indexeddb', 'fetch(',
    'xmlhttprequest', 'websocket', 'location.href', '.click(', 'cashout',
  ]) assert.equal(expression.toLowerCase().includes(forbidden), false, forbidden);
});
