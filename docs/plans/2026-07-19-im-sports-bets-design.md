# IM Sports Bet Records Design

**Goal:** Make `GET /api/bets` read the signed-in IM Sports bet-record popup instead of the unrelated k81128 account page.

## Chosen approach

Use a dedicated browser gateway for the IM Sports popup pathname `/popup/`. Keep the live sports gateway restricted to the main IM Sports pathname `/`, and keep the k81128 account gateway unchanged. This prevents a same-origin popup from being mistaken for the live-odds page.

The bet reader is bounded and read-only. It may select only the exact record tabs `未结算注单` and `已结算注单` to satisfy `status=unsettled`, `status=settled`, or both for `status=all`; it must never click cash-out, bet-slip, wager, or confirmation controls. Browser operations remain serialized through the existing queue, and `status=all` restores the tab that was active before the read.

## HTTP contract

`GET /api/bets?status=unsettled|settled|all&limit=25&cursor=0`

- `status` defaults to `all`.
- `limit` remains an integer from 1 through 100 and defaults to 25.
- `cursor` is an optional non-negative decimal offset.
- The endpoint is bearer-protected and never cached.
- The response source is `im-sports-browser`.

Each result contains only visible record data:

```json
{
  "bet_id": "SYNTHETIC-1",
  "placed_at": "2026-07-19T02:30:00.000Z",
  "status": "unsettled",
  "description": "Synthetic event and selection",
  "odds": 2.25,
  "stake": 10,
  "currency": "USD",
  "potential_payout": 22.5
}
```

`potential_payout` is nullable when the page does not display a truthful amount. Real record identifiers, event names, account values, or venue URLs must never be stored in fixtures or documentation.

## Browser and parsing boundaries

Target discovery validates the configured HTTPS origin and an optional exact pathname. It does not retain, log, or return the page query, fragment, token, browser headers, or storage. CDP debugger WebSocket URLs remain restricted to the same loopback endpoint.

The DOM expression returns an explicit page status, currency heading, selected record status, and at most 200 synthetic-shaped row cell arrays. Node performs all timestamp, decimal, status, pagination, and required-field validation. Login markers map to `UPSTREAM_AUTH_EXPIRED`; a missing popup maps to `BROWSER_UNAVAILABLE`; an unknown or changed record layout maps to `UPSTREAM_SCHEMA_CHANGED`.

## Failure behavior

- Popup not open: HTTP `503 BROWSER_UNAVAILABLE`.
- IM Sports login expired: HTTP `502 UPSTREAM_AUTH_EXPIRED`.
- Verified empty tab: HTTP `200` with an empty array.
- DOM contract changed or a requested tab cannot be verified: HTTP `502 UPSTREAM_SCHEMA_CHANGED`.
- No stale record data is served after any failure.

## Verification

Automated tests use synthetic fixtures only. They verify exact-path target separation, forbidden browser-data access, safe tab selection, strict normalization, query validation, uncached routing, sanitized errors, and gateway lifecycle. Live checks report only HTTP status, result count, and schema keys; they do not print real record contents or tokens.
