# IM Sports Bet Records Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the incorrect k81128 game-record adapter with a protected, uncached IM Sports popup record endpoint supporting unsettled, settled, and combined reads.

**Architecture:** Add exact-path matching to browser target discovery and create a third gateway dedicated to the same-origin IM Sports `/popup/` page. A bounded DOM reader selects only the two exact record tabs, returns visible row cells, and normalizes them in Node before applying numeric-offset pagination. The HTTP layer validates `status`, reports `im-sports-browser`, and never caches account records.

**Tech Stack:** Node.js 22, CommonJS, built-in `node:test`, existing CDP/Apple Events browser gateways and serialized operation queue.

---

### Task 1: Record and test exact-path browser target separation

**Files:**
- Modify: `src/browser/target-discovery.js`
- Modify: `src/browser/gateway.js`
- Modify: `src/browser/apple-events-gateway.js`
- Modify: `scripts/chrome-evaluate.jxa`
- Modify: `test/browser-target-discovery.test.js`
- Modify: `test/browser-gateway.test.js`
- Modify: `test/apple-events-gateway.test.js`
- Modify: `test/chrome-evaluate-helper.test.js`

**Step 1: Write failing tests**

Add a target-discovery test with two same-origin targets and require:

```js
const discovery = createTargetDiscovery({
  cdpUrl: 'http://127.0.0.1:9223',
  pageOrigin: 'https://sports.example.test:2053',
  pagePathname: '/popup/',
  fetchImpl,
});
assert.equal((await discovery.discover()).webSocketDebuggerUrl, popupDebuggerUrl);
```

Add rejection tests for pathnames that are not absolute path-only values, including values containing `?`, `#`, or a full URL. Add equivalent gateway tests proving that the path is passed to discovery without exposing a target URL in an error. Add Apple Events helper tests proving it reads only `location.origin` and `location.pathname`, never the full `location.href`.

**Step 2: Run tests to verify RED**

Run:

```bash
node --test test/browser-target-discovery.test.js test/browser-gateway.test.js test/apple-events-gateway.test.js test/chrome-evaluate-helper.test.js
```

Expected: FAIL because `pagePathname` is not supported and same-origin discovery selects the first page.

**Step 3: Implement minimal exact-path support**

Validate the optional value with:

```js
function allowedPagePathname(value = '/') {
  if (typeof value !== 'string' || !value.startsWith('/')
    || value.includes('?') || value.includes('#') || value.includes('\\')) {
    throw new TypeError('Page pathname must be an absolute path without query or fragment');
  }
  const parsed = new URL(value, 'https://path.invalid');
  if (parsed.origin !== 'https://path.invalid' || parsed.pathname !== value) {
    throw new TypeError('Page pathname must be an absolute path without query or fragment');
  }
  return value;
}
```

Require both `parsed.origin === expectedPageOrigin` and `parsed.pathname === expectedPagePathname` in CDP discovery. Pass the same validated pathname as a separate JXA helper argument; the helper compares a tab-evaluated `location.pathname` and never requests the tab URL property or query string.

**Step 4: Run tests to verify GREEN**

Run the Step 2 command. Expected: all focused tests pass.

**Step 5: Commit**

```bash
git add src/browser/target-discovery.js src/browser/gateway.js src/browser/apple-events-gateway.js scripts/chrome-evaluate.jxa test/browser-target-discovery.test.js test/browser-gateway.test.js test/apple-events-gateway.test.js test/chrome-evaluate-helper.test.js
git commit -m "feat: separate browser targets by pathname"
```

### Task 2: Replace the bet reader with the IM Sports popup contract

**Files:**
- Modify: `src/browser/readers/bets.js`
- Replace: `test/fixtures/browser-bets-dom.json`
- Modify: `test/browser-bets-reader.test.js`
- Modify: `docs/im-sports-upstream.md`

**Step 1: Write failing normalizer tests**

Use only synthetic rows and require:

```js
assert.deepEqual(normalizeBetsPayload(payload, {
  status: 'unsettled', limit: 25,
}), [{
  bet_id: 'SYNTHETIC-1',
  placed_at: '2026-07-19T02:30:00.000Z',
  status: 'unsettled',
  description: 'Synthetic event and selection',
  odds: 2.25,
  stake: 10,
  currency: 'USD',
  potential_payout: 22.5,
}]);
```

Add tests for settled rows, `status=all`, verified empty tabs, numeric cursor slicing, comma-formatted decimals, displayed odds changes, login markers, missing required cells, invalid timestamps/amounts, mismatched requested status, more than 200 rows, and unexpected tab state. Every malformed payload must map to a sanitized known error.

**Step 2: Write failing expression-safety tests**

Require `buildBetsExpression({ status, maxRows: 200 })` to:

- contain only the exact tab labels `未结算注单` and `已结算注单` as click candidates;
- cap inspected elements and rows;
- return `login_required`, `ready`, `empty`, or `schema_changed` markers;
- restore the originally active record tab after `status=all`;
- exclude `cookie`, `localStorage`, `sessionStorage`, `indexedDB`, `fetch(`, `XMLHttpRequest`, `WebSocket`, `location.href`, and any bet/cash-out confirmation text.

**Step 3: Run tests to verify RED**

Run:

```bash
node --test test/browser-bets-reader.test.js
```

Expected: FAIL because the existing reader expects the unrelated `.gameTable` k81128 schema.

**Step 4: Implement the minimal reader**

The expression must return only:

