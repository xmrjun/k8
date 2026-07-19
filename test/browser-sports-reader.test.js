const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  buildSportsExpression,
  normalizeSportsPayload,
} = require('../src/browser/readers/sports');
const { CODES } = require('../src/upstream/errors');

function fixture() {
  return JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'im-sports-raw.json'),
    'utf8',
  ));
}

function schemaFailure(callback) {
  assert.throws(callback, (error) => error?.code === CODES.SCHEMA_CHANGED && !error.cause);
}

function domNode({
  text = '',
  selectors = {},
  attributes = {},
  classes = [],
  parentElement = null,
  previousElementSibling = null,
} = {}) {
  return {
    textContent: text,
    parentElement,
    previousElementSibling,
    classList: { contains(name) { return classes.includes(name); } },
    querySelector(selector) {
      return selectors[selector]?.[0] || null;
    },
    querySelectorAll(selector) {
      return selectors[selector] || [];
    },
    getAttribute(name) {
      return Object.hasOwn(attributes, name) ? attributes[name] : null;
    },
  };
}

function oddsWrap(displayOdds, { locked = false } = {}) {
  return domNode({
    selectors: {
      '.odds': displayOdds === null ? [] : [domNode({ text: displayOdds })],
      '.lock': locked ? [domNode()] : [],
    },
    classes: locked ? ['lock'] : [],
  });
}

function marketCell({
  classes = [],
  lines = [],
  odds = [],
  total = false,
} = {}) {
  return domNode({
    classes,
    selectors: {
      '.handi': lines.map((line) => domNode({ text: line })),
      '.odds_wrap': odds,
      '.ou': total ? [domNode({ text: '大' }), domNode({ text: '小' })] : [],
    },
  });
}

function periodNode({
  winnerOdds,
  handicapLines = [],
  handicapOdds = [],
  totalLines = [],
  totalOdds = [],
  oddEvenOdds = [],
}) {
  const winner = marketCell({
    classes: ['event_even', 'double'],
    odds: winnerOdds,
  });
  const cells = [
    winner,
    marketCell({ classes: ['event_even'], lines: handicapLines }),
    marketCell({ classes: ['event_even', 'left'], odds: handicapOdds }),
    marketCell({ classes: ['event_even'], lines: totalLines, total: true }),
    marketCell({ classes: ['event_even', 'left'], odds: totalOdds }),
  ];
  if (oddEvenOdds.length > 0) {
    cells.push(
      marketCell({ classes: ['event_even'] }),
      marketCell({ classes: ['event_even', 'left'], odds: oddEvenOdds }),
    );
  }
  return domNode({
    selectors: {
      '.event_even.double': [winner],
      '.event_even': cells,
    },
  });
}

function sportsExpressionDocument({ header, href, secondHref, periods = [] }) {
  const anchor = domNode({ attributes: { href } });
  const home = domNode({ text: 'Synthetic Home' });
  const away = domNode({ text: 'Synthetic Away' });
  const league = domNode({ text: 'Synthetic League' });
  const competition = domNode({ selectors: { '.competition_header_team': [league] } });
  const info = periods.length > 0
    ? domNode({ selectors: { '.header_info_inner': periods } })
    : null;
  const row = domNode({
    selectors: {
      '.team a[href^="/sev/"]': [anchor],
      '.teamname_title': [home, away],
      '.score': [],
      '.datetime': [],
      '.info': info ? [info] : [],
    },
    parentElement: competition,
  });
  const rows = [row];
  if (secondHref) {
    rows.push(domNode({
      selectors: {
        '.team a[href^="/sev/"]': [domNode({ attributes: { href: secondHref } })],
        '.teamname_title': [
          domNode({ text: 'Second Synthetic Home' }),
          domNode({ text: 'Second Synthetic Away' }),
        ],
        '.score': [],
        '.datetime': [],
        '.info': [],
      },
      parentElement: competition,
    }));
  }
  const listingHeader = domNode({ text: header });
  const wrap = domNode({
    selectors: {
      '.eventlisting_header': [listingHeader],
      '.event_row': rows,
    },
  });
  return domNode({
    selectors: {
      '.eventlisting_wrap': [wrap],
      'input[type="password"], form[action*="login"], .login-form': [],
    },
  });
}

