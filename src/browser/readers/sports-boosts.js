'use strict';

const { authError, requiredText, schemaError } = require('./common');

const MAX_OFFERS = 50;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const KIND_BY_LABEL = Object.freeze({ 赛事串关: 'event_parlay', 连串过关: 'chain_parlay' });

function buildSportsBoostsExpression({ maxOffers = MAX_OFFERS } = {}) {
  if (!Number.isInteger(maxOffers) || maxOffers < 1 || maxOffers > MAX_OFFERS) {
    throw new TypeError('maxOffers must be an integer between 1 and 50');
  }
  return `(() => {
    const maxOffers = ${maxOffers};
    const one = (root, selector) => root && typeof root.querySelector === 'function'
      ? root.querySelector(selector)
      : null;
    const all = (root, selector) => root && typeof root.querySelectorAll === 'function'
      ? Array.from(root.querySelectorAll(selector))
      : [];
    const text = (node) => typeof node?.textContent === 'string'
      ? node.textContent.replace(/\\s+/g, ' ').trim()
      : '';
    const empty = (status) => ({ status, offers: [], total: 0 });
    if (one(document, 'input[type="password"], form[action*="login"], .login-form')) {
      return empty('login_required');
    }
    if (!one(document, '#leftpanel_oddsboost')) return empty('schema_changed');
    const cards = all(document, '.ob_card');
    const offers = cards.slice(0, maxOffers).map((card) => ({
      kind: text(one(card, '.ob_pap_label')),
      participants: text(one(card, '.ob_bet_placed')),
      description: text(one(card, '.ob_pap')),
      original_odds: text(one(card, '.odds.ob_odds.old')),
      boosted_odds: text(one(card, '.odds.ob_odds.new')),
    }));
    if (offers.some((offer) => !offer.kind || !offer.description)) {
      return empty('schema_changed');
    }
    return { status: 'ready', offers, total: cards.length };
  })()`;
}

function odds(value) {
  const normalized = requiredText(value);
  if (!DECIMAL_PATTERN.test(normalized)) {
    throw schemaError('IM Sports odds boost schema changed');
  }
  return normalized;
}

function normalizeOffer(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw schemaError('IM Sports odds boost schema changed');
  }
  const kind = KIND_BY_LABEL[value.kind];
  const description = requiredText(value.description);
  if (!kind || description.length > 2_000 || /[\u0000-\u001f\u007f]/.test(description)) {
    throw schemaError('IM Sports odds boost schema changed');
  }
  let participants = null;
  if (value.participants !== '') {
    const match = typeof value.participants === 'string'
      ? value.participants.trim().match(/^(\d{1,9})\s*参与$/)
      : null;
    if (!match) throw schemaError('IM Sports odds boost schema changed');
    participants = Number(match[1]);
  }
  const originalOdds = odds(value.original_odds);
  if (typeof value.boosted_odds !== 'string') {
    throw schemaError('IM Sports odds boost schema changed');
  }
  const available = value.boosted_odds.trim() !== '';
  const boostedOdds = available ? odds(value.boosted_odds) : null;
  return {
    kind,
    participants,
    description,
    original_odds: originalOdds,
    boosted_odds: boostedOdds,
    available,
  };
}

function normalizeSportsBoostsPayload(payload) {
  if (payload?.status === 'login_required') {
    throw authError('IM Sports authentication expired');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || payload.status !== 'ready' || !Array.isArray(payload.offers)
    || payload.offers.length > MAX_OFFERS) {
    throw schemaError('IM Sports odds boost schema changed');
  }
  const offers = payload.offers.map(normalizeOffer);
  const total = payload.total === undefined ? offers.length : payload.total;
  if (!Number.isSafeInteger(total) || total < offers.length || total > 10_000) {
    throw schemaError('IM Sports odds boost schema changed');
  }
  return { offers, count: offers.length, truncated: total > offers.length };
}

module.exports = {
  buildSportsBoostsExpression,
  normalizeSportsBoostsPayload,
};
