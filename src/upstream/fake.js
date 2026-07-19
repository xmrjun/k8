'use strict';

function createFakeUpstream({
  sports = [],
  sportsAccount = {},
  balance = {},
  bets = [],
} = {}) {
  const calls = {
    sports: [], sportsAccount: [], balance: [], bets: [],
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
