# k81128 Read-Only API Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build and publish a token-protected local API at `https://k8.nbmrjun.top` for sports odds, account balance, and bet history.

**Architecture:** A dependency-light Node.js service listens on `127.0.0.1:8788`, authenticates callers with a Bearer token, and delegates to a replaceable k81128 upstream adapter. The production adapter calls verified k81128 JSON endpoints; tests use a fake adapter. The existing Cloudflare Tunnel publishes the loopback service without exposing the port directly.

**Tech Stack:** Node.js 22+, built-in `http`, built-in `fetch`, built-in `node:test`, Cloudflare Tunnel, launchd.

---

### Task 1: Scaffold the service and configuration boundary

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `src/config.js`
- Test: `test/config.test.js`

**Step 1: Write the failing configuration tests**

Test that `loadConfig()` requires `API_TOKEN`, defaults to `127.0.0.1:8788`, rejects tokens shorter than 32 characters, and never includes secret values in its serialized diagnostic output.

**Step 2: Run the tests to verify they fail**

Run: `node --test test/config.test.js`

Expected: FAIL because `src/config.js` does not exist.

**Step 3: Implement the minimum configuration loader**

Use `process.env` only. Return `{ host, port, apiToken, upstreamBaseUrl, upstreamCredential, sportsCacheMs }`. Export a separate `publicConfig()` that contains only host, port, upstream origin, and cache duration.

**Step 4: Run the tests**

Run: `node --test test/config.test.js`

Expected: all configuration tests PASS.

**Step 5: Record the checkpoint**

If the directory has been initialized as a Git repository, commit with `feat: add secure service configuration`. Otherwise record completion in the task log without initializing Git implicitly.

### Task 2: Add Bearer authentication and response helpers

**Files:**
- Create: `src/auth.js`
- Create: `src/response.js`
- Test: `test/auth.test.js`
- Test: `test/response.test.js`

**Step 1: Write failing tests**

Cover missing header, wrong scheme, wrong token, correct token, constant-length-safe comparison behavior, JSON content type, request ID, and the stable error envelope:

```json
{"error":{"code":"UNAUTHORIZED","message":"Unauthorized","request_id":"..."}}
```

**Step 2: Run the focused tests**

Run: `node --test test/auth.test.js test/response.test.js`

Expected: FAIL because the modules do not exist.

**Step 3: Implement the helpers**

Use `crypto.timingSafeEqual()` after normalizing both values to fixed-length SHA-256 digests. Do not echo received credentials. Add helpers for success, unauthorized, method-not-allowed, bad-gateway, gateway-timeout, and internal-error responses.

**Step 4: Run the focused and full tests**

Run: `node --test test/auth.test.js test/response.test.js && node --test`

Expected: PASS.

### Task 3: Define stable public models and normalization

**Files:**
- Create: `src/normalize.js`
- Create: `test/fixtures/sports.json`
- Create: `test/fixtures/balance.json`
- Create: `test/fixtures/bets.json`
- Test: `test/normalize.test.js`

**Step 1: Create sanitized fixtures from verified upstream response shapes**

Remove account identifiers, tokens, request signatures, and unrelated fields. Keep only the minimum structure necessary to test mapping.

**Step 2: Write failing normalization tests**

Require stable output fields:

- Sports: `event_id`, `league`, `starts_at`, `home`, `away`, `markets`.
- Balance: `currency`, `available`, `locked`, `total`.
- Bets: `bet_id`, `placed_at`, `status`, `stake`, `currency`, `selection`, `odds`, `payout`.

Tests must fail on missing required upstream fields with `UPSTREAM_SCHEMA_CHANGED`.

**Step 3: Implement minimal normalizers**

Convert timestamps to ISO 8601 strings and numeric values to JSON numbers only when precision is safe; otherwise retain decimal strings.

**Step 4: Run tests**

Run: `node --test test/normalize.test.js && node --test`

Expected: PASS.

### Task 4: Implement the upstream adapter contract

**Files:**
- Create: `src/upstream/errors.js`
- Create: `src/upstream/client.js`
- Create: `src/upstream/fake.js`
- Test: `test/upstream-client.test.js`

**Step 1: Write failing adapter tests**

Cover `getSports()`, `getBalance()`, `getBets({ limit, cursor })`, request timeout, upstream `401/403`, non-JSON response, oversized response, and schema failure.

**Step 2: Run tests and verify failure**

Run: `node --test test/upstream-client.test.js`

Expected: FAIL because the adapter modules do not exist.

**Step 3: Implement the contract**

The client receives endpoints and credential formatting through configuration. Use an `AbortController` timeout, disable automatic credential logging, cap accepted response size, and map failures to `UPSTREAM_AUTH_EXPIRED`, `UPSTREAM_TIMEOUT`, `UPSTREAM_BAD_RESPONSE`, or `UPSTREAM_SCHEMA_CHANGED`.

**Step 4: Run tests**

Run: `node --test test/upstream-client.test.js && node --test`

Expected: PASS.

### Task 5: Discover and verify k81128 data endpoints

**Files:**
- Create: `docs/k81128-upstream.md`
- Modify: `.env.example`
- Modify: `test/fixtures/sports.json`
- Modify: `test/fixtures/balance.json`
- Modify: `test/fixtures/bets.json`

