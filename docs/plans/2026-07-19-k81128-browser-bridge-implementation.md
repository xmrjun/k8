# k81128 / IM Sports Browser Bridge Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Expose complete read-only IM Sports live, today, and early odds through the existing token-protected Node.js API while keeping k81128 account reads separate and never extracting browser credentials.

**Architecture:** A dependency-free CDP gateway connects only to a dedicated Chrome on `127.0.0.1`, with exact-origin gateways for the k81128 account page and the IM Sports venue page. Both gateways share one bounded operation queue. DOM expressions return bounded, plain sports fields; Node validates and normalizes them before query-keyed caching and HTTP serialization.

**Tech Stack:** Node.js 22 built-ins (`http`, `fetch`, `WebSocket`, `node:test`), Chrome DevTools Protocol, launchd, Cloudflare Tunnel.

**Security rule:** Never read, persist, log, or return Cookie, Local Storage, Session Storage, passwords, request signatures, CDP URLs, or the venue page URL/query token. Configuration contains origins only.

---

### Task 1: Add browser configuration and stable browser errors — completed

Committed as `db6b62c`. It added loopback CDP configuration, the k81128 account-page origin, operation timeout configuration, and stable `BROWSER_UNAVAILABLE` handling.

### Task 2: Build a serial browser-operation queue — completed

Committed as `3572fbe`. It added strict serialization, bounded pending work, timeout abort signals, and sanitized timeout failures.

### Task 3: Implement a dependency-free loopback CDP gateway — completed

Committed as `b32536a`. It added exact-origin target discovery, bounded evaluation responses, sanitized failures, and reconnect-on-next-request behavior.

### Task 4: Add the independent IM Sports origin

**Files:**
- Modify: `.env.example`
- Modify: `src/config.js`
- Modify: `src/browser/gateway.js`
- Test: `test/config.test.js`
- Test: `test/browser-gateway.test.js`

**Step 1: Write failing configuration tests**

Require `BROWSER_SPORTS_ORIGIN` to default to the exact IM Sports HTTPS origin, reject credentials, paths, query strings, and fragments, and expose only the sanitized origin from `publicConfig()`.

**Step 2: Run the tests to verify RED**

Run: `node --test test/config.test.js test/browser-gateway.test.js`

Expected: FAIL because `browserSportsOrigin` does not exist and origin-only validation is not yet enforced.

**Step 3: Implement the minimum origin-only configuration**

Add a reusable HTTPS-origin parser. Keep `browserPageOrigin` for k81128 account reads and add `browserSportsOrigin` for sports reads. Gateway discovery may inspect a target URL only to compare its `origin`; it must never return or log the full target URL.

**Step 4: Run focused and full tests**

Run: `node --test test/config.test.js test/browser-gateway.test.js && npm test`

Expected: PASS.

**Step 5: Commit**

```bash
git add .env.example src/config.js src/browser/gateway.js test/config.test.js test/browser-gateway.test.js
git commit -m "feat: configure independent sports browser origin"
```

### Task 5: Normalize IM Sports event and market models

**Files:**
- Create: `src/browser/readers/sports.js`
- Create: `test/fixtures/im-sports-raw.json`
- Create: `test/browser-sports-reader.test.js`

**Step 1: Add a sanitized synthetic raw fixture**

The fixture contains no real account, URL token, Cookie, browser storage, or full production snapshot. Include live football, today basketball, and early tennis examples with 1X2, handicap, total, locked, and missing odds.

**Step 2: Write failing model tests**

Test the exported `normalizeSportsPayload(raw, options)` contract:

```js
{
  events: [{
    event_id: '111486996',
    sport: 'football',
    scope: 'live',
    league: 'Example League',
    home: 'Home',
    away: 'Away',
    score: { home: 0, away: 0 },
    clock: '2H 77:24',
    markets: [{
      period: 'full_time',
      type: '1x2',
      selections: [{
        selection_key: '111486996:full_time:1x2:home',
        name: 'home',
        display_odds: '6.43',
        odds_format: 'hong_kong',
        decimal_odds: '7.43',
        available: true,
      }],
    }],
  }],
  count: 1,
  truncated: false,
}
```

