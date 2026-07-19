# IM Sports Realtime Feed Design

Date: 2026-07-19

## Goal

Expose the logged-in IM Sports live feed through the existing K8 service as a
token-protected WebSocket endpoint:

```text
wss://k8.nbmrjun.top/ws/sports?token=<WS_TOKEN>
```

The first release is strictly read-only. It publishes live events, odds,
availability, scores, and clocks. It does not submit or prepare bets.

## Verified upstream behavior

Read-only CDP discovery against the dedicated Chrome session found no upstream
WebSocket connection or WebSocket frames. During repeated page reloads, the IM
Sports page used JSON `POST` Fetch responses. The response carrying event data
contained the structural fields `es`, nested `e`, and `obi`, and arrived about
every 5.18 seconds in the observed session.

The implementation therefore intercepts the site's own Fetch responses and
converts them into a downstream WebSocket feed. It does not increase the site's
request rate. End-to-end freshness is bounded by the site's own refresh cadence.

Discovery and production logging must never expose full request URLs, query
parameters, request headers, response bodies, cookies, browser storage, account
credentials, or CDP debugger URLs.

## Architecture

```text
remote consumer
  -> Cloudflare hostname
  -> K8 service on 127.0.0.1:8788
     -> HTTP read-only endpoints
     -> /ws/sports WebSocket endpoint
     -> CDP client on 127.0.0.1:9223
        -> dedicated Chrome profile
           -> logged-in IM Sports page
```

Cloudflare continues routing the public hostname to `127.0.0.1:8788`. The
tunnel never exposes the CDP port. Chrome binds CDP only to `127.0.0.1:9223` and
uses the persistent K8-specific profile directory.

All browser-backed HTTP endpoints and the realtime feed use this dedicated CDP
Chrome. There is no automatic fallback to Apple Events or another Chrome
profile. If the dedicated browser or allowed page is unavailable, HTTP browser
endpoints return `503` and realtime clients cannot connect or are disconnected.

## Components

### CDP event client

Extend the existing request-response CDP client with bounded event
subscriptions. The event client enables the `Network` domain and processes only
the allowed page target. It observes `Network.requestWillBeSent`,
`Network.responseReceived`, and `Network.loadingFinished`, then calls
`Network.getResponseBody` only for eligible Fetch responses.

Eligibility is based on all of the following:

- the configured HTTPS page origin;
- resource type `Fetch`;
- successful JSON response;
- response size within the configured limit;
- the expected structural event fields.

The full URL and headers are not retained or logged. Malformed or oversized
responses are discarded without replacing the last valid state.

### IM response adapter

The adapter validates the upstream status and event arrays, then converts the
site-specific abbreviated fields into the existing public sports event model.
It creates stable event and selection identifiers from upstream IDs and market
dimensions. The adapter is pure and is tested against small, hand-sanitized
fixtures that contain no credentials, tokens, account values, or request data.

### Feed state and differ

The feed stores only the latest normalized live-event state. It assigns a
monotonically increasing process-local `seq` to every downstream message.

On a valid new upstream state it emits:

- `delta` when a selection is added or its odds, line, or availability changes;
- `delta` with `available: false` before a previously visible selection is
  removed;
- `score` when score or clock changes;
- nothing when the normalized state is unchanged.

A newly connected client receives a complete `snapshot` derived from the
current state before any later increments.

### WebSocket server

Use the maintained `ws` package for RFC 6455 handshake, framing, control frames,
close handling, payload limits, and backpressure. Attach it to the existing HTTP
server's `upgrade` event and accept only `/ws/sports`.

The connection query parameter is retained for compatibility with the intended
consumer. It is checked against a new, independent `WS_TOKEN` using the same
constant-time comparison policy as the HTTP bearer token. `WS_TOKEN` must not
reuse `API_TOKEN`. Missing or invalid tokens receive an HTTP `401` before the
upgrade. Query strings are redacted from logs.

If no current feed exists, the upgrade receives `503`. The server sends a JSON
`ping` message every 30 seconds and also uses standard WebSocket control frames
to detect dead clients. Slow clients that exceed the configured buffered-byte
limit are closed rather than allowed to exhaust memory.

## Downstream protocol

Initial state:

```json
{"type":"snapshot","events":[],"seq":1}
```

Selection change:

```json
{
  "type":"delta",
  "event_id":"event-id",
  "selection_key":"market|period|line|side|selection-id",
  "decimal_odds":1.95,
  "line":-0.5,
  "available":true,
  "seq":2
}
```

Score change:

```json
{"type":"score","event_id":"event-id","score":"1-0","clock":"67:21","seq":3}
```

Application heartbeat:

```json
{"type":"ping","seq":4}
```

The snapshot event structure is the same normalized structure returned by the
existing live sports HTTP endpoint. This keeps one canonical data model for
both transports.

## Failure behavior

- A failed or invalid upstream response is ignored and does not erase the last
  valid snapshot.
- If no valid feed response arrives for 15 seconds, the feed becomes stale and
  clients close with code `1012`.
- CDP disconnection clears readiness, closes clients with code `1012`, and
  retries target discovery with bounded backoff.
- Page reloads may temporarily interrupt the feed. The next valid full response
  replaces internal state, and reconnecting clients receive a new snapshot.
- Authentication failures, upstream failures, and logs contain no secret or
  raw upstream values.

## Configuration and operation

Production configuration uses:

```text
UPSTREAM_MODE=browser
BROWSER_CDP_URL=http://127.0.0.1:9223
BROWSER_PAGE_ORIGIN=<allowed IM Sports HTTPS origin>
WS_TOKEN=<independent random secret of at least 32 characters>
```

The dedicated Chrome desktop shortcut starts the persistent profile with CDP
bound to loopback. The existing API shortcut is updated during implementation
to require the dedicated CDP browser and never select the everyday Chrome
profile. The Cloudflare tunnel configuration remains unchanged.

## Testing

Automated tests cover:

- bounded CDP event subscription and cleanup;
- strict target, origin, resource-type, content-type, and size filtering;
- IM response validation and normalized model mapping;
- stable event IDs and selection keys;
- snapshot, odds delta, line delta, score, removal, and no-change behavior;
- WebSocket route and token rejection;
- initial snapshot, ordering, sequence numbers, heartbeat, backpressure, and
  disconnect behavior;
- stale feed and CDP reconnection behavior;
- regression coverage for all existing HTTP endpoints using the dedicated CDP
  gateway.

Live verification checks only status codes, connection state, message types,
sequence ordering, and aggregate counts. It never prints tokens, full URLs,
headers, or raw payloads.

