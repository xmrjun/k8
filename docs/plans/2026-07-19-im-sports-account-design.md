# IM Sports Account Summary Design

## Goal

Add a token-protected, read-only endpoint that exposes the account summary visibly rendered by the signed-in IM Sports page. The endpoint is separate from the existing k81128 wallet endpoint because the two pages represent different account contexts.

## Public contract

`GET /api/sports/account` returns the existing success envelope with this `data` value:

```json
{
  "currency": "USD",
  "available_balance": 1.8,
  "unsettled_amount": 1175
}
```

Decimals use the project's existing safe public-decimal rules: safely representable values are JSON numbers and higher-precision values remain strings. The response is never cached. The existing `GET /api/balance` behavior and response remain unchanged.

## Data flow

The request uses the existing bearer-token authentication and the existing IM Sports browser gateway. A repository-owned bounded DOM expression reads only three visible text fields from the IM Sports account panel: currency, available balance, and unsettled amount. Node validates and normalizes the bounded result before returning the standard response envelope.

The reader does not navigate, click, place bets, or access cookies, Local Storage, Session Storage, passwords, full page URLs, URL tokens, request headers, request signatures, or network payloads. It shares the existing serialized browser-operation queue with sports odds and k81128 account reads.

## Reader discovery and validation

Stable selectors must be verified against the currently signed-in page before implementation. The DOM expression must use only those verified selectors, cap all queried collections, and return one of three explicit statuses: `ready`, `login_required`, or `schema_changed`.

The Node normalizer requires:

- an allow-listed currency code;
- a non-negative available balance;
- a non-negative unsettled amount;
- no extra browser-derived fields in the public model.

Synthetic fixtures and tests must not contain the user's real balance, account identifier, full venue URL, or venue token.

## Errors and availability

- Missing Chrome, a missing IM Sports tab, or denied browser automation maps to sanitized `503 BROWSER_UNAVAILABLE`.
- A visible login marker maps to sanitized `502 UPSTREAM_AUTH_EXPIRED`.
- Missing or malformed account-panel fields map to sanitized `502 UPSTREAM_SCHEMA_CHANGED`.
- Unexpected failures retain no page content, browser command, credential, full URL, or token.

The endpoint remains read-only. Betting and WebSocket interception are separate future designs and are not introduced here.

## Verification

Implementation follows test-driven development. Unit tests cover expression safety, normalization, decimal precision, authentication markers, and schema failures. API tests cover authentication, route dispatch, no caching, and stable error mapping. Final live verification prints only HTTP status, source, currency, and field presence; it does not print the user's balance or unsettled amount.
