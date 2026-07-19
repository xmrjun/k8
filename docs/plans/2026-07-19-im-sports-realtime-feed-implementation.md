# IM Sports Realtime Feed Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Convert the dedicated Chrome session's verified IM Sports `sel` snapshots and `dc` Fetch deltas into an authenticated downstream WebSocket feed at `/ws/sports` while moving production browser reads to loopback CDP.

**Architecture:** A bounded CDP event client observes only same-origin JSON Fetch responses, classifies messages by verified body structure rather than secret URL paths, and passes them to a pure protocol adapter and feed state machine. A `ws` `WebSocketServer` in `noServer` mode shares the existing HTTP server, sends a current snapshot followed by ordered deltas, and closes clients when the source is stale or requires resynchronization.

**Tech Stack:** Node.js 22 CommonJS, Chrome DevTools Protocol 1.3 Network domain, `ws` 8.21.1, `node:test`, Cloudflare Tunnel.

Official references:

- Chrome Network domain: <https://chromedevtools.github.io/devtools-protocol/1-3/Network/>
- `ws` no-server and upgrade API: <https://github.com/websockets/ws/blob/master/doc/ws.md>

---

### Task 1: Pin the WebSocket dependency and realtime configuration

**Files:**

- Modify: `package.json`
- Create: `package-lock.json`
- Modify: `.env.example`
- Modify: `src/config.js`
- Modify: `test/config.test.js`
- Modify: `test/server.test.js`

**Step 1: Write failing configuration tests**

Add tests proving:

```js
test('loadConfig requires an independent WS_TOKEN', () => {
  withEnv({ API_TOKEN: 'a'.repeat(32) }, () => {
    assert.throws(() => loadConfig(), /WS_TOKEN is required/);
  });
});

test('loadConfig rejects a reused API token', () => {
  withEnv({ API_TOKEN: 'a'.repeat(32), WS_TOKEN: 'a'.repeat(32) }, () => {
    assert.throws(() => loadConfig(), /WS_TOKEN must differ from API_TOKEN/);
  });
});
```

Update existing expected config objects so the default browser transport is
`cdp`, `wsToken` exists only in private config, and `publicConfig()` cannot
serialize either token.

**Step 2: Run tests and verify failure**

Run: `node --test test/config.test.js test/server.test.js`

Expected: FAIL because `WS_TOKEN` is not validated and the browser transport
still defaults to Apple Events.

**Step 3: Install and pin `ws`**

Run: `npm install --save-exact ws@8.21.1`

Expected: `package.json` contains `"ws": "8.21.1"` and npm creates a lockfile.
Do not install optional native addons.

**Step 4: Implement minimal configuration**

In `loadConfig()`:

```js
const wsToken = process.env.WS_TOKEN;
if (!wsToken) throw new Error('WS_TOKEN is required');
if (wsToken.length < 32) throw new Error('WS_TOKEN must be at least 32 characters');
if (wsToken === apiToken) throw new Error('WS_TOKEN must differ from API_TOKEN');
```

Return `wsToken` privately, default `BROWSER_TRANSPORT` to `cdp`, and keep the
existing explicit `apple_events` option only as a manual rollback mechanism.
Add a blank `WS_TOKEN=` to `.env.example`; never commit a usable token.

**Step 5: Run tests**

Run: `node --test test/config.test.js test/server.test.js`

Expected: PASS.

**Step 6: Commit**

```bash
git add package.json package-lock.json .env.example src/config.js test/config.test.js test/server.test.js
git commit -m "feat: configure realtime sports feed"
```

---

### Task 2: Add bounded CDP event subscriptions

**Files:**

- Modify: `src/browser/cdp-client.js`
- Modify: `test/cdp-client.test.js`

**Step 1: Write failing event tests**

Cover these cases:

```js
const events = [];
const unsubscribe = client.subscribe('Network.loadingFinished', (params) => {
  events.push(params.requestId);
});
socket.message({ method: 'Network.loadingFinished', params: { requestId: 'r1' } });
assert.deepEqual(events, ['r1']);
unsubscribe();
socket.message({ method: 'Network.loadingFinished', params: { requestId: 'r2' } });
assert.deepEqual(events, ['r1']);
```

