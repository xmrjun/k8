'use strict';

const { CODES, upstreamError } = require('../../upstream/errors');

const SCOPES = new Set(['live', 'today', 'early']);
const SPORTS = new Set([
  'american_football',
  'badminton',
  'baseball',
  'basketball',
  'beach_volleyball',
  'boxing',
  'cricket',
  'cycling',
  'darts',
  'ebasketball',
  'efootball',
  'esports',
  'football',
  'futsal',
  'golf',
  'handball',
  'ice_hockey',
  'mma',
  'motorsports',
  'rugby',
  'snooker',
  'squash',
  'table_tennis',
  'tennis',
  'volleyball',
  'water_polo',
]);
const SPORT_KEYS = Object.freeze([...SPORTS]);
const PERIODS = new Set(['full_time']);
const MARKET_SELECTIONS = Object.freeze({
  '1x2': new Set(['home', 'draw', 'away']),
  handicap: new Set(['home', 'away']),
  total: new Set(['over', 'under']),
});
const EVENT_ID_PATTERN = /^\d{1,32}$/;
const SCORE_PATTERN = /^\d{1,3}$/;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const LINE_PATTERN = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:\/(?:0|[1-9]\d*)(?:\.\d+)?)?$/;

function schemaError() {
  return upstreamError(CODES.SCHEMA_CHANGED, 'IM Sports page schema changed');
}

function authError() {
  return upstreamError(CODES.AUTH_EXPIRED, 'IM Sports authentication expired');
}