function evaluateSportsExpression(options) {
  return JSON.parse(JSON.stringify(vm.runInNewContext(
    buildSportsExpression({ maxEvents: 10 }),
    { document: sportsExpressionDocument(options) },
  )));
}

test('normalizes IM Sports events with stable markets and selection keys', () => {
  const result = normalizeSportsPayload(fixture(), { scope: 'all' });

  assert.equal(result.count, 3);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.events[0], {
    event_id: '900000001',
    sport: 'football',
    scope: 'live',
    league: 'Example Live League',
    home: 'Example Home',
    away: 'Example Away',
    score: { home: 0, away: 1 },
    clock: '2H 77:24',
    markets: [
      {
        period: 'full_time',
        type: '1x2',
        selections: [
          {
            selection_key: '900000001:full_time:1x2:home',
            name: 'home',
            display_odds: '6.43',
            odds_format: 'hong_kong',
            decimal_odds: '7.43',
            available: true,
          },
          {
            selection_key: '900000001:full_time:1x2:draw',
            name: 'draw',
            display_odds: '2.10',
            odds_format: 'hong_kong',
            decimal_odds: '3.10',
            available: true,
          },
          {
            selection_key: '900000001:full_time:1x2:away',
            name: 'away',
            odds_format: 'hong_kong',
            available: false,
          },
        ],
      },
      {
        period: 'full_time',
        type: 'handicap',
        selections: [
          {
            selection_key: '900000001:full_time:handicap:home',
            name: 'home',
            line: '-0.5',
            display_odds: '0.95',
            odds_format: 'hong_kong',
            decimal_odds: '1.95',
            available: true,
          },
          {
            selection_key: '900000001:full_time:handicap:away',
            name: 'away',
            line: '+0.5',
            display_odds: '0.87',
            odds_format: 'hong_kong',
            decimal_odds: '1.87',
            available: true,
          },
        ],
      },
      {
        period: 'full_time',
        type: 'total',
        selections: [
          {
            selection_key: '900000001:full_time:total:over',
            name: 'over',
            line: '2.5',
            display_odds: '0.88',
            odds_format: 'hong_kong',
            decimal_odds: '1.88',
            available: true,
          },
          {
            selection_key: '900000001:full_time:total:under',
            name: 'under',
            line: '2.5',
            odds_format: 'hong_kong',
            available: false,
          },
        ],
      },
    ],
  });
});

test('filters by scope and sport without changing page order', () => {
  const result = normalizeSportsPayload(fixture(), {
    scope: 'today',
    sport: 'basketball',
  });

  assert.equal(result.count, 1);
  assert.equal(result.events[0].event_id, '900000002');
});

test('normalizes a two-way basketball moneyline without a draw or line', () => {
  const payload = fixture();
  payload.sections[1].competitions[0].events[0].markets.unshift({
    period: 'full_time',
    type: 'moneyline',
    selections: [
      { name: 'home', display_odds: '0.75', available: true },
      { name: 'away', display_odds: '1.05', available: true },
    ],
  });

  const market = normalizeSportsPayload(payload, {
    scope: 'today',
    sport: 'basketball',
  }).events[0].markets[0];

  assert.equal(market.type, 'moneyline');
  assert.deepEqual(
    market.selections.map((selection) => selection.selection_key),
    [
      '900000002:full_time:moneyline:home',
      '900000002:full_time:moneyline:away',
    ],
  );
  assert.equal(Object.hasOwn(market.selections[0], 'line'), false);
});