Also prove that an event cannot resolve a pending command, listener exceptions
are isolated, disconnect listeners run once, and `close()` removes listeners.

**Step 2: Run tests and verify failure**

Run: `node --test test/cdp-client.test.js`

Expected: FAIL because `subscribe` and `onDisconnect` do not exist.

**Step 3: Implement minimal subscription support**

Maintain `Map<method, Set<listener>>`. After bounded JSON parsing, dispatch
frames with a string `method` and no integer `id`. Expose:

```js
subscribe(method, listener) // returns idempotent unsubscribe function
onDisconnect(listener)      // returns idempotent unsubscribe function
```

Never include event parameters or listener exceptions in errors or logs.

**Step 4: Run tests**

Run: `node --test test/cdp-client.test.js`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/browser/cdp-client.js test/cdp-client.test.js
git commit -m "feat: subscribe to bounded CDP events"
```

---

### Task 3: Share secure CDP target discovery

**Files:**

- Create: `src/browser/target-discovery.js`
- Create: `test/browser-target-discovery.test.js`
- Modify: `src/browser/gateway.js`
- Modify: `test/browser-gateway.test.js`

**Step 1: Write discovery tests**

Move the existing security cases into direct tests for:

```js
createTargetDiscovery({ cdpUrl, pageOrigin, fetchImpl, maxDiscoveryBytes })
```

Test exact HTTPS origin matching, loopback-only CDP, same debugger host/port,
bounded discovery response, malformed JSON, remote debugger rejection, and
sanitized errors that retain no target URL.

**Step 2: Run tests and verify failure**

Run: `node --test test/browser-target-discovery.test.js test/browser-gateway.test.js`

Expected: FAIL because the shared module does not exist.

**Step 3: Extract discovery without behavior changes**

Return an object exposing `discover({ signal } = {})`. The returned target may
contain the debugger URL in memory, but no diagnostic or thrown message may
contain it. Refactor `createBrowserGateway()` to use this module.

**Step 4: Run tests**

Run: `node --test test/browser-target-discovery.test.js test/browser-gateway.test.js`

Expected: PASS, including all old gateway cases.

**Step 5: Commit**

```bash
git add src/browser/target-discovery.js src/browser/gateway.js test/browser-target-discovery.test.js test/browser-gateway.test.js
git commit -m "refactor: share secure CDP target discovery"
```

---

### Task 4: Decode and normalize verified IM snapshots

**Files:**

- Create: `src/realtime/im-protocol.js`
- Create: `test/im-protocol.test.js`
- Create: `test/fixtures/im-live-snapshot.json`

**Step 1: Create a hand-sanitized fixture**

Build a small invented fixture matching the verified shape:

```json
{
  "StatusCode": 100,
  "sel": [{
    "eid": 900000001,
    "m": 3,
    "cid": 7001,
    "cn": "Example League",
    "htn": "Example Home",
    "atn": "Example Away",
    "iop": true,
    "hs": 1,
    "as": 0,
    "rbt": "2H 67:21",
    "mls": [
      {"mi": 8101,"bti":1,"gp":1,"ml":1,"il":false,"ws":[
        {"wsi":9101,"si":1,"dih":"-0/0.5","o":0.95,"ot":2},
        {"wsi":9102,"si":2,"dih":"+0/0.5","o":0.87,"ot":2}
      ]},
      {"mi":8102,"bti":3,"gp":1,"ml":1,"il":false,"ws":[
        {"wsi":9201,"si":5,"o":2.3,"ot":3},
        {"wsi":9202,"si":6,"o":3.1,"ot":3},
        {"wsi":9203,"si":7,"o":2.8,"ot":3}
      ]}
    ]
  }]
}
```

No value may be copied directly from the live account session.

**Step 2: Write failing parser tests**

Test `decodeImResponse()` classification and `normalizeSnapshot()` output:

- `m=3` maps to `football`;
- `bti=1/2/3` maps to `handicap/total/1x2`;
- `gp=1/2` maps to `full_time/first_half`;
- `si=1/2/3/4/5/6/7` maps to home/away/over/under/home/draw/away in the
  applicable market;
- odds type 2 adds one exactly; odds type 3 is already decimal;
- `dih` is preserved as the signed line;
- `il=true` or an empty selection list is unavailable;
- stable market and selection keys include upstream market and selection IDs;
- malformed, oversized, unknown sport, unknown market, duplicate ID, and more
  than 500 events fail with `SCHEMA_CHANGED` and no raw cause.

**Step 3: Run tests and verify failure**

Run: `node --test test/im-protocol.test.js`

Expected: FAIL because the protocol adapter does not exist.

**Step 4: Implement the pure snapshot adapter**

Export:

```js
decodeImResponse(value) // { type: 'snapshot'|'delta', value }
normalizeSnapshot(value) // { events, count, truncated: false, upstream }
```

Keep the internal `upstream` maps non-serializable outside the feed state. Use
string arithmetic for decimal conversion; do not rely on floating-point
addition for public odds.

**Step 5: Run tests**

Run: `node --test test/im-protocol.test.js`

Expected: PASS.

**Step 6: Commit**

```bash
git add src/realtime/im-protocol.js test/im-protocol.test.js test/fixtures/im-live-snapshot.json
git commit -m "feat: normalize IM live snapshots"
```

---

### Task 5: Apply IM deltas and produce downstream messages

**Files:**

- Create: `src/realtime/feed-state.js`
- Create: `test/feed-state.test.js`
- Create: `test/fixtures/im-live-deltas.json`

**Step 1: Add sanitized delta fixtures**

Invent fixtures for the verified shapes:

```json
[
  {"StatusCode":100,"dc":[{"a":3,"eid":900000001,"sid":0,"v":[]}]},
  {"StatusCode":100,"dc":[{"a":5,"eid":900000001,"sid":0,"v":{"hs":1,"as":1,"hrc":0,"arc":0}}]},
  {"StatusCode":100,"dc":[{"a":6,"eid":900000001,"sid":0,"v":"2H 68:02"}]},
  {"StatusCode":100,"dc":[{"a":11,"eid":900000001,"sid":0,"v":[{"st":3,"gp":1,"hs":1,"as":1}]}]}
]
```

The market arrays in action 3 and 4 use invented IDs and odds only.

**Step 2: Write failing state tests**

Test this public interface:

```js
const feed = createFeedState({ now, staleMs: 15000 });
feed.ingest(snapshot);
assert.deepEqual(feed.snapshot().type, 'snapshot');
const messages = feed.ingest(delta);
```

Cover full/partial market replacement (`a=3/4`), score (`a=5`), clock (`a=6`),
period scores (`a=11`), changed-only output, `available:false` removals, monotonic
`seq`, no-change batches, stale detection, and immutable snapshots. Unsupported
actions or invalid shapes must return `needsResync: true` without mutating the
last valid state.

**Step 3: Run tests and verify failure**

Run: `node --test test/feed-state.test.js`

Expected: FAIL because `createFeedState` does not exist.

**Step 4: Implement the state machine**

Maintain maps keyed by `event_id`, upstream market ID, and upstream selection
ID. Re-normalize only affected events, compare selections by `selection_key`,
and emit exactly the agreed `delta` and `score` fields. `snapshot()` returns:

```js
{ type: 'snapshot', events: [...], seq }
```

**Step 5: Run tests**

Run: `node --test test/im-protocol.test.js test/feed-state.test.js`

Expected: PASS.

**Step 6: Commit**

```bash
git add src/realtime/feed-state.js test/feed-state.test.js test/fixtures/im-live-deltas.json
git commit -m "feat: build realtime sports feed state"
```

---

### Task 6: Monitor same-origin Fetch responses through CDP

**Files:**

- Create: `src/realtime/im-network-monitor.js`
- Create: `test/im-network-monitor.test.js`

**Step 1: Write a fake-CDP monitor harness**

Inject target discovery, CDP client factory, clock, timers, and callbacks. Emit
fake `Network.requestWillBeSent`, `responseReceived`, and `loadingFinished`
events. Assert that the monitor calls:

```js
client.call('Network.enable', {
  maxTotalBufferSize: 10_000_000,
  maxResourceBufferSize: 2_000_000,
  maxPostDataSize: 0,
});
```

**Step 2: Add failing security and lifecycle tests**

Cover exact origin, method `POST`, type `Fetch`, status 200, JSON MIME type,
encoded data length at most 2 MB, body classification by `sel`/`dc`, request-map
bounds, request cleanup, base64 rejection, duplicate completion, CDP disconnect,
backoff, and one resync reload. Prove that errors and diagnostics do not contain
request URLs, response bodies, headers, or debugger URLs.

**Step 3: Run tests and verify failure**

Run: `node --test test/im-network-monitor.test.js`

Expected: FAIL because the monitor does not exist.

**Step 4: Implement the monitor**

Use the shared discovery module, `createCdpClient()`, and subscriptions. Store
only request ID plus eligibility booleans; do not retain the full URL after the
origin check. On `loadingFinished`, call `Network.getResponseBody`, enforce the
decoded byte limit, parse JSON, classify by body structure, and pass it to
`onResponse`.

On unsupported feed state, call `Page.reload` at most once per 15 seconds. On
disconnect, clear all request state and reconnect with bounded exponential
backoff capped at 10 seconds.

**Step 5: Run tests**

Run: `node --test test/im-network-monitor.test.js test/cdp-client.test.js test/browser-target-discovery.test.js`

Expected: PASS.

**Step 6: Commit**

```bash
git add src/realtime/im-network-monitor.js test/im-network-monitor.test.js
git commit -m "feat: monitor IM Fetch responses through CDP"
```

---

### Task 7: Serve the authenticated downstream WebSocket

**Files:**

- Create: `src/realtime/ws-feed-server.js`
- Create: `test/ws-feed-server.test.js`
- Modify: `src/auth.js`
- Modify: `test/auth.test.js`

**Step 1: Expose constant-time raw-token comparison**

Write a failing `isTokenEqual(received, expected)` test, refactor bearer auth to
use it, and preserve every existing authorization test.

**Step 2: Write failing WebSocket integration tests**

Using `ws` as the test client, start an ephemeral HTTP server and test:

- only `/ws/sports` upgrades;
- missing, duplicate, empty, or wrong `token` receives 401;
- valid token with no current snapshot receives 503;
- valid token receives snapshot first;
- later feed messages preserve order;
- application `ping` arrives every 30 seconds with a new sequence;
- standard ping/pong detects dead peers;
- `bufferedAmount` above 1 MB closes the slow client;
- stale source closes with code 1012;
- query strings and tokens never enter diagnostics.

**Step 3: Run tests and verify failure**

Run: `node --test test/auth.test.js test/ws-feed-server.test.js`

Expected: FAIL because the raw-token helper and feed server do not exist.

**Step 4: Implement the no-server WebSocket service**

Create `WebSocketServer` with:

```js
new WebSocketServer({
  noServer: true,
  clientTracking: true,
  perMessageDeflate: false,
  maxPayload: 1024,
});
```

Authenticate in the HTTP server's `upgrade` event before `handleUpgrade()`.
Write HTTP 401/404/503 directly to the socket and destroy it. Never accept or
log client application messages.

**Step 5: Run tests**

Run: `node --test test/auth.test.js test/ws-feed-server.test.js`

Expected: PASS.

**Step 6: Commit**

```bash
git add src/auth.js src/realtime/ws-feed-server.js test/auth.test.js test/ws-feed-server.test.js
git commit -m "feat: serve authenticated sports WebSocket"
```

---

### Task 8: Wire the monitor, feed, HTTP server, and shutdown lifecycle

**Files:**

- Modify: `src/server.js`
- Modify: `test/server.test.js`
- Modify: `src/upstream/browser.js`
- Modify: `test/browser-upstream.test.js`

**Step 1: Write failing composition tests**

Inject monitor, feed, and WebSocket factories into `createHttpServer()`. Prove:

- CDP transport creates and starts one IM monitor;
- Apple Events rollback mode cannot start realtime and returns 503 on upgrade;
- all HTTP browser gateways use the configured dedicated CDP URL in production;
- feed messages broadcast through the WebSocket service;
- server close stops monitor, closes clients, then closes browser upstream once;
- monitor startup failure does not crash `/health` but leaves feed unavailable.

**Step 2: Run tests and verify failure**

Run: `node --test test/server.test.js test/browser-upstream.test.js`

Expected: FAIL because realtime components are not composed.

**Step 3: Implement lifecycle wiring**

Construct the feed and monitor only for `upstreamMode === 'browser'` and
`browserTransport === 'cdp'`. Attach the feed server to the same HTTP server.
Start monitor connection attempts without delaying the HTTP listen callback.
Make shutdown idempotent and await all component closes.

**Step 4: Run focused and full tests**

Run: `node --test test/server.test.js test/browser-upstream.test.js test/ws-feed-server.test.js`

Expected: PASS.

Run: `npm test`

Expected: all tests pass.

**Step 5: Commit**

```bash
git add src/server.js src/upstream/browser.js test/server.test.js test/browser-upstream.test.js
git commit -m "feat: wire realtime feed lifecycle"
```

---

### Task 9: Add safe operations, smoke testing, and dedicated-Chrome startup

**Files:**

- Create: `scripts/ws-smoke-test.mjs`
- Modify: `test/scripts.test.js`
- Modify: `package.json`
- Modify: `docs/operations.md`
- Modify: `.env.example`
- Runtime-only: `.env.local`
- Runtime-only: `/Users/apple/Desktop/启动 K8 API.command`
- Runtime-only: `/Users/apple/Desktop/启动 K8 专用 Chrome.command`

**Step 1: Write failing script/documentation tests**

Test that the WebSocket smoke script refuses to run without `WS_TOKEN`, connects
to a supplied URL, accepts only snapshot/delta/score/ping message types, checks
monotonic `seq`, and prints only status plus aggregate counts. Update operations
documentation tests to require the dedicated CDP data path and explicitly ban
publishing 9223.

**Step 2: Run tests and verify failure**

Run: `node --test test/scripts.test.js`

Expected: FAIL because the script and updated operations text do not exist.

**Step 3: Implement the safe smoke test and docs**

Add `npm run smoke:ws`. The script reads `WS_TOKEN` from the process environment,
constructs the URL in memory, never prints it, closes after a bounded timeout,
and prints only message-type counts and sequence validity.

Update operations to show:

```text
Cloudflare -> 127.0.0.1:8788 -> CDP 127.0.0.1:9223 -> dedicated Chrome
```

Document that the tunnel configuration is unchanged.

**Step 4: Run tests and checks**

Run: `node --test test/scripts.test.js && npm run check && npm test`

Expected: all pass.

**Step 5: Commit repository changes**

```bash
git add scripts/ws-smoke-test.mjs test/scripts.test.js package.json docs/operations.md .env.example
git commit -m "docs: operate dedicated Chrome realtime feed"
```

**Step 6: Update runtime secrets without printing them**

Generate at least 32 random bytes as base64url in a process that writes directly
to `.env.local`. Do not echo the token, include it in shell history, or reuse the
HTTP token. Set `BROWSER_TRANSPORT=cdp` and keep `BROWSER_CDP_URL` on loopback.

**Step 7: Update desktop shortcuts**

Keep the dedicated Chrome shortcut's existing persistent profile and loopback
CDP flags. Update the API shortcut to wait for `http://127.0.0.1:9223/json/version`
before `npm start`; it must fail visibly rather than fall back to ordinary
Chrome. Do not place secrets in either desktop file.

---

### Task 10: Verify locally and through Cloudflare without exposing secrets

**Files:**

- No committed files unless verification reveals a defect

**Step 1: Verify the browser boundary**

Confirm only `127.0.0.1:9223` is listening and target discovery finds the IM
Sports page. Print browser version, target count, and sanitized titles only.

**Step 2: Restart the API using the desktop-compatible command**

Confirm `127.0.0.1:8788` listens and `/health` returns 200. Do not print either
token or `.env.local`.

**Step 3: Verify HTTP regression paths**

Check local and public HTTP status plus sanitized shape/count fields for sports,
account, balance, and bets. Confirm unauthenticated protected routes return 401.

**Step 4: Verify local WebSocket**

Run: `npm run smoke:ws -- --url ws://127.0.0.1:8788/ws/sports`

Expected: snapshot first, at least one ping or change within the bounded window,
monotonic sequence, no raw event body printed.

**Step 5: Verify public WebSocket**

Run the same smoke test with the public `wss` base URL supplied through an
environment variable. Expected: Cloudflare upgrades successfully and the same
message invariants hold. An invalid token must fail authentication.

**Step 6: Final verification**

Run: `git status --short && npm run check && npm test`

Expected: clean worktree and all tests passing.