Cover scope and sport filters, exact decimal-string `+ 1`, stable selection keys, locked selections without decimal odds, missing odds, duplicate event merging, required-field failures, unknown scope/sport failures, and the 500-event limit.

**Step 3: Run the tests to verify RED**

Run: `node --test test/browser-sports-reader.test.js`

Expected: FAIL because the reader module does not exist.

**Step 4: Implement the minimum validator and normalizer**

Use strict allow-lists for scopes and normalized sports keys. Parse event IDs from validated numeric strings. Implement decimal-string addition without `Number` arithmetic. Remove empty markets but preserve locked selections. Throw `UPSTREAM_SCHEMA_CHANGED` for malformed page payloads.

**Step 5: Run focused and full tests**

Run: `node --test test/browser-sports-reader.test.js && npm test`

Expected: PASS.

**Step 6: Commit**

```bash
git add src/browser/readers/sports.js test/fixtures/im-sports-raw.json test/browser-sports-reader.test.js
git commit -m "feat: normalize IM Sports odds models"
```

### Task 6: Build the bounded IM Sports DOM expression

**Files:**
- Modify: `src/browser/readers/sports.js`
- Modify: `test/browser-sports-reader.test.js`
- Create: `docs/im-sports-upstream.md`

**Step 1: Write failing expression safety and selector tests**

Test `buildSportsExpression({ maxEvents: 500 })` for the verified selectors (`.eventlisting_wrap`, `.competition_header_team`, `.event_row`, `a[href^="/sev/"]`, `.teamname_title`, `.score`, `.datetime`, `.event_even.double`, `.handi`, `.ou`, `.odds`, `.lock`). Assert it has a hard event bound and does not contain `cookie`, `localStorage`, `sessionStorage`, `indexedDB`, URL query parsing, `fetch`, or network interception.

**Step 2: Run the tests to verify RED**

Run: `node --test test/browser-sports-reader.test.js`

Expected: FAIL because the expression builder does not exist.

**Step 3: Implement the minimum expression**

Walk each sports section and competition in document order. Read the primary team-bearing event row, extract only the numeric event ID from `/sev/.../<id>`, and map verified full-time 1X2, handicap, and total cells to the raw fixture shape. Return explicit page markers so Node can distinguish valid empty data from login/redirect/schema failure.

**Step 4: Document only sanitized upstream structure**

Record origin-only matching, selectors, supported markets, limits, authentication/schema markers, and the prohibition on storing real snapshots or venue URLs.

**Step 5: Run focused and full tests**

Run: `node --test test/browser-sports-reader.test.js && npm test`

Expected: PASS.

**Step 6: Commit**

```bash
git add src/browser/readers/sports.js test/browser-sports-reader.test.js docs/im-sports-upstream.md
git commit -m "feat: read bounded IM Sports DOM data"
```

### Task 7: Wire BrowserUpstreamAdapter with two gateways and one queue

**Files:**
- Create: `src/upstream/browser.js`
- Modify: `src/server.js`
- Test: `test/browser-upstream.test.js`
- Test: `test/server.test.js`

**Step 1: Write failing adapter tests**

Cover sports calls through the sports gateway, account calls through the account gateway, strict serialization across both gateways, operation timeout, sanitized browser/auth/schema errors, gateway close lifecycle, and no automatic fallback to k81128 homepage sports.

**Step 2: Run the tests to verify RED**

Run: `node --test test/browser-upstream.test.js test/server.test.js`

Expected: FAIL because the browser adapter is not wired.

**Step 3: Implement the minimum adapter and server wiring**

Instantiate exact-origin gateways that share one `createBrowserOperationQueue()`. `getSports(options)` evaluates the sports expression and normalizes it. Browser mode becomes the production upstream; test injection and existing HTTP mode remain supported.

**Step 4: Run focused and full tests**

