# IM Sports Catalog and Odds Boost Implementation Plan

1. Add failing synthetic-DOM tests for the catalog reader, including all verified
   sport labels, popular tournament bounds, the three navigation tabs, login state,
   schema failures, and forbidden browser/private-data APIs.
2. Implement `sports-catalog.js` with exact label mapping and strict normalization.
3. Add failing tests for odds-boost event-parlay and chain-parlay cards, locked or
   unavailable cards, row limits, malformed odds, login state, and forbidden actions.
4. Implement `sports-boosts.js` with a maximum of 50 visible cards and no action URL.
5. Route both readers through the existing sports gateway and serial operation queue.
6. Add authenticated, query-free GET routes for `/api/sports/catalog` and
   `/api/sports/boosts`, then update fakes, disabled upstreams, and endpoint tests.
7. Document the endpoints and state explicitly that catalog support is not event
   parser support and that wagering writes remain unavailable.
8. Run `npm run check`, `npm test`, and `git diff --check`; commit and push the feature
   branch through the existing SSH remote.

