'use strict';

const {
  authError,
  currency,
  publicDecimal,
  requiredText,
  schemaError,
} = require('./common');

const BET_STATUSES = new Set(['unsettled', 'settled', 'all']);
const CURRENCY_LABEL = /^投注金额\s*\(([A-Z0-9]{2,12})\)$/;
const DATE_AND_ID = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2}).*?注单号\s*[:：]\s*([A-Za-z0-9._-]{1,128})$/;
const DISPLAY_DECIMAL_SOURCE = '[1-9]\\d{0,2}(?:,\\d{3})+(?:\\.\\d+)?|(?:0|[1-9]\\d*)(?:\\.\\d+)?';
const DISPLAY_DECIMAL = new RegExp(`^(?:${DISPLAY_DECIMAL_SOURCE})$`);
const DECIMAL_IN_TEXT = new RegExp(`(?:${DISPLAY_DECIMAL_SOURCE})`, 'g');
const POTENTIAL_PAYOUT = new RegExp(`可赢金额\\s*[:：]?\\s*(${DISPLAY_DECIMAL_SOURCE})`);

function buildBetsExpression({ status = 'all', maxRows = 200 } = {}) {
  if (!BET_STATUSES.has(status)
    || !Number.isInteger(maxRows) || maxRows < 1 || maxRows > 200) {
    throw new TypeError('Invalid bet reader options');
  }

  return `(async () => {
    const requestedStatus = '${status}';
    const maxRows = ${maxRows};
    const labels = Object.freeze({ unsettled: '未结算注单', settled: '已结算注单' });
    const text = (node) => typeof node?.textContent === 'string'
      ? node.textContent.replace(/\\s+/g, ' ').trim()
      : '';
    const result = (statusValue, currencyLabel = '', tabs = []) => ({
      status: statusValue, currency_label: currencyLabel, tabs,
    });
    if (document.querySelector('input[type="password"], form[action*="login"], .login-form')) {
      return result('login_required');
    }

    const tabCandidates = Array.from(document.querySelectorAll(
      'button, a, [role="tab"], [class*="tab"], div, span',
    )).slice(0, 256);
    const leafMatches = (label) => tabCandidates.filter((node) => (
      text(node) === label
      && !Array.from(node.children || []).some((child) => text(child) === label)
    ));
    const tabFor = (recordStatus) => {
      const matches = leafMatches(labels[recordStatus]);
      return matches.length === 1 ? matches[0] : null;
    };
    const isActive = (node) => {
      if (!node) return false;
      const className = typeof node.className === 'string' ? node.className : '';
      return node.getAttribute?.('aria-selected') === 'true'
        || /(?:^|[\\s_-])(active|selected|current)(?:$|[\\s_-])/i.test(className);
    };
    const activeStatus = () => {
      const active = Object.keys(labels).filter((recordStatus) => isActive(tabFor(recordStatus)));
      return active.length === 1 ? active[0] : null;
    };
    if (!tabFor('unsettled') || !tabFor('settled')) return result('schema_changed');

    const currencyCandidates = Array.from(document.querySelectorAll(
      'th, [class*="header"], div, span',
    )).slice(0, 512);
    const currencyMatches = currencyCandidates.filter((node) => (
      /^投注金额\\s*\\([A-Z0-9]{2,12}\\)$/.test(text(node))
      && !Array.from(node.children || []).some((child) => (
        /^投注金额\\s*\\([A-Z0-9]{2,12}\\)$/.test(text(child))
      ))
    ));
    if (currencyMatches.length !== 1) return result('schema_changed');
    const currencyLabel = text(currencyMatches[0]);

    const wait = () => new Promise((resolve) => setTimeout(resolve, 100));
    const selectStatus = async (recordStatus) => {
      if (activeStatus() === recordStatus) return true;
      const tab = tabFor(recordStatus);
      if (!tab || typeof tab.click !== 'function') return false;
      tab.click();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await wait();
        if (activeStatus() === recordStatus) return true;
      }
      return false;
    };

    const readRows = (recordStatus, remaining) => {
      const candidates = Array.from(document.querySelectorAll(
        'tr, [data-bet-record], [class*="record"], [class*="bet"]',
      )).slice(0, 4000).filter((node) => {
        const value = text(node);
        return /注单号\\s*[:：]/.test(value)
          && (value.match(/注单号\\s*[:：]/g) || []).length === 1;
      }).sort((left, right) => text(left).length - text(right).length);
      const roots = [];
      for (const candidate of candidates) {
        if (roots.some((root) => root.contains?.(candidate) || candidate.contains?.(root))) continue;
        const cells = Array.from(candidate.children || []).map(text).filter(Boolean);
        if (cells.length >= 5) roots.push(candidate);
        if (roots.length >= remaining) break;
      }
      const rows = roots.slice(0, remaining).map((row) => {
        const cells = Array.from(row.children || []).map(text).filter(Boolean);
        const idIndex = cells.findIndex((cell) => /注单号\\s*[:：]/.test(cell));
        if (idIndex < 0 || cells.length - idIndex < 5) return null;
        return {
          date_and_id: cells[idIndex],
          description: cells[idIndex + 1] || '',
          odds: cells[idIndex + 2] || '',
          stake: cells[idIndex + 3] || '',
          state: cells[idIndex + 4] || '',
        };
      });
      if (rows.some((row) => row === null)) return null;
      const pageText = text(document.body);
      const empty = rows.length === 0 && /暂无记录|没有记录/.test(pageText);
      if (rows.length === 0 && !empty) return null;
      return { record_status: recordStatus, empty, rows };
    };

    const wanted = requestedStatus === 'all'
      ? ['unsettled', 'settled']
      : [requestedStatus];
    const originalStatus = activeStatus();
    const tabs = [];
    let remaining = maxRows;
    let failed = false;
    try {
      for (const recordStatus of wanted) {
        if (!await selectStatus(recordStatus)) {
          failed = true;
          break;
        }
        const tab = readRows(recordStatus, remaining);
        if (!tab) {
          failed = true;
          break;
        }
        tabs.push(tab);
        remaining -= tab.rows.length;
      }
    } finally {
      const restore = originalStatus && activeStatus() !== originalStatus;
      if (restore) await selectStatus(originalStatus);
    }
    return failed ? result('schema_changed') : result('ready', currencyLabel, tabs);
  })()`;
}

