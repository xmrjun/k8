# k81128 Browser Bridge Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Connect the existing token-protected Node.js API to a dedicated, locally logged-in Chrome instance and return verified read-only sports, wallet, and game-record data without extracting browser credentials.

**Architecture:** A dependency-free CDP gateway connects only to `http://127.0.0.1:9223`, selects an allow-listed `https://k81128.com` page target, and evaluates bounded DOM readers. A single-operation queue serializes browser work. The existing HTTP layer remains the only tunnel-exposed surface; CDP remains loopback-only. User login is manual and credentials, Cookie, Local Storage, Session Storage, and request tokens are never read or returned.

**Tech Stack:** Node.js 22 built-ins (`http`, `fetch`, `WebSocket`, `crypto`, `node:test`), Chrome DevTools Protocol, launchd, Cloudflare Tunnel.

---

### Task 1: Add browser configuration and stable browser errors

**Files:**
- Modify: `.env.example`
- Modify: `src/config.js`
- Modify: `src/upstream/errors.js`
- Modify: `src/app.js`
- Test: `test/config.test.js`
- Test: `test/app.test.js`

**Step 1: Write failing configuration and HTTP mapping tests**

Add tests requiring these defaults and validations:

- `UPSTREAM_MODE=browser`
- `BROWSER_CDP_URL=http://127.0.0.1:9223`
- `BROWSER_PAGE_ORIGIN=https://k81128.com`
- `BROWSER_OPERATION_TIMEOUT_MS=15000`
- Reject non-loopback CDP hosts.
- Reject non-HTTPS page origins.
- Map `BROWSER_UNAVAILABLE` to HTTP `503` with a sanitized message.

**Step 2: Run focused tests and verify failure**

Run: `node --test test/config.test.js test/app.test.js`

Expected: FAIL because browser settings and `BROWSER_UNAVAILABLE` do not exist.

**Step 3: Implement minimum settings and mapping**

Extend `loadConfig()` and `publicConfig()` without exposing secrets. Add `CODES.BROWSER_UNAVAILABLE`. Keep existing direct-client settings for test compatibility, but select production behavior using `UPSTREAM_MODE`.

**Step 4: Run focused and full tests**

Run: `node --test test/config.test.js test/app.test.js && npm test`

Expected: PASS.

**Step 5: Commit**

```bash
git add .env.example src/config.js src/upstream/errors.js src/app.js test/config.test.js test/app.test.js
git commit -m "feat: add secure browser bridge configuration"
```

### Task 2: Build a serial browser-operation queue

**Files:**
- Create: `src/browser/operation-queue.js`
- Test: `test/browser-operation-queue.test.js`

**Step 1: Write failing queue tests**

Cover:

- operations execute strictly one at a time;
- later work continues after an earlier rejection;
- per-operation timeout maps to `UPSTREAM_TIMEOUT`;
- timeout does not retain or expose the underlying error object;
- queue depth is bounded to reject overload without allocating unbounded work.

**Step 2: Run test and verify failure**

Run: `node --test test/browser-operation-queue.test.js`

Expected: FAIL because the module does not exist.

**Step 3: Implement the minimum queue**

Use a private promise tail, a fixed maximum pending count, and an unreferenced timeout. Do not cancel unrelated queued operations when one operation times out.

**Step 4: Run focused and full tests**

