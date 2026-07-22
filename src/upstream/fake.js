'use strict';

function createFakeUpstream({
  sports = [],
  sportsAccount = {},
  sportsCatalog = {},
  sportsBoosts = {},
  balance = {},
  bets = [],
  placeBet = async (draft) => ({ bet_id: 'fake-bet-1', draft_id: draft?.draft_id }),
} = {}) {
  const calls = {
    sports: [], sportsAccount: [], sportsCatalog: [], sportsBoosts: [],
    balance: [], bets: [], placeBet: [],
  };
  return {
    calls,
    async getSports(options = {}) {
      calls.sports.push(options);
      return sports;
    },
    async getSportsAccount() {
      calls.sportsAccount.push({});
      return sportsAccount;
    },
    async getSportsCatalog() {
      calls.sportsCatalog.push({});
      return sportsCatalog;
    },
    async getSportsBoosts() {
      calls.sportsBoosts.push({});
      return sportsBoosts;
    },
    async getBalance() {
      calls.balance.push({});
      return balance;
    },
    async getBets(options = {}) {
      calls.bets.push(options);
      return bets;
    },
    async placeBet(draft) {
      calls.placeBet.push(draft);
      return placeBet(draft);
    },
  };
}

module.exports = { createFakeUpstream };
