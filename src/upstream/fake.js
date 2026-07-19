'use strict';

function createFakeUpstream({ sports = [], balance = {}, bets = [] } = {}) {
  const calls = { sports: [], balance: [], bets: [] };
  return {
    calls,
    async getSports() {
      calls.sports.push({});
      return sports;
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
