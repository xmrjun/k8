'use strict';

const {
  authError,
  publicDecimal,
  requiredText,
  schemaError,
  visibleCurrency,
} = require('./common');

const LOCAL_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

function buildBetsExpression({ maxRows = 200 } = {}) {
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 200) {
    throw new TypeError('maxRows must be an integer between 1 and 200');
  }

  return `(() => {
    const maxRows = ${maxRows};
    const all = (root, selector) => root && typeof root.querySelectorAll === 'function'
      ? Array.from(root.querySelectorAll(selector))
      : [];
    const one = (root, selector) => root && typeof root.querySelector === 'function'
      ? root.querySelector(selector)
      : null;
    const text = (node) => typeof node?.textContent === 'string'
      ? node.textContent.replace(/\\s+/g, ' ').trim()
      : '';
    const emptyResult = (status, empty, currency) => ({
      status, empty, currency, rows: [],
    });
    if (one(document, 'input[type="password"], form[action*="login"], .login-form')) {
      return emptyResult('login_required', false, null);
    }
    const table = one(document, '.gameTable');
    if (!table) return emptyResult('schema_changed', false, null);
    const activeCurrency = text(one(document, '.wallet.active .cy')) || null;
    const noRecord = one(document, '.noRecord');
    if (noRecord && text(noRecord).includes('暂无记录')) {
      return emptyResult('ready', true, activeCurrency);
    }

    const recordRoots = all(document, '.gameTable .recordList');
    const rowNodes = recordRoots.flatMap((root) => {
      const nestedRows = all(root, 'tr');
      return nestedRows.length > 0 ? nestedRows : [root];
    }).slice(0, maxRows);
    if (rowNodes.length === 0) return emptyResult('schema_changed', false, activeCurrency);
    return {
      status: 'ready',
      empty: false,
      currency: activeCurrency,
      rows: rowNodes.map((row) => {
        let cells = Array.from(row.children || []).map(text).filter(Boolean);
        if (cells.length < 5) cells = all(row, 'td, .col').map(text).filter(Boolean);
        return {
          placed_at: cells[0] || '',
          type: cells[1] || '',
          bet_id: cells[2] || '',
          stake: cells[3] || '',
          payout: cells[4] || '',
        };
      }),
    };
  })()`;
}

function localTimestamp(value) {
  const match = typeof value === 'string' ? value.match(LOCAL_TIMESTAMP) : null;
  if (!match) throw schemaError('k81128 game-record timestamp changed');
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]
    || hour > 23 || minute > 59 || second > 59) {
    throw schemaError('k81128 game-record timestamp changed');
  }
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute, second)).toISOString();
}

function pagination(options = {}) {
  const limit = options.limit === undefined ? 25 : options.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError('Invalid bet pagination');
  }
  const cursor = options.cursor;
  if (cursor !== undefined
    && (typeof cursor !== 'string' || !/^(?:0|[1-9]\d*)$/.test(cursor))) {
    throw new TypeError('Invalid bet pagination');
  }
  const offset = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isSafeInteger(offset)) throw new TypeError('Invalid bet pagination');
  return { limit, offset };
}

function normalizeBetsPayload(payload, options) {
  const { limit, offset } = pagination(options);
  if (payload?.status === 'login_required') throw authError('k81128 authentication expired');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || payload.status !== 'ready' || typeof payload.empty !== 'boolean'
    || !Array.isArray(payload.rows) || payload.rows.length > 200) {
    throw schemaError('k81128 game-record schema changed');
  }
  const normalizedCurrency = visibleCurrency(payload.currency);
  if (payload.empty) {
    if (payload.rows.length !== 0) throw schemaError('k81128 game-record schema changed');
    return [];
  }
  if (payload.rows.length === 0) throw schemaError('k81128 game-record schema changed');

  const rows = payload.rows.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw schemaError('k81128 game-record schema changed');
    }
    return {
      bet_id: requiredText(row.bet_id),
      placed_at: localTimestamp(row.placed_at),
      type: requiredText(row.type),
      stake: publicDecimal(row.stake),
      currency: normalizedCurrency,
      payout: publicDecimal(row.payout),
    };
  });
  return rows.slice(offset, offset + limit);
}

module.exports = { buildBetsExpression, normalizeBetsPayload };