test('keeps first-half markets separate from full-time markets', () => {
  const payload = fixture();
  const event = payload.sections[0].competitions[0].events[0];
  event.markets.push({
    period: 'first_half',
    type: '1x2',
    selections: [
      { name: 'home', display_odds: '1.10', available: true },
      { name: 'draw', display_odds: '0.90', available: true },
      { name: 'away', display_odds: '1.20', available: true },
    ],
  });

  const result = normalizeSportsPayload(payload, { scope: 'live', sport: 'football' });

  assert.deepEqual(
    result.events[0].markets.map((market) => `${market.period}:${market.type}`),
    ['full_time:1x2', 'full_time:handicap', 'full_time:total', 'first_half:1x2'],
  );
});

test('normalizes tennis total-games odd/even as a line-less market', () => {
  const payload = fixture();
  payload.sections[2].competitions[0].events[0].markets.push({
    period: 'full_time',
    type: 'odd_even',
    selections: [
      { name: 'odd', display_odds: '0.86', available: true },
      { name: 'even', display_odds: '0.96', available: true },
    ],
  });

  const market = normalizeSportsPayload(payload, {
    scope: 'early',
    sport: 'tennis',
  }).events[0].markets.at(-1);

  assert.equal(market.type, 'odd_even');
  assert.deepEqual(market.selections.map((selection) => selection.name), ['odd', 'even']);
  assert.equal(Object.hasOwn(market.selections[0], 'line'), false);
});

for (const [sportId, sport] of [
  ['1', 'football'],
  ['2', 'basketball'],
  ['3', 'tennis'],
]) {
  test(`uses /sev sport id ${sportId} as ${sport} when the header has no sport label`, () => {
    const result = evaluateSportsExpression({
      header: '滚球中',
      href: `/sev/${sportId}/3/90000000${sportId}`,
    });

    assert.equal(result.status, 'ready');
    assert.equal(result.sections[0].sport, sport);
  });
}

test('rejects a conflict between /sev sport id and the event-listing header', () => {
  assert.deepEqual(evaluateSportsExpression({
    header: '滚球中 足球',
    href: '/sev/2/3/900000002',
  }), {
    status: 'schema_changed',
    sections: [],
  });
});

test('rejects mixed sport ids inside one event-listing section', () => {
  assert.deepEqual(evaluateSportsExpression({
    header: '滚球中 足球',
    href: '/sev/1/3/900000001',
    secondHref: '/sev/2/3/900000002',
  }), {
    status: 'schema_changed',
    sections: [],
  });
});

test('DOM expression emits football 1X2 for full time and first half', () => {
  const fullTime = periodNode({
    winnerOdds: [oddsWrap('0.80'), oddsWrap('1.10'), oddsWrap('0.90')],
  });
  const firstHalf = periodNode({
    winnerOdds: [oddsWrap('0.70'), oddsWrap('1.20'), oddsWrap('1.00')],
  });

  const event = evaluateSportsExpression({
    header: '滚球中 足球',
    href: '/sev/1/3/900000001',
    periods: [fullTime, firstHalf],
  }).sections[0].competitions[0].events[0];

  assert.deepEqual(event.markets.map((market) => [market.period, market.type]), [
    ['full_time', '1x2'],
    ['first_half', '1x2'],
  ]);
  assert.deepEqual(
    event.markets[0].selections.map((selection) => selection.name),
    ['home', 'draw', 'away'],
  );
});

test('DOM expression emits basketball moneyline, handicap, and total', () => {
  const fullTime = periodNode({
    winnerOdds: [oddsWrap('0.75'), oddsWrap('1.05')],
    handicapLines: ['-3.5', '+3.5'],
    handicapOdds: [oddsWrap('0.91'), oddsWrap('0.91')],
    totalLines: ['175.5', '175.5'],
    totalOdds: [oddsWrap('0.88'), oddsWrap('0.94')],
  });

  const markets = evaluateSportsExpression({
    header: '滚球中 篮球',
    href: '/sev/2/3/900000002',
    periods: [fullTime],
  }).sections[0].competitions[0].events[0].markets;

  assert.deepEqual(markets.map((market) => market.type), [
    'moneyline',
    'handicap',
    'total',
  ]);
  assert.deepEqual(
    markets[0].selections.map((selection) => selection.name),
    ['home', 'away'],
  );
});

