'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const {
  buildSportsSelectionExpression,
  normalizeSportsSelectionPayload,
} = require('../src/browser/readers/sports-selection');
const { CODES } = require('../src/upstream/errors');

function element({ text = '', classes = [], selectors = {}, onClick } = {}) {
  const classSet = new Set(classes);
  return {
    textContent: text,
    children: [],
    childElementCount: 0,
    checked: false,
    classList: {
      contains(name) { return classSet.has(name); },
      add(name) { classSet.add(name); },
      remove(name) { classSet.delete(name); },
    },
    querySelectorAll(selector) {
      const value = selectors[selector];
      return typeof value === 'function' ? value() : (value || []);
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
    click() {
      onClick?.(this);
    },
  };
}

function sportItem(label, { live = false, onSelect } = {}) {
  const leaf = element({ text: label });
  const checkbox = element();
  const control = element({
    onClick() {
      checkbox.checked = true;
      onSelect?.();
    },
  });
  const anchor = element({ onClick: onSelect });
  return element({
    selectors: {
      'div,span': [leaf],
      'input[type="checkbox"]': live ? [checkbox] : [],
      label: live ? [control] : [],
      a: live ? [] : [anchor],
    },
  });
}

function section(name, items, extraSelectors = {}) {
  return element({
    selectors: {
      '.sports_menu_header .menu_name': [element({ text: name })],
      '.leftmenu_sports_item': items,
      ...extraSelectors,
    },
  });
}

function selectionDocument({
  requestedScope,
  requestedSport,
  missingSport = false,
  duplicateLive = false,
  delayedScopeSport = false,
} = {}) {
  const sportLabel = {
    football: '足球',
    basketball: '篮球',
    tennis: '网球',
  }[requestedSport];
  let listingHeaders = [];
  const selectedHeader = requestedScope === 'live'
    ? `滚球中 ${sportLabel}`
    : `${requestedScope === 'today' ? '今日' : '早盘'} ${sportLabel}`;
  const selectRequested = () => {
    listingHeaders = [element({ text: selectedHeader })];
  };

  const liveItems = [
    sportItem(missingSport ? '足球' : sportLabel, {
      live: true,
      onSelect: selectRequested,
    }),
  ];
  const liveSection = section('滚球中', liveItems);
  const earlyTab = element({
    text: '早盘',
    onClick(tab) {
      tab.classList.add('active');
      if (delayedScopeSport) {
        setTimeout(() => {
          allItems = [sportItem(sportLabel, { onSelect: selectRequested })];
        }, 3);
      }
    },
  });
  const todayTab = element({ text: '今日', classes: ['active'] });
  let allItems = [sportItem(
    missingSport || delayedScopeSport ? '足球' : sportLabel,
    { onSelect: selectRequested },
  )];
  const allSection = section('所有体育', allItems, {
    '.leftmenu_tab_filter .tab_label': [todayTab, earlyTab],
    '.leftmenu_sports_item': () => allItems,
  });
  const sections = duplicateLive
    ? [liveSection, section('滚球中', liveItems), allSection]
    : [liveSection, allSection];

  return element({
    selectors: {
      '.main_left > .leftmenu_items': sections,
      '.eventlisting_header': () => listingHeaders,
      'input[type="password"], form[action*="login"], .login-form': [],
    },
  });
}

async function evaluateSelection(options, documentOptions = {}) {
  const expression = buildSportsSelectionExpression({
    ...options,
    maxWaitMs: 20,
    pollMs: 1,
  });
  return JSON.parse(JSON.stringify(await vm.runInNewContext(expression, {
    document: selectionDocument({
      requestedScope: options.scope,
      requestedSport: options.sport,
      ...documentOptions,
    }),
    setTimeout,
  })));
}

test('selects basketball only inside the live sports group', async () => {
  assert.deepEqual(await evaluateSelection({ scope: 'live', sport: 'basketball' }), {
    status: 'ready',
  });
});

test('selects early before selecting basketball inside all sports', async () => {
  assert.deepEqual(await evaluateSelection({ scope: 'early', sport: 'basketball' }), {
    status: 'ready',
  });
});

test('waits for the early sport list to replace the today sport list', async () => {
  assert.deepEqual(await evaluateSelection(
    { scope: 'early', sport: 'basketball' },
    { delayedScopeSport: true },
  ), {
    status: 'ready',
  });
});

test('returns a verified empty marker when the scope has no requested sport', async () => {
  assert.deepEqual(await evaluateSelection(
    { scope: 'early', sport: 'basketball' },
    { missingSport: true },
  ), {
    status: 'empty',
  });
  assert.deepEqual(normalizeSportsSelectionPayload({ status: 'empty' }), { empty: true });
});

test('ambiguous scope groups map to UPSTREAM_SCHEMA_CHANGED', async () => {
  const payload = await evaluateSelection(
    { scope: 'live', sport: 'basketball' },
    { duplicateLive: true },
  );
  assert.deepEqual(payload, { status: 'schema_changed' });
  assert.throws(
    () => normalizeSportsSelectionPayload(payload),
    (error) => error?.code === CODES.SCHEMA_CHANGED && !error.cause,
  );
});

test('selection expression accepts only supported scope and sport keys', () => {
  for (const options of [
    {},
    { scope: 'all', sport: 'football' },
    { scope: 'live' },
    { scope: 'live', sport: 'esports' },
  ]) {
    assert.throws(() => buildSportsSelectionExpression(options), /scope and sport/);
  }
});

test('selection expression cannot read credentials or click wager controls', () => {
  const expression = buildSportsSelectionExpression({
    scope: 'live',
    sport: 'football',
  }).toLowerCase();
  for (const forbidden of [
    'cookie',
    'localstorage',
    'sessionstorage',
    'indexeddb',
    'fetch(',
    'xmlhttprequest',
    'bet_slip',
    'cashout',
  ]) {
    assert.equal(expression.includes(forbidden), false, forbidden);
  }
});