function buildSportsExpression({ maxEvents = 500 } = {}) {
  if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 500) {
    throw new TypeError('maxEvents must be an integer between 1 and 500');
  }

  return `(() => {
    const maxEvents = ${maxEvents};
    const all = (root, selector) => root && typeof root.querySelectorAll === 'function'
      ? Array.from(root.querySelectorAll(selector))
      : [];
    const one = (root, selector) => root && typeof root.querySelector === 'function'
      ? root.querySelector(selector)
      : null;
    const text = (node) => typeof node?.textContent === 'string'
      ? node.textContent.replace(/\\s+/g, ' ').trim()
      : '';
    const hasClass = (node, name) => Boolean(node?.classList?.contains(name));
    const login = one(document, 'input[type="password"], form[action*="login"], .login-form');
    if (login) return { status: 'login_required', sections: [] };

    const wraps = all(document, '.eventlisting_wrap');
    if (wraps.length === 0) return { status: 'schema_changed', sections: [] };

    const scopeFrom = (value) => {
      const lower = value.toLowerCase();
      if (value.includes('滚球') || lower.includes('live')) return 'live';
      if (value.includes('今日') || lower.includes('today')) return 'today';
      if (value.includes('早盘') || lower.includes('early')) return 'early';
      return null;
    };
    const sportLabels = [
      ['电子足球', 'efootball'], ['e足球', 'efootball'], ['e-football', 'efootball'],
      ['电子篮球', 'ebasketball'], ['e篮球', 'ebasketball'], ['e-basketball', 'ebasketball'],
      ['美式足球', 'american_football'], ['沙滩排球', 'beach_volleyball'],
      ['电子竞技', 'esports'], ['电竞', 'esports'], ['esports', 'esports'],
      ['乒乓球', 'table_tennis'], ['table tennis', 'table_tennis'],
      ['冰上曲棍球', 'ice_hockey'], ['冰球', 'ice_hockey'], ['ice hockey', 'ice_hockey'],
      ['室内足球', 'futsal'], ['水球', 'water_polo'], ['water polo', 'water_polo'],
      ['羽毛球', 'badminton'], ['排球', 'volleyball'], ['棒球', 'baseball'],
      ['篮球', 'basketball'], ['网球', 'tennis'], ['足球', 'football'],
      ['手球', 'handball'], ['斯诺克', 'snooker'], ['壁球', 'squash'],
      ['板球', 'cricket'], ['橄榄球', 'rugby'], ['高尔夫', 'golf'],
      ['飞镖', 'darts'], ['拳击', 'boxing'], ['综合格斗', 'mma'],
      ['自行车', 'cycling'], ['赛车', 'motorsports'],
      ['american football', 'american_football'], ['badminton', 'badminton'],
      ['baseball', 'baseball'], ['basketball', 'basketball'], ['volleyball', 'volleyball'],
      ['football', 'football'], ['soccer', 'football'], ['tennis', 'tennis'],
      ['handball', 'handball'], ['snooker', 'snooker'], ['cricket', 'cricket'],
      ['rugby', 'rugby'], ['golf', 'golf'], ['darts', 'darts'], ['boxing', 'boxing']
    ];
    const sportFrom = (value, sportCode) => {
      const lower = value.toLowerCase();
      const match = sportLabels.find(([label]) => lower.includes(label.toLowerCase()));
      if (match) return match[1];
      if (sportCode === '3') return 'football';
      return null;
    };
    const headerTextFor = (wrap) => {
      const inside = text(one(wrap, '.eventlisting_header'));
      if (inside) return inside;
      let cursor = wrap.previousElementSibling;
      for (let index = 0; cursor && index < 5; index += 1) {
        const candidate = text(one(cursor, '.eventlisting_header')) || text(cursor);
        if (candidate) return candidate;
        cursor = cursor.previousElementSibling;
      }
      return '';
    };
    const leagueFor = (row, wrap) => {
      let node = row.parentElement;
      for (let depth = 0; node && depth < 6; depth += 1) {
        const own = text(one(node, '.competition_header_team'));
        if (own) return own;
        let previous = node.previousElementSibling;
        for (let index = 0; previous && index < 4; index += 1) {
          const candidate = text(one(previous, '.competition_header_team'));
          if (candidate) return candidate;
          previous = previous.previousElementSibling;
        }
        if (node === wrap) break;
        node = node.parentElement;
      }
      return '';
    };
    const oddsSelection = (oddsWrap, name, line) => {
      const rawOdds = text(one(oddsWrap, '.odds'));
      const locked = hasClass(oddsWrap, 'lock') || Boolean(one(oddsWrap, '.lock'));
      const available = !locked && rawOdds !== '' && rawOdds !== '--';
      const selection = {
        name,
        display_odds: available ? rawOdds : null,
        available,
      };
      if (line !== undefined) selection.line = line;
      return selection;
    };
    const marketsFor = (row) => {
      const info = one(row, '.info');
      const periodRoot = one(info, '.header_info_inner') || info;
      if (!periodRoot) return [];
      const markets = [];
      const double = one(periodRoot, '.event_even.double');
      const winnerOdds = all(double, '.odds_wrap').slice(0, 3);
      if (winnerOdds.length === 3) {
        markets.push({
          period: 'full_time',
          type: '1x2',
          selections: ['home', 'draw', 'away'].map(
            (name, index) => oddsSelection(winnerOdds[index], name),
          ),
        });
      }

      const cells = all(periodRoot, '.event_even');
      for (let index = 0; index < cells.length; index += 1) {
        const cell = cells[index];
        if (hasClass(cell, 'double') || hasClass(cell, 'left')) continue;
        const lines = all(cell, '.handi').map(text).filter(Boolean).slice(0, 2);
        if (lines.length !== 2) continue;
        const next = cells[index + 1];
        if (!next || !hasClass(next, 'left')) continue;
        const odds = all(next, '.odds_wrap').slice(0, 2);
        if (odds.length !== 2) continue;
        const isTotal = all(cell, '.ou').length > 0;
        const names = isTotal ? ['over', 'under'] : ['home', 'away'];
        markets.push({
          period: 'full_time',
          type: isTotal ? 'total' : 'handicap',
          selections: names.map(
            (name, selectionIndex) => oddsSelection(
              odds[selectionIndex],
              name,
              lines[selectionIndex],
            ),
          ),
        });
      }
      return markets;
    };

    const sections = [];
    let eventCount = 0;
    let invalid = false;
    for (const wrap of wraps) {
      if (eventCount >= maxEvents) break;
      const rows = all(wrap, '.event_row');
      const teamRows = rows.filter((row) => Boolean(one(row, '.team a[href^="/sev/"]')));
      if (teamRows.length === 0) continue;
      const firstHref = one(teamRows[0], '.team a[href^="/sev/"]')?.getAttribute?.('href') || '';
      const firstMatch = firstHref.match(/^\\/sev\\/(\\d+)\\/(\\d+)\\/(\\d+)\\/?$/);
      const headerText = headerTextFor(wrap);
      const scope = scopeFrom(headerText);
      const sport = sportFrom(headerText, firstMatch?.[2]);
      if (!scope || !sport) {
        invalid = true;
        continue;
      }

      const competitions = [];
      const competitionByLeague = new Map();
      for (const row of teamRows) {
        if (eventCount >= maxEvents) break;
        const anchor = one(row, '.team a[href^="/sev/"]');
        const href = anchor?.getAttribute?.('href') || '';
        const hrefMatch = href.match(/^\\/sev\\/(\\d+)\\/(\\d+)\\/(\\d+)\\/?$/);
        const teams = all(row, '.teamname_title').map(text).filter(Boolean).slice(0, 2);
        const league = leagueFor(row, wrap);
        if (!hrefMatch || teams.length !== 2 || !league) {
          invalid = true;
          continue;
        }
        const scoreParts = all(row, '.score')
          .flatMap((node) => text(node).match(/\\d+/g) || [])
          .slice(0, 2);
        const event = {
          event_id: hrefMatch[3],
          home: teams[0],
          away: teams[1],
          score: scoreParts.length === 2
            ? { home: scoreParts[0], away: scoreParts[1] }
            : null,
          clock: text(one(row, '.datetime')) || null,
          markets: marketsFor(row),
        };
        let competition = competitionByLeague.get(league);
        if (!competition) {
          competition = { league, events: [] };
          competitionByLeague.set(league, competition);
          competitions.push(competition);
        }
        competition.events.push(event);
        eventCount += 1;
      }
      if (competitions.length > 0) sections.push({ scope, sport, competitions });
    }

    if (invalid || sections.length === 0) {
      return { status: 'schema_changed', sections: [] };
    }
    return { status: 'ready', sections };
  })()`;
}

