'use strict';

const { authError, schemaError } = require('./common');

const SPORT_BY_LABEL = Object.freeze({
  足球: 'football',
  电子足球: 'electronic_football',
  篮球: 'basketball',
  电子篮球: 'electronic_basketball',
  电竞体育: 'esports',
  网球: 'tennis',
  魔幻弹珠: 'fantasy_marble',
  乒乓球: 'table_tennis',
  排球: 'volleyball',
  棒球: 'baseball',
  虚拟体育: 'virtual_sports',
  '拳击 / 综合格斗': 'combat_sports',
  '斯诺克/ 台球': 'snooker_billiards',
});
const TAB_BY_LABEL = Object.freeze({ 今日: 'today', 早盘: 'early', 串关: 'parlay' });
const COUNT_PATTERN = /^(?:0|[1-9]\d{0,8})$/;

function buildSportsCatalogExpression() {
  const labels = Object.keys(SPORT_BY_LABEL);
  return `(() => {
    const sportLabels = ${JSON.stringify(labels)};
    const one = (root, selector) => root && typeof root.querySelector === 'function'
      ? root.querySelector(selector)
      : null;
    const all = (root, selector) => root && typeof root.querySelectorAll === 'function'
      ? Array.from(root.querySelectorAll(selector))
      : [];
    const text = (node) => typeof node?.textContent === 'string'
      ? node.textContent.replace(/\\s+/g, ' ').trim()
      : '';
    const empty = (status) => ({
      status, tabs: [], live_sports: [], all_sports: [],
      popular_tournaments: [], odds_boost_sports: [],
    });
    if (one(document, 'input[type="password"], form[action*="login"], .login-form')) {
      return empty('login_required');
    }
    const live = one(document, '#leftpanel_live');
    const popular = one(document, '#leftpanel_popular_tournament');
    const allSports = one(document, '#leftpanel_all_sports');
    const boost = one(document, '#leftpanel_oddsboost');
    if (!live || !popular || !allSports || !boost) return empty('schema_changed');
    const labelFor = (item, root) => {
      const matches = sportLabels.filter((label) => all(item, root + ' div').some(
        (node) => node.children.length === 0 && text(node) === label,
      ));
      return matches.length === 1 ? matches[0] : '';
    };
    const sportRows = (root, headerSelector, labelRoot) => all(
      root, '.leftmenu_sports_item',
    ).slice(0, 30).map((item) => {
      const header = one(item, headerSelector) || item;
      return {
        label: labelFor(item, labelRoot),
        count: text(one(header, '.count')),
        live: text(one(header, '.noti_live')) === '滚球中',
      };
    });
    const liveSports = sportRows(
      live, '.leftmenu_sports_header', '.leftmenu_sports_header_checkbox_grp',
    ).map(({ label, count }) => ({ label, count }));
    const completeSports = sportRows(
      allSports, '.leftmenu_sports_header', '.leftmenu_sports_header',
    );
    const boostSports = sportRows(
      boost, '.leftmenu_sports_header', '.leftmenu_sports_header_checkbox_grp',
    ).map(({ label, count }) => ({ label, count }));
    const tabs = all(allSports, '.leftmenu_tab_filter .tab_label').slice(0, 6).map(text);
    const popularTournaments = all(popular, '.leftmenu_sports_item').slice(0, 30).map(
      (item) => {
        const countNode = one(item, '.count');
        const names = all(item, 'div').filter(
          (node) => node.children.length === 0 && node !== countNode && text(node),
        ).map(text).filter((value) => !/^\\d+$/.test(value));
        return { name: names.length === 1 ? names[0] : '', count: text(countNode) };
      },
    );
    if (liveSports.some((item) => !item.label || !item.count)
      || completeSports.some((item) => !item.label || !item.count)
      || boostSports.some((item) => !item.label || !item.count)
      || popularTournaments.some((item) => !item.name || !item.count)) {
      return empty('schema_changed');
    }
    return {
      status: 'ready', tabs, live_sports: liveSports, all_sports: completeSports,
      popular_tournaments: popularTournaments, odds_boost_sports: boostSports,
    };
  })()`;
}

function count(value) {
  if (typeof value !== 'string' || !COUNT_PATTERN.test(value)) {
    throw schemaError('IM Sports catalog schema changed');
  }
  return Number(value);
}

function sportRow(value, { includeLive = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw schemaError('IM Sports catalog schema changed');
  }
  const label = typeof value.label === 'string' ? value.label.trim() : '';
  const sport = SPORT_BY_LABEL[label];
  if (!sport || (includeLive && typeof value.live !== 'boolean')) {
    throw schemaError('IM Sports catalog schema changed');
  }
  const result = { sport, label, count: count(value.count) };
  if (includeLive) result.live = value.live;
  return result;
}

function tournament(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.name !== 'string') {
    throw schemaError('IM Sports catalog schema changed');
  }
  const rawName = value.name.trim();
  const featured = rawName.startsWith('*');
  const name = featured ? rawName.slice(1).trim() : rawName;
  if (!name || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw schemaError('IM Sports catalog schema changed');
  }
  return { name, count: count(value.count), featured };
}

function uniqueRows(rows, key) {
  if (!Array.isArray(rows) || rows.length > 30) {
    throw schemaError('IM Sports catalog schema changed');
  }
  const normalized = rows.map(key.normalize);
  if (new Set(normalized.map(key.value)).size !== normalized.length) {
    throw schemaError('IM Sports catalog schema changed');
  }
  return normalized;
}

function normalizeSportsCatalogPayload(payload) {
  if (payload?.status === 'login_required') {
    throw authError('IM Sports authentication expired');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || payload.status !== 'ready' || !Array.isArray(payload.tabs)
    || payload.tabs.length !== 3) {
    throw schemaError('IM Sports catalog schema changed');
  }
  const tabs = payload.tabs.map((label) => TAB_BY_LABEL[label]);
  if (tabs.some((value) => !value) || new Set(tabs).size !== 3) {
    throw schemaError('IM Sports catalog schema changed');
  }
  return {
    scopes: ['live', 'today', 'early'],
    tabs,
    live_sports: uniqueRows(payload.live_sports, {
      normalize: (value) => sportRow(value), value: (value) => value.sport,
    }),
    all_sports: uniqueRows(payload.all_sports, {
      normalize: (value) => sportRow(value, { includeLive: true }),
      value: (value) => value.sport,
    }),
    popular_tournaments: uniqueRows(payload.popular_tournaments, {
      normalize: tournament, value: (value) => value.name,
    }),
    odds_boost_sports: uniqueRows(payload.odds_boost_sports, {
      normalize: (value) => sportRow(value), value: (value) => value.sport,
    }),
  };
}

module.exports = {
  SPORT_BY_LABEL,
  buildSportsCatalogExpression,
  normalizeSportsCatalogPayload,
};

