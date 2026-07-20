# Manual-Confirmation Bet Drafts Design

## Goal

Add a short-lived, authenticated bet-draft API that validates a proposed
selection against the current read-only IM Sports feed and prepares a local
draft for the user to confirm manually on the IM Sports page.

This feature must never submit, confirm, cancel, settle, or cash out a real
wager. It must not click betting controls, call private betting endpoints, or
read browser credentials, cookies, Web Storage, request headers, or URL tokens.

## Public API

`POST /api/bets/drafts`

The request body contains exactly:

- `scope`: `live`, `today`, or `early`;
- `sport`: `football`, `basketball`, or `tennis`;
- `event_id`: the stable event identifier returned by `GET /api/sports`;
- `selection_key`: the stable selection key returned by `GET /api/sports`;
- `stake`: a positive decimal string with at most two fractional digits;
- `expected_odds`: the decimal odds string observed by the caller;
- `max_odds_drift`: the largest permitted absolute decimal-odds change;
- `idempotency_key`: a caller-generated opaque key.

Unknown fields, malformed JSON, non-JSON bodies, oversized bodies, query
parameters, and invalid values are rejected. The route uses the existing Bearer
authentication and never logs the request body.

On success, the response contains a local `draft_id`, the normalized proposal,
the current verified odds, projected gross return, creation and expiry times,
an `odds_changed` flag, and the fixed state
`ready_for_manual_confirmation`. It contains no venue URL or credential.

## Validation and data flow

The handler asks the existing browser upstream for the exact requested
scope/sport snapshot without using the HTTP sports cache. It locates exactly one
event and exactly one available selection by stable identifiers. Missing,
duplicate, locked, or unavailable selections fail closed.

Odds and money arithmetic use decimal strings and integer scaling rather than
binary floating-point. A proposal is rejected when the current odds differ from
`expected_odds` by more than `max_odds_drift`. A change within the permitted
drift is disclosed in the response. The projected gross return uses the current
verified odds.

Creating a draft changes only local memory. The service does not alter the IM
page and does not require the bet-record endpoint.

## Draft store and idempotency

Drafts live in a bounded in-memory store:

- lifetime: 120 seconds;
- maximum live drafts: 1000;
- expired entries are removed before reads and writes;
- a full store evicts the oldest entry;
- the same `idempotency_key` and identical normalized request return the same
  draft;
- reusing a key with different input is rejected.

The store is intentionally non-persistent. Restarting the API invalidates every
draft, which prevents an old proposal from being treated as current.

## Errors and security

The endpoint returns stable, sanitized application errors for malformed input,
unknown events or selections, unavailable selections, excessive odds drift,
idempotency conflicts, upstream timeout, expired authentication, and schema
changes. It never includes upstream DOM, page URLs, browser data, or received
credentials in errors or diagnostics.

All other non-GET routes remain `405 Method Not Allowed`. There is no endpoint
that advances a draft beyond `ready_for_manual_confirmation`.

## Testing

Test-driven implementation covers decimal validation, exact selection lookup,
availability checks, drift rules, projected-return arithmetic, TTL expiry,
bounded eviction, idempotent replay, conflict rejection, authentication,
content type and body bounds, method routing, sanitized upstream errors, and
the permanent absence of any submission or confirmation method.

The full existing test suite and syntax checks must pass before the change is
committed or pushed.
