# IM Sports Account Summary Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a read-only `GET /api/sports/account` endpoint that returns the visible IM Sports currency, available balance, and unsettled amount without exposing browser credentials or the venue URL token.

**Architecture:** A new bounded DOM reader runs through the existing IM Sports browser gateway and serialized operation queue. It returns three raw visible strings with an explicit page status; Node validates and normalizes them into the public account-summary model. The HTTP route is bearer-protected, uncached, and independent of the existing k81128 `/api/balance` endpoint.

**Tech Stack:** Node.js 22, CommonJS, built-in `node:test`, existing Apple Events/CDP browser gateway interfaces.

---

### Task 1: Record the verified DOM contract

**Files:**
- Modify: `docs/im-sports-upstream.md`

**Step 1: Add the verified selector contract**

Document the unique account container and bounded child selectors:

```text
#left_panel .leftmenu_account
.leftmenu_account_title
.leftmenu_content .row
.text-right
```

Record that rows are selected by the exact visible labels `余额` and `未结算注单`, not by position. State that only a maximum of eight account rows may be inspected and that real amounts are never stored in fixtures or docs.

**Step 2: Check the documentation diff**

Run: `git diff --check && git diff -- docs/im-sports-upstream.md`

Expected: no whitespace errors; only the bounded account-panel contract is added.

**Step 3: Commit**

```bash
git add docs/im-sports-upstream.md
git commit -m "docs: record IM Sports account selectors"
```

### Task 2: Add the bounded account-summary reader with TDD

**Files:**
- Create: `src/browser/readers/sports-account.js`
- Create: `test/browser-sports-account-reader.test.js`

**Step 1: Write failing normalizer tests**

Create synthetic payload tests for:

```js
normalizeSportsAccountPayload({
  status: 'ready',
  heading: '账户 (USD)',
  available: '12.50',
  unsettled: '1,234.00',
});
```

Expected public value:

```js
{
  currency: 'USD',
  available_balance: 12.5,
  unsettled_amount: 1234,
}
```

Also test high-precision decimals remain strings, `login_required` maps to `UPSTREAM_AUTH_EXPIRED`, and missing, negative, malformed, or incorrectly comma-grouped values map to `UPSTREAM_SCHEMA_CHANGED`.

**Step 2: Write failing expression-safety tests**

Assert the generated expression contains only the verified account selectors and exact labels, caps rows with `slice(0, 8)`, distinguishes `ready`, `login_required`, and `schema_changed`, and excludes `cookie`, `localStorage`, `sessionStorage`, `indexedDB`, `fetch(`, `location.href`, and network APIs.

**Step 3: Run tests to verify RED**

Run: `node --test test/browser-sports-account-reader.test.js`

Expected: FAIL because `src/browser/readers/sports-account.js` does not exist.

**Step 4: Implement the minimal reader**

Export:

```js
module.exports = {
  buildSportsAccountExpression,
  normalizeSportsAccountPayload,
};
```

The expression must return only:

```js
{ status, heading, available, unsettled }
```

The normalizer parses the currency from `账户 (USD)`, validates either plain decimal text or correctly grouped comma decimal text, removes commas, and delegates final decimal serialization to the existing `publicDecimal` helper.

**Step 5: Run tests to verify GREEN**

Run: `node --test test/browser-sports-account-reader.test.js`

Expected: all new reader tests pass.

**Step 6: Commit**

```bash
git add src/browser/readers/sports-account.js test/browser-sports-account-reader.test.js
git commit -m "feat: read IM Sports account summary"
```

### Task 3: Connect the reader to the browser upstream

**Files:**
- Modify: `src/upstream/browser.js`
- Modify: `src/upstream/fake.js`
- Modify: `src/server.js`
- Modify: `test/browser-upstream.test.js`
- Modify: `test/server.test.js`

**Step 1: Write failing upstream tests**

Add tests proving:

```js
await upstream.getSportsAccount();
```

uses only `sportsGateway`, uses the new reader, shares the existing serialized queue, and does not call `accountGateway`. Add `getSportsAccount` to fake and disabled upstream contract tests.

**Step 2: Run tests to verify RED**

Run: `node --test test/browser-upstream.test.js test/server.test.js`

Expected: FAIL because `getSportsAccount` is missing.

**Step 3: Implement the minimal upstream wiring**

Import the new reader in `src/upstream/browser.js`, add a `sportsAccount` reader entry, and expose:

```js
getSportsAccount: () => perform(sportsGateway, selectedReaders.sportsAccount)
```

Add the same method to fake and disabled adapters so every upstream implementation has the same contract.

**Step 4: Run tests to verify GREEN**

Run: `node --test test/browser-upstream.test.js test/server.test.js`

Expected: all focused upstream tests pass.

**Step 5: Commit**

```bash
git add src/upstream/browser.js src/upstream/fake.js src/server.js test/browser-upstream.test.js test/server.test.js
git commit -m "feat: expose IM Sports account upstream"
```

### Task 4: Add the uncached authenticated HTTP route

**Files:**
- Modify: `src/app.js`
- Modify: `test/app.test.js`

**Step 1: Write failing API tests**

Add tests proving `GET /api/sports/account`:

- rejects a missing bearer token with `401`;
- rejects any query parameter with `400 INVALID_REQUEST`;
- calls `getSportsAccount` on every request rather than caching;
- returns the standard envelope with source `im-sports-browser`;
- preserves the existing sanitized browser/auth/schema error mappings.

**Step 2: Run tests to verify RED**

Run: `node --test test/app.test.js`

Expected: FAIL with `404 NOT_FOUND` for the new route.

**Step 3: Implement the minimal route**

Add `/api/sports/account` to the protected route allow-list before dispatch. For that exact path, require zero query parameters, call `upstream.getSportsAccount()`, and send the existing success envelope without using `sportsCache`.

**Step 4: Run tests to verify GREEN**

Run: `node --test test/app.test.js`

Expected: all API tests pass.

**Step 5: Commit**

```bash
git add src/app.js test/app.test.js
git commit -m "feat: add IM Sports account endpoint"
```

### Task 5: Document, verify, and hand off runtime restart

**Files:**
- Modify: `README.md`
- Modify: `docs/operations.md`

**Step 1: Update operator documentation**

List `GET /api/sports/account`, its three public fields, its uncached behavior, and the requirement that the signed-in IM Sports tab remain open. Keep the existing warning never to expose the full venue URL or browser control ports.

**Step 2: Run complete verification**

Run:

```bash
npm test
npm run check
git diff --check
git status --short
```

Expected: all tests and syntax checks pass, with only intended documentation changes left.

**Step 3: Commit documentation**

```bash
git add README.md docs/operations.md
git commit -m "docs: document IM Sports account endpoint"
```

**Step 4: Restart and verify safely**

Restart `npm start` from the user's already-authorized Terminal session. Call local and public `/api/sports/account` with the bearer token loaded from `.env.local`, but print only HTTP status, source, currency, and booleans indicating the two amount fields exist. Never print the actual amounts or token.

Expected: local and public requests both return `200`, source `im-sports-browser`, currency `USD`, and both field-presence booleans are true.