Run: `node --test test/browser-operation-queue.test.js && npm test`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/browser/operation-queue.js test/browser-operation-queue.test.js
git commit -m "feat: serialize browser operations"
```

### Task 3: Implement a dependency-free loopback CDP gateway

**Files:**
- Create: `src/browser/cdp-client.js`
- Create: `src/browser/gateway.js`
- Test: `test/cdp-client.test.js`
- Test: `test/browser-gateway.test.js`

**Step 1: Write failing CDP transport tests**

Use fake `fetch` and fake WebSocket implementations. Cover:

- `/json/list` is fetched only from the configured loopback CDP origin;
- only `type: "page"` targets on the exact allow-listed origin are accepted;
- lookalike origins such as `k81128.com.evil.example` are rejected;
- `Runtime.evaluate` uses `returnByValue: true` and `awaitPromise: true`;
- response IDs resolve only their matching requests;
- CDP error frames and socket closure reject pending calls with sanitized errors;
- reconnect occurs on the next request after a disconnect;
- response values are capped before leaving the gateway.

**Step 2: Run tests and verify failure**

Run: `node --test test/cdp-client.test.js test/browser-gateway.test.js`

Expected: FAIL because the modules do not exist.

**Step 3: Implement the transport and target selector**

Use Node.js 22's built-in `WebSocket`. Never log the `webSocketDebuggerUrl`, page response, or evaluation exception details. The public gateway contract is:

```js
await gateway.evaluate(expression, { timeoutMs });
await gateway.status();
await gateway.close();
```

`status()` returns only `connected`, `page_found`, or `unavailable` and never exposes page titles, account identifiers, or CDP URLs.

**Step 4: Run focused and full tests**

Run: `node --test test/cdp-client.test.js test/browser-gateway.test.js && npm test`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/browser/cdp-client.js src/browser/gateway.js test/cdp-client.test.js test/browser-gateway.test.js
git commit -m "feat: add loopback Chrome CDP gateway"
```

### Task 4: Add verified sports DOM reading and normalization

**Files:**
- Create: `src/browser/readers/sports.js`
- Create: `test/fixtures/browser-sports-dom.json`
- Test: `test/browser-sports-reader.test.js`
- Modify: `docs/k81128-upstream.md`

**Step 1: Save only sanitized verified selectors**

Document the 2026-07-19 read-only discovery:

- card: `.ysb-item`
- competition: `.ysb-item__body__title__competition`
- start text: `.ysb-item__body__title__time`
- teams: `.ysb-item__body__team-match .col`
- selections: `.odd-wrapper .odd-item`
- selection name: `.competition-result`
- decimal odds: `.odds-rate span`

Do not save screenshots, account names, balance values, or browser storage.

**Step 2: Write failing reader tests**

Cover:

- 1X2 selections map to the stable public sports model;
- `MM-DD HH:mm` is assigned the correct Asia/Shanghai year, including December-to-January rollover;
- a deterministic synthetic `event_id` is derived from competition, start time, and teams;
- missing teams, time, selections, or odds produce `UPSTREAM_SCHEMA_CHANGED`;
- page showing the login form produces `UPSTREAM_AUTH_EXPIRED`;
- no event cards produces schema failure rather than a fake empty success.

**Step 3: Implement expression generation and Node-side validation**

The browser expression returns only bounded plain JSON from at most 200 cards. Hash event identity in Node with SHA-256; do not use DOM indexes as IDs. Parse odds as decimal strings before applying public numeric conversion.

**Step 4: Run tests**

