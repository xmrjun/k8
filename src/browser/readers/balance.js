'use strict';

const {
  authError,
  currency,
  publicDecimal,
  schemaError,
} = require('./common');

function buildBalanceExpression({ maxWallets = 20 } = {}) {
  if (!Number.isInteger(maxWallets) || maxWallets < 1 || maxWallets > 100) {
    throw new TypeError('maxWallets must be an integer between 1 and 100');
  }

  return `(() => {
    const maxWallets = ${maxWallets};
    const all = (root, selector) => root && typeof root.querySelectorAll === 'function'
      ? Array.from(root.querySelectorAll(selector))
      : [];
    const one = (root, selector) => root && typeof root.querySelector === 'function'
      ? root.querySelector(selector)
      : null;
    const text = (node) => typeof node?.textContent === 'string'
      ? node.textContent.replace(/\\s+/g, ' ').trim()
      : '';
    if (one(document, 'input[type="password"], form[action*="login"], .login-form')) {
      return { status: 'login_required', wallets: [] };
    }
    const walletNodes = all(document, '.balances .wallets .wallet').slice(0, maxWallets);
    if (walletNodes.length === 0) return { status: 'schema_changed', wallets: [] };
    return {
      status: 'ready',
      wallets: walletNodes.map((wallet) => ({
        currency: text(one(wallet, '.cy')),
        amount: text(one(wallet, '.balanceAmout')),
        active: Boolean(wallet.matches?.('.wallet.active')),
      })),
    };
  })()`;
}

function normalizeBalancePayload(payload) {
  if (payload?.status === 'login_required') throw authError('k81128 authentication expired');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || payload.status !== 'ready' || !Array.isArray(payload.wallets)
    || payload.wallets.length === 0 || payload.wallets.length > 100) {
    throw schemaError('k81128 wallet schema changed');
  }

  const active = payload.wallets.filter((wallet) => wallet?.active === true);
  if (active.length !== 1) throw schemaError('k81128 wallet schema changed');
  const wallets = payload.wallets.map((wallet) => {
    if (!wallet || typeof wallet !== 'object' || Array.isArray(wallet)
      || typeof wallet.active !== 'boolean') {
      throw schemaError('k81128 wallet schema changed');
    }
    return {
      currency: currency(wallet.currency),
      amount: publicDecimal(wallet.amount),
    };
  });
  const activeIndex = payload.wallets.indexOf(active[0]);
  return {
    active_currency: wallets[activeIndex].currency,
    total: wallets[activeIndex].amount,
    wallets,
  };
}

module.exports = { buildBalanceExpression, normalizeBalancePayload };