function requiredArray(value) {
  if (!Array.isArray(value)) throw schemaError();
  return value;
}

function requiredText(value) {
  if (typeof value !== 'string' || value.trim().length === 0) throw schemaError();
  return value.trim();
}

function optionalText(value) {
  if (value === null || value === undefined) return null;
  return requiredText(value);
}

function decimalPlusOne(value) {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) throw schemaError();
  const [integer, fraction] = value.split('.');
  const nextInteger = (BigInt(integer) + 1n).toString();
  return fraction === undefined ? nextInteger : `${nextInteger}.${fraction}`;
}

function normalizeScore(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw schemaError();
  const home = value.home;
  const away = value.away;
  if (typeof home !== 'string' || !SCORE_PATTERN.test(home)
    || typeof away !== 'string' || !SCORE_PATTERN.test(away)) {
    throw schemaError();
  }
  return { home: Number(home), away: Number(away) };
}

function normalizeSelection(selection, { eventId, period, type }) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
    throw schemaError();
  }
  const name = requiredText(selection.name);
  if (!MARKET_SELECTIONS[type].has(name) || typeof selection.available !== 'boolean') {
    throw schemaError();
  }

  const normalized = {
    selection_key: `${eventId}:${period}:${type}:${name}`,
    name,
  };
  if (type !== '1x2') {
    const line = requiredText(selection.line);
    if (!LINE_PATTERN.test(line)) throw schemaError();
    normalized.line = line;
  }

  if (selection.available) {
    const displayOdds = requiredText(selection.display_odds);
    if (!DECIMAL_PATTERN.test(displayOdds)) throw schemaError();
    normalized.display_odds = displayOdds;
    normalized.odds_format = 'hong_kong';
    normalized.decimal_odds = decimalPlusOne(displayOdds);
    normalized.available = true;
    return normalized;
  }

  if (![undefined, null, '', '--'].includes(selection.display_odds)) throw schemaError();
  normalized.odds_format = 'hong_kong';
  normalized.available = false;
  return normalized;
}