Run: `node --test test/browser-sports-reader.test.js && npm test`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/browser/readers/sports.js test/fixtures/browser-sports-dom.json test/browser-sports-reader.test.js docs/k81128-upstream.md
git commit -m "feat: read verified sports data from Chrome"
```

### Task 5: Add verified wallet and game-record readers

**Files:**
- Create: `src/browser/readers/balance.js`
- Create: `src/browser/readers/bets.js`
- Create: `test/fixtures/browser-balance-dom.json`
- Create: `test/fixtures/browser-bets-dom.json`
- Test: `test/browser-balance-reader.test.js`
- Test: `test/browser-bets-reader.test.js`
- Modify: `docs/k81128-upstream.md`

**Step 1: Record the verified selectors and routes**

Balance selectors:

- wallet list: `.balances .wallets .wallet`
- currency label: `.cy`
- amount: `.balanceAmout`
- active wallet: `.wallet.active`

Game-record route and selectors:

- route: `/assetDetails/gameRecord`
- table: `.gameTable`
- body: `.gameTable .recordList`
- empty state: `.noRecord` with `暂无记录`
- columns: time, type, game round ID, stake, payout.

The reliable navigation path is the visible account menu `li.mainItem.record`, which opens `/assetDetails/depositRecord`, followed by the exact `电游记录` tab. Direct navigation is allowed only after the gateway has already confirmed a logged-in allow-listed page.

**Step 2: Write failing balance tests**

Return a truthful model:

```json
{
  "active_currency": "USDT",
  "total": 0.24,
  "wallets": [
    {"currency":"CNY","amount":0.98},
    {"currency":"USDT","amount":0.24}
  ]
}
```

Cover multiple wallets, active-wallet selection, decimal precision, missing active wallet, login form, and schema changes.

**Step 3: Write failing bet-reader tests**

Cover empty record list, one and multiple rows, limit enforcement, deterministic cursor slicing, decimal precision, missing columns, and login form. Do not invent sport-bet fields that the verified game-record table does not expose.

The first browser-backed public bet model is:

```json
{
  "bet_id": "<game round id>",
  "placed_at": "<ISO 8601>",
  "type": "<provider/game type>",
  "stake": 10,
  "currency": "USDT",
  "payout": 0
}
```

**Step 4: Implement bounded DOM expressions and validators**

Read at most 200 wallet/row elements. Return `[]` only when the verified `.noRecord` state is present. Treat a missing table as a schema or authentication error.

**Step 5: Run focused and full tests**

Run: `node --test test/browser-balance-reader.test.js test/browser-bets-reader.test.js && npm test`

Expected: PASS.

**Step 6: Commit**

```bash
git add src/browser/readers/balance.js src/browser/readers/bets.js test/fixtures/browser-balance-dom.json test/fixtures/browser-bets-dom.json test/browser-balance-reader.test.js test/browser-bets-reader.test.js docs/k81128-upstream.md
git commit -m "feat: read wallets and game records from Chrome"
```

### Task 6: Build and wire the BrowserUpstreamAdapter

**Files:**
- Create: `src/upstream/browser.js`
- Modify: `src/server.js`
- Modify: `src/app.js`
- Test: `test/browser-upstream.test.js`
- Test: `test/server.test.js`
- Test: `test/app.test.js`

**Step 1: Write failing adapter and server tests**

Cover:

- all three methods run through one operation queue;
- readers receive only gateway results;
- browser unavailable, auth expired, timeout, and schema errors remain sanitized;
- `UPSTREAM_MODE=browser` wires the real adapter;
- test injection still supports fake upstreams;
- `/health` includes only `browser_status`, never account data;
- server shutdown closes the gateway.

**Step 2: Run focused tests and verify failure**

Run: `node --test test/browser-upstream.test.js test/server.test.js test/app.test.js`

Expected: FAIL because the browser adapter is not wired.

**Step 3: Implement the adapter and lifecycle**

Use reader-specific navigation/evaluation steps. Do not retry an operation after a partial page navigation in the same request. Connection recovery happens on the next API request.

**Step 4: Run focused and full tests**

Run: `node --test test/browser-upstream.test.js test/server.test.js test/app.test.js && npm test`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/upstream/browser.js src/server.js src/app.js test/browser-upstream.test.js test/server.test.js test/app.test.js
git commit -m "feat: wire Chrome browser upstream into API"
```

### Task 7: Add the dedicated Chrome launcher and launchd templates

**Files:**
- Create: `scripts/start-k8-chrome.mjs`
- Create: `deploy/com.nbmrjun.k8-chrome.plist`
- Modify: `deploy/com.nbmrjun.k8-api.plist`
- Modify: `package.json`
- Test: `test/chrome-launcher.test.js`

**Step 1: Write failing launcher tests**

Cover:

- Chrome path defaults to `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`;
- profile defaults to a dedicated project-external directory supplied through `K8_CHROME_PROFILE_DIR`;
- arguments bind CDP to `127.0.0.1:9223`;
- remote debugging port cannot be published on `0.0.0.0`;
- existing Chrome process detection does not reveal command-line secrets;
- the launcher never prints the profile path, account identifier, or environment values.

**Step 2: Implement launcher and plist templates**

The launcher opens `https://k81128.com/sports` and leaves login to the user. The Chrome launchd job uses `RunAtLoad`; the API job uses `KeepAlive` and starts after Chrome availability is independently checked by the adapter.

**Step 3: Validate**

Run: `node --test test/chrome-launcher.test.js && npm test`

Run: `plutil -lint deploy/com.nbmrjun.k8-chrome.plist deploy/com.nbmrjun.k8-api.plist`

