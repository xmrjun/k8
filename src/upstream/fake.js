'use strict';

function createFakeUpstream({
  sports = [],
  sportsAccount = {},
  sportsCatalog = {},
  sportsBoosts = {},
  balance = {},
  bets = [],
} = {}) {
  const calls = {
    sports: [], sportsAccount: [], sportsCatalog: [], sportsBoosts: [],
    balance: [], bets: [],
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
  };
}

module.exports = { createFakeUpstream };