Run: `node --test test/browser-upstream.test.js test/server.test.js && npm test`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/upstream/browser.js src/server.js test/browser-upstream.test.js test/server.test.js
git commit -m "feat: wire dual-page browser upstream"
```

### Task 8: Add `/api/sports` query, cache, and response metadata

**Files:**
- Modify: `src/app.js`
- Modify: `src/response.js`
- Modify: `src/upstream/fake.js`
- Test: `test/app.test.js`
- Test: `test/response.test.js`

**Step 1: Write failing HTTP tests**

Cover default `scope=all`, each allowed scope, optional normalized `sport`, repeated/unknown/empty parameters, unknown query keys, options passed to `upstream.getSports`, cache keys by scope and sport, TTLs of 1s/3s/10s, no stale fallback, and the response fields `events`, `count`, `truncated`, `source`, `fetched_at`, and `request_id`.

**Step 2: Run the tests to verify RED**

Run: `node --test test/app.test.js test/response.test.js`

Expected: FAIL because sports query parsing and per-scope caching do not exist.

**Step 3: Implement the minimum HTTP contract**

Use a bounded `Map` keyed by canonical `scope + sport`, with `all` sharing the 1-second live TTL. Never serve expired entries after an upstream failure. Preserve current stable browser error mappings.

**Step 4: Run focused and full tests**

Run: `node --test test/app.test.js test/response.test.js && npm test`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/app.js src/response.js src/upstream/fake.js test/app.test.js test/response.test.js
git commit -m "feat: expose filtered IM Sports odds API"
```

### Task 9: Add k81128 balance and game-record readers

**Files:**
- Create: `src/browser/readers/balance.js`
- Create: `src/browser/readers/bets.js`
- Create: `test/fixtures/browser-balance-dom.json`
- Create: `test/fixtures/browser-bets-dom.json`
- Create: `test/browser-balance-reader.test.js`
- Create: `test/browser-bets-reader.test.js`
- Modify: `src/upstream/browser.js`
- Create: `docs/k81128-upstream.md`

**Steps:** Follow TDD for the verified account selectors, truthful empty-record state, bounded row counts, and sanitized auth/schema failures. These readers use only the k81128 account gateway and must never affect `/api/sports` availability or data.

Run: `node --test test/browser-balance-reader.test.js test/browser-bets-reader.test.js test/browser-upstream.test.js && npm test`

Commit: `feat: read k81128 account data from Chrome`

### Task 10: Add dedicated Chrome and local service templates

**Files:**
- Create: `scripts/start-k8-chrome.mjs`
- Create: `deploy/com.nbmrjun.k8-chrome.plist`
- Modify: `deploy/com.nbmrjun.k8-api.plist`
- Modify: `.gitignore`
- Modify: `package.json`
- Create: `test/chrome-launcher.test.js`

**Steps:** TDD the dedicated external profile requirement, loopback-only CDP flags, two origin-only starting pages, and rejection of any configured sports URL containing path/query/fragment. Templates contain placeholders only and are not installed by tests.

Run: `node --test test/chrome-launcher.test.js test/scripts.test.js && npm test`

Commit: `feat: add dedicated Chrome service templates`

### Task 11: Document operations and perform read-only local verification

**Files:**
- Create: `docs/browser-bridge-runbook.md`
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `scripts/smoke-test.sh`
- Modify: `test/scripts.test.js`

**Steps:** Document manual login, keeping both tabs open, start/stop/recovery, session-expiry symptoms, domain/tunnel setup, secret rotation, and rollback. Run sanitized unit tests first. With the user-managed Chrome session available, integration verification may check only HTTP status, shape, source, and event count; it must not save a real response body or page URL.

Run: `npm test && npm run check && git diff --check`

Commit: `docs: add secure browser bridge runbook`

### Task 12: Configure the existing Cloudflare Tunnel — explicit deployment step

Before changing persistent Mac or Cloudflare state, inspect the existing tunnel configuration, back it up, validate the candidate config, and obtain any permission required by the environment. Add only the hostname route to `http://127.0.0.1:8788`; never expose the CDP port. Verify local and remote unauthorized requests return `401`, then verify an authorized `/api/sports?scope=live` request from the user's server without printing the token or response body.

This task is complete only after rollback is documented and existing tunnel hostnames remain healthy.