test('DOM expression emits tennis moneyline and total-games odd/even', () => {
  const fullTime = periodNode({
    winnerOdds: [oddsWrap('0.86'), oddsWrap('0.96')],
    handicapLines: ['-1.5', '+1.5'],
    handicapOdds: [oddsWrap('0.90'), oddsWrap('0.90')],
    totalLines: ['22.5', '22.5'],
    totalOdds: [oddsWrap('0.84'), oddsWrap('0.98')],
    oddEvenOdds: [oddsWrap('0.87'), oddsWrap('0.95')],
  });

  const markets = evaluateSportsExpression({
    header: '今日 网球',
    href: '/sev/3/3/900000003',
    periods: [fullTime],
  }).sections[0].competitions[0].events[0].markets;

  assert.deepEqual(markets.map((market) => market.type), [
    'moneyline',
    'handicap',
    'total',
    'odd_even',
  ]);
  assert.deepEqual(
    markets.at(-1).selections.map((selection) => selection.name),
    ['odd', 'even'],
  );
});

test('adds one to Hong Kong odds as an exact decimal string', () => {
  const payload = fixture();
  payload.sections[0].competitions[0].events[0]
    .markets[0].selections[0].display_odds = '0.123456789012345678';

  const selection = normalizeSportsPayload(payload, { scope: 'live' })
    .events[0].markets[0].selections[0];

  assert.equal(selection.display_odds, '0.123456789012345678');
  assert.equal(selection.decimal_odds, '1.123456789012345678');
});

test('preserves signed Asian quarter lines with an unsigned second value', () => {
  const payload = fixture();
  const markets = payload.sections[0].competitions[0].events[0].markets;
  markets[1].selections[0].line = '-0.5/1';
  markets[1].selections[1].line = '+0.5/1';
  markets[2].selections[0].line = '2.5/3';
  markets[2].selections[1].line = '2.5/3';

  const result = normalizeSportsPayload(payload, { scope: 'live' });

  assert.deepEqual(
    result.events[0].markets.slice(1).flatMap(
      (market) => market.selections.map((selection) => selection.line),
    ),
    ['-0.5/1', '+0.5/1', '2.5/3', '2.5/3'],
  );
});

test('merges repeated event rows when identity fields agree', () => {
  const payload = fixture();
  const competition = payload.sections[0].competitions[0];
  competition.events.push({
    event_id: '900000001',
    home: 'Example Home',
    away: 'Example Away',
    score: { home: '0', away: '1' },
    clock: '2H 77:24',
    markets: structuredClone(competition.events[0].markets),
  });

  const result = normalizeSportsPayload(payload, { scope: 'live' });

  assert.equal(result.count, 1);
  assert.equal(result.events[0].markets.length, 3);
});

test('caps output at 500 events and reports truncation', () => {
  const payload = fixture();
  const template = payload.sections[0].competitions[0].events[0];
  payload.sections = [{
    scope: 'live',
    sport: 'football',
    competitions: [{
      league: 'Synthetic League',
      events: Array.from({ length: 501 }, (_, index) => ({
        ...structuredClone(template),
        event_id: String(910000000 + index),
      })),
    }],
  }];

  const result = normalizeSportsPayload(payload, { scope: 'all' });

  assert.equal(result.events.length, 500);
  assert.equal(result.count, 500);
  assert.equal(result.truncated, true);
});