Expected: tests PASS and both plist files are valid.

**Step 4: Commit**

```bash
git add scripts/start-k8-chrome.mjs deploy/com.nbmrjun.k8-chrome.plist deploy/com.nbmrjun.k8-api.plist package.json test/chrome-launcher.test.js
git commit -m "feat: add dedicated Chrome runtime templates"
```

### Task 8: Document local operations and verify with the user's logged-in Chrome

**Files:**
- Modify: `README.md`
- Create: `docs/operations.md`
- Modify: `.env.example`

**Step 1: Document the exact operating flow**

Include:

1. start dedicated Chrome;
2. user manually logs into k81128;
3. verify CDP is loopback-only;
4. start API with `.env.local`;
5. verify health, sports, balance, and bets locally;
6. renew an expired login without changing API credentials;
7. rotate the API Bearer Token;
8. stop Chrome/API and roll back launchd templates.

**Step 2: Run the complete verification suite**

Run: `npm test`

Run: `plutil -lint deploy/com.nbmrjun.k8-chrome.plist deploy/com.nbmrjun.k8-api.plist`

Expected: all tests PASS.

**Step 3: Run a local read-only integration check**

Start the dedicated Chrome and API without printing `.env.local`. Call:

```bash
curl -sS http://127.0.0.1:8788/health
curl -sS -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:8788/api/sports
curl -sS -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:8788/api/balance
curl -sS -H "Authorization: Bearer $API_TOKEN" "http://127.0.0.1:8788/api/bets?limit=25"
```

Do not include command output containing account identifiers in Git or logs. Validate only field shapes and status codes in the handoff report.

**Step 4: Scan for secret leakage**

Confirm `.env.local` and the dedicated Chrome profile are ignored/untracked. Search tracked files for the real API token without printing it. Inspect service logs for `Authorization`, Cookie, token, password, and account-name patterns.

**Step 5: Commit**

```bash
git add README.md docs/operations.md .env.example
git commit -m "docs: add browser bridge operations guide"
```

### Task 9: Publish through the existing Cloudflare Tunnel

**Files:**
- Modify outside repository only after explicit filesystem permission: `/Users/apple/.cloudflared/sporttery.yml`

**Step 1: Read and back up current tunnel configuration**

Confirm the active tunnel ID, current ingress ordering, and existing `odds.nbmrjun.top` behavior. Create a dated backup before editing.

**Step 2: Add ingress before catch-all**

```yaml
- hostname: k8.nbmrjun.top
  service: http://127.0.0.1:8788
```

Never expose `127.0.0.1:9223` through Cloudflare.

**Step 3: Validate and route DNS**

Run the installed `cloudflared` ingress validator. Create or verify the DNS route for `k8.nbmrjun.top`. Restart only the identified tunnel process.

**Step 4: Verify old and new hostnames**

Confirm the existing hostname still behaves as before. Verify public `/health`, unauthorized `401`, and authorized read-only endpoints without printing the token or account data.

**Step 5: Record operations result**

Update `docs/operations.md` with the service name, rollback command, and non-secret validation results. Commit only repository documentation; do not commit the user's Cloudflare configuration.

### Task 10: Final security and behavior review

**Files:**
- Modify only files required by review findings.

**Step 1: Run fresh verification**

Run: `npm test`

Run: `git diff --check main...HEAD`

Run: `git status --short`

Expected: all tests PASS, no whitespace errors, and only intentional files are changed.

**Step 2: Audit the write boundary**

Search production code for click, input, form submission, storage access, Cookie access, and non-GET business operations. The only allowed browser navigation is to verified read-only pages. Confirm no betting, deposit, withdrawal, or transfer action exists.

**Step 3: Audit network exposure**

Confirm API and CDP defaults are `127.0.0.1`; only API port 8788 is referenced by Tunnel; CDP port 9223 never appears in a public ingress rule.

**Step 4: Prepare merge handoff**

Summarize implemented endpoints, test count, local integration result, tunnel status, known limitation that `/api/bets` currently represents the verified electronic-game record table, and the separate safety design required before any future wagering feature.
