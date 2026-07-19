# Current Chrome Apple Events Gateway Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a secure macOS Apple Events gateway so the API can read the user's current signed-in Chrome session without CDP or credential extraction.

**Architecture:** Keep the reader and upstream interfaces unchanged. Add an `apple_events` gateway with an injected process runner, select it through `BROWSER_TRANSPORT`, and retain the existing CDP gateway as an explicit fallback.

**Tech Stack:** Node.js CommonJS, `node:child_process`, macOS `osascript`/JXA, Node test runner.

---

### Task 1: Add browser transport configuration

**Files:**
- Modify: `src/config.js`
- Modify: `test/config.test.js`
- Modify: `.env.example`

**Step 1: Write the failing tests**

Assert that `BROWSER_TRANSPORT` defaults to `apple_events`, accepts `apple_events` and `cdp`, rejects all other values, and appears in `publicConfig` without exposing secrets.

**Step 2: Verify RED**

Run: `node --test test/config.test.js`

Expected: FAIL because `browserTransport` is absent.

**Step 3: Implement the minimum configuration**

Add a small enum validator and return `browserTransport` from both config functions. Keep `BROWSER_CDP_URL` validation for explicit CDP mode.

**Step 4: Verify GREEN**

Run: `node --test test/config.test.js`

Expected: PASS.

### Task 2: Add the Apple Events gateway

**Files:**
- Create: `src/browser/apple-events-gateway.js`
- Create: `scripts/chrome-evaluate.jxa`
- Create: `test/apple-events-gateway.test.js`

**Step 1: Write failing gateway tests**

Define the wished-for API:

```js
const gateway = createAppleEventsGateway({
  pageOrigin: 'https://k81128.com',
  runImpl,
});
const value = await gateway.evaluate('({ ok: true })', { signal });
```

Cover exact HTTPS origin validation, non-empty bounded expressions, fixed `/usr/bin/osascript` invocation with arguments rather than a shell, JSON decoding, output caps, abort propagation, missing-tab/permission failures, sanitized errors, status, and no-op close.

**Step 2: Verify RED**

Run: `node --test test/apple-events-gateway.test.js`

Expected: FAIL because the module does not exist.

**Step 3: Implement the minimum gateway and JXA helper**

The helper receives only a pure origin and expression. It enumerates Chrome tabs, evaluates `location.origin`, exact-matches it, evaluates the static reader expression, and prints one JSON envelope. It must not access tab URL properties, cookies, Web Storage, passwords, tokens, or request signatures.

**Step 4: Verify GREEN**

Run: `node --test test/apple-events-gateway.test.js`

Expected: PASS.

### Task 3: Select the transport in server wiring

**Files:**
- Modify: `src/server.js`
- Modify: `test/server.test.js`

**Step 1: Write failing server tests**

Assert that `apple_events` constructs two gateways with the account and sports origins, while `cdp` constructs the existing CDP gateways with the loopback URL. Both modes must share one operation queue.

**Step 2: Verify RED**

Run: `node --test test/server.test.js`

Expected: FAIL because transport selection does not exist.

**Step 3: Implement the minimum factory selection**

Inject separate Apple Events and CDP factories for tests, select strictly from validated config, and leave the upstream adapter unchanged.

**Step 4: Verify GREEN**

Run: `node --test test/server.test.js`

Expected: PASS.

### Task 4: Document and verify local operation

**Files:**
- Modify: `README.md`
- Modify: `docs/im-sports-upstream.md`
- Modify: `deploy/com.nbmrjun.k8-api.plist`

**Step 1: Add documentation assertions if existing script tests cover templates**

Require the default transport, the Chrome menu prerequisite, the macOS Automation prompt, loopback binding, and the explicit CDP fallback to be documented without real credentials or tokenized URLs.

**Step 2: Update templates and run focused tests**

Run: `node --test test/scripts.test.js test/config.test.js test/apple-events-gateway.test.js test/server.test.js`

Expected: PASS.

**Step 3: Run full verification**

Run: `npm test && npm run check && git diff --check`

Expected: all tests pass, lint/check passes, and no whitespace errors.

**Step 4: Perform narrow integration verification**

From a normal Terminal session, start the API and call only health plus one authenticated sports request. Print status, source, count, and schema keys; never print or save browser URLs, credentials, tokens, or the full response.