for (const [name, mutate] of [
  ['missing page status', (payload) => { delete payload.status; }],
  ['unknown section scope', (payload) => { payload.sections[0].scope = 'parlay'; }],
  ['unknown sport', (payload) => { payload.sections[0].sport = 'unknown-sport'; }],
  ['missing league', (payload) => { delete payload.sections[0].competitions[0].league; }],
  ['non-numeric event id', (payload) => { payload.sections[0].competitions[0].events[0].event_id = 'evt-1'; }],
  ['missing home team', (payload) => { delete payload.sections[0].competitions[0].events[0].home; }],
  ['invalid market period', (payload) => { payload.sections[0].competitions[0].events[0].markets[0].period = 'unknown'; }],
  ['invalid odds', (payload) => { payload.sections[0].competitions[0].events[0].markets[0].selections[0].display_odds = '--'; }],
]) {
  test(`${name} maps to UPSTREAM_SCHEMA_CHANGED`, () => {
    const payload = fixture();
    mutate(payload);
    schemaFailure(() => normalizeSportsPayload(payload, { scope: 'all' }));
  });
}

test('conflicting repeated event identity maps to UPSTREAM_SCHEMA_CHANGED', () => {
  const payload = fixture();
  const duplicate = structuredClone(payload.sections[0].competitions[0].events[0]);
  duplicate.home = 'Different Home';
  payload.sections[0].competitions[0].events.push(duplicate);

  schemaFailure(() => normalizeSportsPayload(payload, { scope: 'all' }));
});

test('builds a bounded DOM expression from only verified sports selectors', () => {
  const expression = buildSportsExpression({ maxEvents: 500 });

  for (const selector of [
    '.eventlisting_wrap',
    '.competition_header_team',
    '.event_row',
    'a[href^="/sev/"]',
    '.teamname_title',
    '.score',
    '.datetime',
    '.event_even.double',
    '.handi',
    '.ou',
    '.odds',
    '.lock',
  ]) {
    assert.equal(expression.includes(selector), true, `missing ${selector}`);
  }
  assert.match(expression, /const maxEvents = 500;/);
});

test('sports DOM expression cannot read browser credentials or issue requests', () => {
  const expression = buildSportsExpression({ maxEvents: 500 });

  for (const forbidden of [
    'cookie',
    'localstorage',
    'sessionstorage',
    'indexeddb',
    'fetch(',
    'xmlhttprequest',
    'performance.getentries',
  ]) {
    assert.equal(expression.toLowerCase().includes(forbidden), false, forbidden);
  }
});

test('sports DOM expression emits explicit login and schema markers', () => {
  const expression = buildSportsExpression({ maxEvents: 500 });
  const loginDocument = {
    querySelector(selector) {
      return selector.includes('password') ? {} : null;
    },
    querySelectorAll() {
      return [];
    },
  };
  const unknownDocument = {
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };

  const loginResult = JSON.parse(JSON.stringify(
    vm.runInNewContext(expression, { document: loginDocument }),
  ));
  const unknownResult = JSON.parse(JSON.stringify(
    vm.runInNewContext(expression, { document: unknownDocument }),
  ));

  assert.deepEqual(loginResult, {
    status: 'login_required',
    sections: [],
  });
  assert.deepEqual(unknownResult, {
    status: 'schema_changed',
    sections: [],
  });
});

for (const maxEvents of [0, 501, 1.5, '500']) {
  test(`rejects unsafe sports expression maxEvents ${JSON.stringify(maxEvents)}`, () => {
    assert.throws(
      () => buildSportsExpression({ maxEvents }),
      /maxEvents must be an integer between 1 and 500/,
    );
  });
}

test('login marker maps to UPSTREAM_AUTH_EXPIRED', () => {
  assert.throws(
    () => normalizeSportsPayload({ status: 'login_required', sections: [] }),
    (error) => error?.code === CODES.AUTH_EXPIRED && !error.cause,
  );
});

test('schema marker maps to UPSTREAM_SCHEMA_CHANGED', () => {
  schemaFailure(() => normalizeSportsPayload({ status: 'schema_changed', sections: [] }));
});

test('a verified empty sports page is a truthful empty success', () => {
  assert.deepEqual(
    normalizeSportsPayload({ status: 'ready', sections: [] }, { scope: 'all' }),
    { events: [], count: 0, truncated: false },
  );
});