```js
{
  status: 'ready',
  currency_heading: '账户 (USD)',
  selected_status: 'unsettled',
  empty: false,
  rows: [[dateAndIdText, descriptionText, oddsText, stakeText, stateText]],
}
```

It scans at most 256 tab candidates and at most 200 record rows. It may invoke `.click()` only on the unique leaf element whose normalized text exactly equals one of the two allowed tab labels. It waits for a bounded DOM change, never follows links, and never interacts with a record row. Node validates the currency heading, parses the local GMT+8 timestamp to ISO, selects the last displayed decimal odds, and uses `null` only when a potential payout is not visibly present.

**Step 5: Run tests to verify GREEN**

Run the Step 3 command. Expected: all reader tests pass.

**Step 6: Commit**

```bash
git add src/browser/readers/bets.js test/browser-bets-reader.test.js test/fixtures/browser-bets-dom.json docs/im-sports-upstream.md
git commit -m "feat: read IM Sports bet records"
```

### Task 3: Wire a dedicated popup gateway into the browser upstream

**Files:**
- Modify: `src/upstream/browser.js`
- Modify: `src/server.js`
- Modify: `test/browser-upstream.test.js`
- Modify: `test/server.test.js`

**Step 1: Write failing composition tests**

Require `createConfiguredUpstream` to create:

```js
[
  { pageOrigin: sportsOrigin, pagePathname: '/' },
  { pageOrigin: accountOrigin, pagePathname: '/' },
  { pageOrigin: sportsOrigin, pagePathname: '/popup/' },
]
```

Require `getBets()` to use only `betsGateway`, while `getSports()` and `getSportsAccount()` use only the main sports gateway and `getBalance()` uses only the account gateway. Require shutdown to close all three exactly once and all operations to share one serial queue.

**Step 2: Run tests to verify RED**

Run:

```bash
node --test test/browser-upstream.test.js test/server.test.js
```

Expected: FAIL because `getBets()` still uses `accountGateway` and there is no popup gateway.

**Step 3: Implement minimal wiring**

Change the constructor contract to:

```js
createBrowserUpstream({ sportsGateway, accountGateway, betsGateway, queue, readers })
```

Dispatch `getBets(options)` through `betsGateway`. In `createConfiguredUpstream`, instantiate the popup gateway with the IM Sports origin and exact `/popup/` pathname. Close all distinct gateways once during shutdown.

**Step 4: Run tests to verify GREEN**

Run the Step 2 command. Expected: all focused tests pass.

**Step 5: Commit**

```bash
git add src/upstream/browser.js src/server.js test/browser-upstream.test.js test/server.test.js
git commit -m "feat: route bet records through IM popup"
```

### Task 4: Add status-aware HTTP query validation

**Files:**
- Modify: `src/app.js`
- Modify: `test/app.test.js`

**Step 1: Write failing route tests**

Require:

```js
GET /api/bets?status=all&limit=25&cursor=0
```

to call:

```js
upstream.getBets({ status: 'all', limit: 25, cursor: '0' })
```

Add tests for defaults, each allowed status, duplicate/unknown parameters, invalid status, non-numeric or unsafe cursors, authentication, no caching, source `im-sports-browser`, and sanitized popup/auth/schema failures.

**Step 2: Run tests to verify RED**

Run: `node --test test/app.test.js`

Expected: FAIL because `status` is rejected or ignored and the response source is `k81128`.

**Step 3: Implement minimal routing**

Allow only `status`, `limit`, and `cursor`. Default to:

```js
{ status: 'all', limit: 25, cursor: undefined }
```

Accept only the three exact status strings and only a non-negative decimal cursor. Send the existing standard success envelope with source `im-sports-browser` and no cache.

**Step 4: Run tests to verify GREEN**

Run the Step 2 command. Expected: all API tests pass.

**Step 5: Commit**

```bash
git add src/app.js test/app.test.js
git commit -m "feat: expose IM Sports bet filters"
```

### Task 5: Document and verify the complete read-only service

**Files:**
- Modify: `README.md`
- Modify: `docs/operations.md`

**Step 1: Update operator documentation**

Document the new query contract, the requirement to keep both the main IM Sports page and record popup open, the exact `503`/`502` failure meanings, and the strict prohibition on exposing the CDP port or storing browser credentials. State that only the exact record-filter tabs may be changed automatically and no financial action is implemented.

**Step 2: Run static and full automated verification**

Run:

```bash
npm run check
npm test
git diff --check
git status --short
```

Expected: syntax checks pass, all tests pass, no whitespace errors, and only intended files are modified.

**Step 3: Run sanitized local integration checks**

With the dedicated Chrome main page and record popup open, call the local endpoint for all three statuses. Report only status code, array length, and sorted field names. Never print record values, browser page URLs, bearer tokens, or popup tokens.

Expected: authenticated calls return `200`; a deliberately invalid bearer token returns `401`; closing the popup changes only `/api/bets` to `503` while the live sports feed remains available.

**Step 4: Restart and verify the official process**

Restart the existing desktop-managed API process without changing its `.env.local`, Chrome profile, loopback CDP binding, or tunnel configuration. Run the existing WebSocket smoke test and a sanitized public HTTP `/api/bets` shape check.

Expected: local and public API calls succeed through the existing tunnel, invalid credentials are rejected, and the live WebSocket feed remains operational.

**Step 5: Commit**

```bash
git add README.md docs/operations.md docs/plans/2026-07-19-im-sports-bets-design.md docs/plans/2026-07-19-im-sports-bets-implementation.md
git commit -m "docs: describe IM Sports bet records"
```
