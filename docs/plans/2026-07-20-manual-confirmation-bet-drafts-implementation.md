# Manual-Confirmation Bet Drafts Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an authenticated, short-lived bet-draft endpoint that verifies current read-only odds and stops at manual confirmation.

**Architecture:** A pure domain service validates strict decimal-string input, locates one currently available selection in a fresh sports snapshot, enforces odds drift, and stores a bounded two-minute draft in memory with idempotency. The HTTP app owns bounded JSON parsing and exposes only `POST /api/bets/drafts`; no adapter or route can submit, confirm, cancel, settle, or cash out a wager.

**Tech Stack:** Node.js 22, CommonJS, `node:test`, existing browser upstream and response envelope.

---

### Task 1: Validate and calculate draft values

**Files:**
- Create: `src/bet-drafts.js`
- Create: `test/bet-drafts.test.js`

**Step 1: Write the failing input-validation tests**

Add tests that import `normalizeDraftInput` and prove it accepts only the exact
fields from the design. Cover `scope`, `sport`, numeric `event_id`, bounded
`selection_key`, stake `0.01..1000000.00`, decimal odds, non-negative drift,
bounded idempotency key, unknown fields, numbers in place of strings, and
prototype-bearing/non-object input.

**Step 2: Run the tests and verify RED**

Run: `node --test test/bet-drafts.test.js`

Expected: FAIL because `src/bet-drafts.js` does not exist.

**Step 3: Implement the minimal validator**

Create a `DraftError` containing only a stable `code` and implement strict
normalization with allow-lists shared conceptually with `/api/sports`. Keep all
decimal values as canonical strings and cap their input length.

**Step 4: Write and verify a failing arithmetic test**

Test `decimalDifferenceExceeds` and `multiplyMoneyByOdds` with exact decimal
values, including trailing zeros and half-up currency rounding.

Run: `node --test test/bet-drafts.test.js`

Expected: FAIL because the arithmetic functions are absent.

**Step 5: Implement exact integer-scaled arithmetic and verify GREEN**

Parse decimals into `{ coefficient: BigInt, scale }`, compare absolute
differences at a common scale, and calculate a two-decimal gross return without
using floating-point arithmetic.

Run: `node --test test/bet-drafts.test.js`

Expected: PASS.

**Step 6: Commit**

```bash
git add src/bet-drafts.js test/bet-drafts.test.js
git commit -m "feat: validate manual bet drafts"
```

### Task 2: Add bounded TTL storage and idempotency

**Files:**
- Modify: `src/bet-drafts.js`
- Modify: `test/bet-drafts.test.js`

**Step 1: Write failing store tests**

Test `createDraftStore` with an injected clock and ID generator. Prove identical
replays return the original draft, different input with the same key yields
`IDEMPOTENCY_CONFLICT`, entries expire at 120 seconds, expired keys may be
reused, and the 1001st live entry evicts the oldest of 1000.

**Step 2: Run the tests and verify RED**

Run: `node --test test/bet-drafts.test.js`

Expected: FAIL because `createDraftStore` is absent.

**Step 3: Implement the minimal store**

Use one insertion-ordered `Map`. Clean expired entries before each operation,
fingerprint the normalized input with deterministic field ordering, freeze
stored drafts, and never persist them to disk.

**Step 4: Run the tests and verify GREEN**

Run: `node --test test/bet-drafts.test.js`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/bet-drafts.js test/bet-drafts.test.js
git commit -m "feat: store short-lived bet drafts"
```

### Task 3: Verify a draft against a fresh sports snapshot

**Files:**
- Modify: `src/bet-drafts.js`
- Modify: `test/bet-drafts.test.js`

**Step 1: Write failing service tests**

Test `createBetDraftService({ upstream, now, idGenerator })`. Use a real-shaped
snapshot containing `events[].markets[].selections[]`. Assert that it:

- calls `upstream.getSports({ scope, sport })` once for a new draft;
- finds exactly one matching event and selection;
- rejects missing/duplicate events and selections;
- rejects locked or unavailable selections;
- rejects drift above the request limit;
- reports allowed drift and current odds;
- calculates projected gross return from current odds;
- returns `ready_for_manual_confirmation` and a two-minute expiry;
- returns an idempotent replay without a second upstream read.

**Step 2: Run the tests and verify RED**

Run: `node --test test/bet-drafts.test.js`

Expected: FAIL because the service is absent.

**Step 3: Implement the minimal service**

Normalize before lookup, check the store for an idempotent replay, fetch the
uncached snapshot, fail closed on any ambiguity, build the local draft, then
store it. Do not add methods named submit, confirm, settle, cancel, or cashout.

**Step 4: Run the tests and verify GREEN**

Run: `node --test test/bet-drafts.test.js`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/bet-drafts.js test/bet-drafts.test.js
git commit -m "feat: verify bet drafts against current odds"
```

