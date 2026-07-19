'use strict';

const {
  authError,
  currency,
  publicDecimal,
  schemaError,
} = require('./common');

const HEADING_PATTERN = /^账户\s*\(([A-Z0-9]{2,12})\)$/;
const DISPLAY_DECIMAL_PATTERN = /^(?:(?:0|[1-9]\d*)(?:\.\d+)?|[1-9]\d{0,2}(?:,\d{3})+(?:\.\d+)?)$/;

function buildSportsAccountExpression() {
  return `(() => {
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
      status, heading: '', available: '', unsettled: '',
    });
    if (one(document, 'input[type="password"], form[action*="login"], .login-form')) {
      return empty('login_required');
    }
    const panel = one(document, '#left_panel .leftmenu_account');
    if (!panel) return empty('schema_changed');
    const heading = text(one(panel, '.leftmenu_account_title'));
    const rows = all(panel, '.leftmenu_content .row').slice(0, 8);
    const valueFor = (label) => {
      const matches = rows.filter((row) => text(Array.from(row.children || [])[0]) === label);
      return matches.length === 1 ? text(one(matches[0], '.text-right')) : '';
    };
    const available = valueFor('余额');
    const unsettled = valueFor('未结算注单');
    if (!heading || !available || !unsettled) return empty('schema_changed');
    return { status: 'ready', heading, available, unsettled };
  })()`;
}

function displayDecimal(value) {
  if (typeof value !== 'string') throw schemaError('IM Sports account schema changed');
  const normalized = value.trim();
  if (!DISPLAY_DECIMAL_PATTERN.test(normalized)) {
    throw schemaError('IM Sports account schema changed');
  }
  return publicDecimal(normalized.replace(/,/g, ''));
}

function normalizeSportsAccountPayload(payload) {
  if (payload?.status === 'login_required') {
    throw authError('IM Sports authentication expired');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || payload.status !== 'ready') {
    throw schemaError('IM Sports account schema changed');
  }
  const heading = typeof payload.heading === 'string'
    ? payload.heading.trim().match(HEADING_PATTERN)
    : null;
  if (!heading) throw schemaError('IM Sports account schema changed');
  return {
    currency: currency(heading[1]),
    available_balance: displayDecimal(payload.available),
    unsettled_amount: displayDecimal(payload.unsettled),
  };
}

module.exports = {
  buildSportsAccountExpression,
  normalizeSportsAccountPayload,
};
