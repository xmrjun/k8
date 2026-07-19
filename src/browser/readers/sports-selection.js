'use strict';

const { CODES, upstreamError } = require('../../upstream/errors');

const SCOPE_LABELS = Object.freeze({
  live: '滚球中',
  today: '今日',
  early: '早盘',
});
const SPORT_LABELS = Object.freeze({
  football: '足球',
  basketball: '篮球',
  tennis: '网球',
});

function schemaError() {
  return upstreamError(CODES.SCHEMA_CHANGED, 'IM Sports selection schema changed');
}

function authError() {
  return upstreamError(CODES.AUTH_EXPIRED, 'IM Sports authentication expired');
}

function buildSportsSelectionExpression({
  scope,
  sport,
  maxWaitMs = 5_000,
  pollMs = 100,
} = {}) {
  if (!Object.hasOwn(SCOPE_LABELS, scope) || !Object.hasOwn(SPORT_LABELS, sport)) {
    throw new TypeError('supported scope and sport are required');
  }
  if (!Number.isInteger(maxWaitMs) || maxWaitMs < 1 || maxWaitMs > 10_000
    || !Number.isInteger(pollMs) || pollMs < 1 || pollMs > 1_000
    || pollMs > maxWaitMs) {
    throw new TypeError('selection wait values must be bounded positive integers');
  }

  const scopeLabel = SCOPE_LABELS[scope];
  const sportLabel = SPORT_LABELS[sport];
  const sectionLabel = scope === 'live' ? SCOPE_LABELS.live : '所有体育';
  return `(async () => {
    const scope = ${JSON.stringify(scope)};
    const scopeLabel = ${JSON.stringify(scopeLabel)};
    const sportLabel = ${JSON.stringify(sportLabel)};
    const sectionLabel = ${JSON.stringify(sectionLabel)};
    const maxWaitMs = ${maxWaitMs};
    const pollMs = ${pollMs};
    const all = (root, selector) => root && typeof root.querySelectorAll === 'function'
      ? Array.from(root.querySelectorAll(selector))
      : [];
    const one = (root, selector) => root && typeof root.querySelector === 'function'
      ? root.querySelector(selector)
      : null;
    const text = (node) => typeof node?.textContent === 'string'
      ? node.textContent.replace(/\\s+/g, ' ').trim()
      : '';
    const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const waitFor = async (predicate) => {
      const attempts = Math.max(1, Math.ceil(maxWaitMs / pollMs));
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (predicate()) return true;
        await delay(pollMs);
      }
      return Boolean(predicate());
    };
    const login = one(document, 'input[type="password"], form[action*="login"], .login-form');
    if (login) return { status: 'login_required' };

    const sections = all(document, '.main_left > .leftmenu_items').filter(
      (candidate) => text(one(candidate, '.sports_menu_header .menu_name')) === sectionLabel,
    );
    if (sections.length !== 1) return { status: 'schema_changed' };
    const section = sections[0];

    if (scope !== 'live') {
      const tabs = all(section, '.leftmenu_tab_filter .tab_label').filter(
        (candidate) => text(candidate) === scopeLabel,
      );
      if (tabs.length !== 1 || typeof tabs[0].click !== 'function') {
        return { status: 'schema_changed' };
      }
      const tab = tabs[0];
      const tabActive = () => Boolean(
        tab.classList?.contains?.('active')
        || tab.parentElement?.classList?.contains?.('active'),
      );
      if (!tabActive()) {
        tab.click();
        if (!await waitFor(tabActive)) return { status: 'schema_changed' };
        await delay(pollMs);
      }
    }

    const items = all(section, '.leftmenu_sports_item');
    if (items.length === 0) return { status: 'empty' };
    const matches = items.filter((item) => all(item, 'div,span').some(
      (candidate) => candidate.childElementCount === 0 && text(candidate) === sportLabel,
    ));
    if (matches.length === 0) return { status: 'empty' };
    if (matches.length !== 1) return { status: 'schema_changed' };
    const item = matches[0];

    if (scope === 'live') {
      const checkbox = one(item, 'input[type="checkbox"]');
      const control = one(item, 'label');
      if (!checkbox || !control || typeof control.click !== 'function') {
        return { status: 'schema_changed' };
      }
      if (!checkbox.checked) control.click();
    } else {
      const anchor = one(item, 'a');
      if (!anchor || typeof anchor.click !== 'function') return { status: 'schema_changed' };
      if (!item.classList?.contains?.('active')) anchor.click();
    }

    const selected = () => all(document, '.eventlisting_header').some((header) => {
      const value = text(header);
      return value.includes(scopeLabel) && value.includes(sportLabel);
    });
    if (!await waitFor(selected)) return { status: 'schema_changed' };
    return { status: 'ready' };
  })()`;
}

function normalizeSportsSelectionPayload(payload) {
  if (payload?.status === 'login_required') throw authError();
  if (payload?.status === 'ready') return { empty: false };
  if (payload?.status === 'empty') return { empty: true };
  throw schemaError();
}

module.exports = {
  buildSportsSelectionExpression,
  normalizeSportsSelectionPayload,
};