function pagination(options = {}) {
  const status = options.status === undefined ? 'all' : options.status;
  const limit = options.limit === undefined ? 25 : options.limit;
  if (!BET_STATUSES.has(status)
    || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError('Invalid bet pagination');
  }
  const cursor = options.cursor;
  if (cursor !== undefined
    && (typeof cursor !== 'string' || !/^(?:0|[1-9]\d*)$/.test(cursor))) {
    throw new TypeError('Invalid bet pagination');
  }
  const offset = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isSafeInteger(offset)) throw new TypeError('Invalid bet pagination');
  return { status, limit, offset };
}

function localTimestamp(value) {
  const match = requiredText(value).match(DATE_AND_ID);
  if (!match) throw schemaError('IM Sports bet-record schema changed');
  const [, dayText, monthText, yearText, hourText, minuteText, secondText, betId] = match;
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
    throw schemaError('IM Sports bet-record schema changed');
  }
  return {
    betId,
    placedAt: new Date(Date.UTC(
      year, month - 1, day, hour - 8, minute, second,
    )).toISOString(),
  };
}

function displayDecimal(value) {
  const normalized = requiredText(value);
  if (!DISPLAY_DECIMAL.test(normalized)) {
    throw schemaError('IM Sports bet-record schema changed');
  }
  return publicDecimal(normalized.replace(/,/g, ''));
}

function decimalMatches(value) {
  return requiredText(value).match(DECIMAL_IN_TEXT) || [];
}

function normalizeRow(row, recordStatus, normalizedCurrency) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw schemaError('IM Sports bet-record schema changed');
  }
  const { betId, placedAt } = localTimestamp(row.date_and_id);
  const description = requiredText(row.description).replace(/\s+/g, ' ');
  if (description.length > 10_000) throw schemaError('IM Sports bet-record schema changed');
  requiredText(row.state);

  const oddsValues = decimalMatches(row.odds);
  if (oddsValues.length === 0) throw schemaError('IM Sports bet-record schema changed');
  const odds = displayDecimal(oddsValues[oddsValues.length - 1]);

  const stakeValues = decimalMatches(row.stake);
  if (stakeValues.length === 0) throw schemaError('IM Sports bet-record schema changed');
  const payoutMatch = requiredText(row.stake).match(POTENTIAL_PAYOUT);
  return {
    bet_id: betId,
    placed_at: placedAt,
    status: recordStatus,
    description,
    odds,
    stake: displayDecimal(stakeValues[0]),
    currency: normalizedCurrency,
    potential_payout: payoutMatch ? displayDecimal(payoutMatch[1]) : null,
  };
}

function normalizeBetsPayload(payload, options = {}) {
  const { status, limit, offset } = pagination(options);
  if (payload?.status === 'login_required') {
    throw authError('IM Sports authentication expired');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || payload.status !== 'ready' || typeof payload.currency_label !== 'string'
    || !Array.isArray(payload.tabs)) {
    throw schemaError('IM Sports bet-record schema changed');
  }
  const currencyMatch = payload.currency_label.trim().match(CURRENCY_LABEL);
  if (!currencyMatch) throw schemaError('IM Sports bet-record schema changed');
  const normalizedCurrency = currency(currencyMatch[1]);
  const wanted = status === 'all' ? ['unsettled', 'settled'] : [status];
  if (payload.tabs.length !== wanted.length) {
    throw schemaError('IM Sports bet-record schema changed');
  }

  const byStatus = new Map();
  let rowCount = 0;
  for (const tab of payload.tabs) {
    if (!tab || typeof tab !== 'object' || Array.isArray(tab)
      || !wanted.includes(tab.record_status) || byStatus.has(tab.record_status)
      || typeof tab.empty !== 'boolean' || !Array.isArray(tab.rows)) {
      throw schemaError('IM Sports bet-record schema changed');
    }
    rowCount += tab.rows.length;
    if (rowCount > 200 || (tab.empty && tab.rows.length !== 0)
      || (!tab.empty && tab.rows.length === 0)) {
      throw schemaError('IM Sports bet-record schema changed');
    }
    byStatus.set(tab.record_status, tab);
  }

  const records = [];
  const betIds = new Set();
  for (const recordStatus of wanted) {
    const tab = byStatus.get(recordStatus);
    if (!tab) throw schemaError('IM Sports bet-record schema changed');
    for (const row of tab.rows) {
      const record = normalizeRow(row, recordStatus, normalizedCurrency);
      if (betIds.has(record.bet_id)) throw schemaError('IM Sports bet-record schema changed');
      betIds.add(record.bet_id);
      records.push(record);
    }
  }
  return records.slice(offset, offset + limit);
}

module.exports = { buildBetsExpression, normalizeBetsPayload };