**Step 1: Inspect the logged-in page read-only**

Use Chrome developer-visible request information or downloaded public JavaScript bundles to identify the exact sports, balance, and bet-history endpoints. Do not inspect browser cookies, local storage, passwords, or session stores.

**Step 2: Document request contracts**

Record method, URL path, required non-secret headers, pagination parameters, expected status codes, and sanitized response fields. Do not include any credential value.

**Step 3: Determine the supported credential handoff**

If the upstream uses a bearer/session value, require the user to provide it through the local environment file. Do not extract it from Chrome storage. If no supported standalone credential can be supplied, mark balance and bets as browser-adapter work rather than pretending direct access works.

**Step 4: Verify with one focused request per endpoint**

Run the request from the local service context, redact headers, and save only sanitized fixture structures.

Expected: each endpoint returns a recognized JSON shape, or the limitation is explicitly documented.

### Task 6: Build the HTTP router and three endpoints

**Files:**
- Create: `src/app.js`
- Create: `src/server.js`
- Test: `test/app.test.js`

**Step 1: Write failing end-to-end HTTP tests**

Start the app on an ephemeral loopback port with the fake adapter. Cover:

- `GET /health` without authentication.
- `GET /api/sports`, `/api/balance`, and `/api/bets` with a valid token.
- `401` without a token.
- `405` for non-GET methods.
- `404` for unknown paths.
- Pagination validation for `/api/bets`.
- Upstream error-to-HTTP mappings.

**Step 2: Run tests and verify failure**

Run: `node --test test/app.test.js`

Expected: FAIL because the app does not exist.

**Step 3: Implement the minimum router**

Use exact path matching, a maximum bet-history limit of 100, five-second in-memory sports caching, no caching for balance or bets, and uniform `{ data, source, fetched_at, request_id }` success envelopes.

**Step 4: Run focused and full tests**

Run: `node --test test/app.test.js && node --test`

Expected: PASS.

### Task 7: Add operational files and secret-safe startup

**Files:**
- Create: `scripts/generate-token.mjs`
- Create: `scripts/smoke-test.mjs`
- Create: `deploy/com.nbmrjun.k8-api.plist`
- Create: `README.md`
- Test: `test/scripts.test.js`

**Step 1: Write failing script tests**

Verify token generation produces at least 32 random bytes, smoke tests require a token from the environment, and neither script prints the token.

**Step 2: Implement scripts and launchd template**

The service must run with the project directory as its working directory, restart after failure, bind only to `127.0.0.1:8788`, and write logs without secrets.

**Step 3: Create the real local environment file**

Generate a new API token directly into an ignored `.env`-compatible file without printing it. Add the user-supplied k81128 credential only after its format is known.

**Step 4: Run all tests and start locally**

Run: `node --test`

Run: `node src/server.js`

Run: `curl -sS http://127.0.0.1:8788/health`

Expected: tests PASS and health returns `200`.

### Task 8: Extend the existing Cloudflare Tunnel

**Files:**
- Modify: `/Users/apple/.cloudflared/sporttery.yml`

**Step 1: Back up and validate the current configuration**

Read the existing ingress order and confirm `odds.nbmrjun.top` remains unchanged. Create a dated backup before editing because this file is outside the project and affects an existing service.

**Step 2: Add the ingress rule before the catch-all**

```yaml
- hostname: k8.nbmrjun.top
  service: http://localhost:8788
```

**Step 3: Validate configuration**

Run: `cloudflared tunnel ingress validate --config /Users/apple/.cloudflared/sporttery.yml`

Expected: valid ingress configuration.

**Step 4: Create or verify the DNS route**

Run: `cloudflared tunnel route dns eca993cd-6444-427f-9eaa-dfe4c928a57b k8.nbmrjun.top`

Expected: DNS route created or already present. If Cloudflare account authorization is missing, stop and request the minimum additional login/token action rather than changing DNS through an unrelated credential.

**Step 5: Restart the tunnel safely**

Identify the existing launchd or service invocation first. Restart only that tunnel instance and verify `odds.nbmrjun.top` still responds before testing the new hostname.

### Task 9: End-to-end verification and handoff

**Files:**
- Modify: `README.md`
- Create: `docs/operations.md`

**Step 1: Run the full local suite**

Run: `node --test`

Expected: all tests PASS with zero skipped tests unless an upstream integration test is explicitly opt-in.

**Step 2: Verify local authentication**

Run an unauthorized request and a request using the local environment token without printing the token.

Expected: unauthorized request returns `401`; authorized `/api/sports`, `/api/balance`, and `/api/bets` return their expected status and envelope.

**Step 3: Verify the public hostname**

Run the same checks against `https://k8.nbmrjun.top` from outside the tunnel origin.

Expected: HTTPS is valid, unauthorized access returns `401`, and authorized access reaches the local service.

**Step 4: Verify existing tunnel traffic**

Check `https://odds.nbmrjun.top` still behaves as before.

**Step 5: Scan for leaked secrets**

Run focused searches for real token values without printing matches, confirm `.env` is ignored, and inspect logs for authorization headers.

Expected: no credentials appear in tracked files, test output, or logs.

**Step 6: Complete operations documentation**

Document startup, shutdown, token rotation, k81128 session renewal, tunnel validation, expected errors, and rollback steps.