function normalizeMarket(market, eventId) {
  if (!market || typeof market !== 'object' || Array.isArray(market)) throw schemaError();
  const period = requiredText(market.period);
  const type = requiredText(market.type);
  if (!PERIODS.has(period) || !Object.hasOwn(MARKET_SELECTIONS, type)) throw schemaError();

  const selections = requiredArray(market.selections).map(
    (selection) => normalizeSelection(selection, { eventId, period, type }),
  );
  if (selections.length === 0) throw schemaError();
  if (new Set(selections.map((selection) => selection.selection_key)).size !== selections.length) {
    throw schemaError();
  }

  return { period, type, selections };
}

function normalizeEvent(rawEvent, { sport, scope, league }) {
  if (!rawEvent || typeof rawEvent !== 'object' || Array.isArray(rawEvent)) {
    throw schemaError();
  }
  const eventId = requiredText(rawEvent.event_id);
  if (!EVENT_ID_PATTERN.test(eventId)) throw schemaError();
  const markets = requiredArray(rawEvent.markets).map(
    (market) => normalizeMarket(market, eventId),
  );
  const marketKeys = new Set();
  for (const market of markets) {
    const key = `${market.period}:${market.type}`;
    if (marketKeys.has(key)) throw schemaError();
    marketKeys.add(key);
  }

  return {
    event_id: eventId,
    sport,
    scope,
    league,
    home: requiredText(rawEvent.home),
    away: requiredText(rawEvent.away),
    score: normalizeScore(rawEvent.score),
    clock: optionalText(rawEvent.clock),
    markets,
  };
}

function sameIdentity(left, right) {
  return left.event_id === right.event_id
    && left.sport === right.sport
    && left.scope === right.scope
    && left.league === right.league
    && left.home === right.home
    && left.away === right.away
    && JSON.stringify(left.score) === JSON.stringify(right.score)
    && left.clock === right.clock;
}

function mergeEvent(target, incoming) {
  if (!sameIdentity(target, incoming)) throw schemaError();
  const existing = new Map(target.markets.map(
    (market) => [`${market.period}:${market.type}`, JSON.stringify(market)],
  ));
  for (const market of incoming.markets) {
    const key = `${market.period}:${market.type}`;
    if (existing.has(key)) {
      if (existing.get(key) !== JSON.stringify(market)) throw schemaError();
      continue;
    }
    target.markets.push(market);
    existing.set(key, JSON.stringify(market));
  }
}

function normalizeOptions(options = {}) {
  const scope = options.scope === undefined ? 'all' : options.scope;
  const sport = options.sport;
  if ((scope !== 'all' && !SCOPES.has(scope))
    || (sport !== undefined && !SPORTS.has(sport))) {
    throw schemaError();
  }
  return { scope, sport };
}

function normalizeSportsPayload(payload, options) {
  const filters = normalizeOptions(options);
  if (payload?.status === 'login_required') throw authError();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || payload.status !== 'ready') {
    throw schemaError();
  }

  const events = [];
  const byId = new Map();
  for (const section of requiredArray(payload.sections)) {
    if (!section || typeof section !== 'object' || Array.isArray(section)) throw schemaError();
    const scope = requiredText(section.scope);
    const sport = requiredText(section.sport);
    if (!SCOPES.has(scope) || !SPORTS.has(sport)) throw schemaError();

    for (const competition of requiredArray(section.competitions)) {
      if (!competition || typeof competition !== 'object' || Array.isArray(competition)) {
        throw schemaError();
      }
      const league = requiredText(competition.league);
      for (const rawEvent of requiredArray(competition.events)) {
        const event = normalizeEvent(rawEvent, { sport, scope, league });
        if (filters.scope !== 'all' && filters.scope !== scope) continue;
        if (filters.sport !== undefined && filters.sport !== sport) continue;

        const existing = byId.get(event.event_id);
        if (existing) {
          mergeEvent(existing, event);
        } else {
          byId.set(event.event_id, event);
          events.push(event);
        }
      }
    }
  }

  const truncated = events.length > 500;
  const boundedEvents = events.slice(0, 500);
  return {
    events: boundedEvents,
    count: boundedEvents.length,
    truncated,
  };
}

module.exports = { SPORT_KEYS, buildSportsExpression, normalizeSportsPayload };