### Task 4: Expose the authenticated POST route

**Files:**
- Create: `src/json-body.js`
- Create: `test/json-body.test.js`
- Modify: `src/app.js`
- Modify: `test/app.test.js`
- Modify: `src/server.js`
- Modify: `test/server.test.js`
- Modify: `package.json`

**Step 1: Write failing bounded-body tests**

Test `readJsonBody(request, { maxBytes: 8192 })` with real streams. Cover valid
JSON, malformed JSON, empty input, oversized declared length, oversized streamed
content, aborted input, and non-JSON media types. Errors expose only stable codes.

**Step 2: Run the tests and verify RED**

Run: `node --test test/json-body.test.js`

Expected: FAIL because the module is absent.

**Step 3: Implement bounded JSON parsing and verify GREEN**

Read at most 8192 bytes, allow `application/json` with an optional charset, and
never retain or log the body in an error.

Run: `node --test test/json-body.test.js`

Expected: PASS.

**Step 4: Write failing route tests**

Test that `POST /api/bets/drafts`:

- rejects missing Bearer authentication before reading the body;
- rejects query parameters, invalid content type, bad JSON, and oversized bodies;
- calls a fresh sports read and returns the stable success envelope;
- maps draft validation/conflict errors to sanitized `400`/`409` responses;
- preserves existing upstream error mapping;
- advertises only `POST` for this path;
- leaves every other non-GET route at `405`;
- has no confirmation, submission, cashout, cancel, or settlement route.

**Step 5: Run route tests and verify RED**

Run: `node --test test/app.test.js`

Expected: FAIL because the route is absent.

**Step 6: Implement minimal route composition**

Construct one draft service per `createApp`, authenticate before body parsing,
reject all query keys, parse the bounded body, call `draftService.create`, and
return source `im-sports-browser`. Add the new module to `npm run check`.

**Step 7: Run focused tests and verify GREEN**

Run: `node --test test/json-body.test.js test/bet-drafts.test.js test/app.test.js test/server.test.js`

Expected: PASS.

**Step 8: Commit**

```bash
git add src/json-body.js src/app.js src/server.js package.json \
  test/json-body.test.js test/app.test.js test/server.test.js
git commit -m "feat: expose manual-confirmation bet drafts"
```

### Task 5: Document the safe handoff contract

**Files:**
- Modify: `README.md`
- Modify: `docs/operations.md`
- Modify: `docs/im-sports-upstream.md`

**Step 1: Write a failing documentation assertion**

Add a test in `test/scripts.test.js` requiring the README/operations text to
state the endpoint, two-minute expiry, idempotency, fresh-odds validation,
manual final confirmation, and permanent absence of real-order submission.

**Step 2: Run the test and verify RED**

Run: `node --test test/scripts.test.js`

Expected: FAIL because the contract is undocumented.

**Step 3: Update documentation**

Add a curl example using placeholders only. Document every request/response
field and stable error. Explicitly state that the service never opens, clicks,
submits, confirms, cancels, settles, or cashes out a wager.

**Step 4: Run the test and verify GREEN**

Run: `node --test test/scripts.test.js`

Expected: PASS.

**Step 5: Commit**

```bash
git add README.md docs/operations.md docs/im-sports-upstream.md test/scripts.test.js
git commit -m "docs: explain manual bet draft workflow"
```

### Task 6: Final verification and publication

**Files:**
- Review all files changed since `c838788`

**Step 1: Run syntax and complete tests**

Run: `npm run check && npm test && git diff --check`

Expected: all checks and all tests pass with zero failures.

**Step 2: Run a prohibited-capability scan**

Search production changes for browser clicks, private endpoint calls, credential
reads, and any submit/confirm/cancel/settle/cashout method. Review every match;
only documentation that says those actions are absent may match.

**Step 3: Request code review**

Review correctness, fail-closed behavior, decimal arithmetic, bounded memory and
body handling, authentication order, error sanitization, and absence of a real
transaction path. Fix findings with a failing regression test first.

**Step 4: Commit any review fixes and push over SSH**

```bash
git push origin feature/browser-bridge
```

**Step 5: Verify publication**

Confirm `HEAD` equals `origin/feature/browser-bridge` and the worktree is clean.
