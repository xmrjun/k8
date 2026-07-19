# Current Chrome Apple Events Gateway Design

## Goal

Let the read-only k81128 API use the user's already-running, already-signed-in Google Chrome session on macOS. The API must read the k81128 account page and IM Sports odds page without launching a second Chrome profile and without reading or persisting cookies, Web Storage, passwords, full page URLs, URL tokens, or request signatures.

## Decision

Add a browser transport selector with `apple_events` as the default and keep the current loopback CDP gateway as an explicit compatibility option. In Apple Events mode, Node starts the fixed system binary `/usr/bin/osascript` with a repository-owned JXA helper and passes the allow-listed page origin and the existing read-only DOM expression as separate process arguments. It never invokes a shell.

The JXA helper enumerates Chrome tabs by executing only `location.origin` inside each tab. It does not request the Chrome tab URL property, because the full IM Sports URL may contain a token. When an exact origin matches, it evaluates the supplied expression in that tab and returns a JSON envelope. The helper never evaluates arbitrary caller input from an HTTP request: expressions continue to come only from the repository's balance, bets, and sports readers.

## Components and Data Flow

`src/browser/apple-events-gateway.js` implements the same `evaluate`, `status`, and `close` interface as the existing CDP gateway. A small repository-owned JXA file performs Chrome tab selection and evaluation. `src/server.js` selects the gateway factory from `BROWSER_TRANSPORT`; both the sports and account gateways still share the existing serialized operation queue.

For each API request, the reader supplies a static expression to the selected gateway. The gateway validates the configured origin and expression size, starts `osascript` with an abortable timeout, accepts only a bounded JSON response, and returns the decoded value to the existing normalizers. The public API contract, cache rules, authentication, and tunnel boundary remain unchanged.

## Errors and Security

Missing Chrome, a missing allowed-origin tab, disabled Apple Events JavaScript, or macOS Automation denial maps to the trusted browser-unavailable error and an API `503`. An operation timeout maps through the existing queue to `504`. Invalid or oversized helper output maps to a sanitized bad-response error. Stderr from Chrome automation is never forwarded to API clients, and errors retain no process command, expression, full URL, token, or page content.

The API remains bound to `127.0.0.1`. A tunnel may expose only port 8788, protected by the existing bearer token. Neither CDP nor any Chrome automation endpoint is exposed to the LAN or tunnel.

## Testing and Operations

Unit tests inject a fake process runner and cover exact-origin validation, argument separation, bounded output, aborts, malformed JSON, missing tabs, permissions, and secret-free diagnostics. Server tests cover transport selection and dual-origin gateway construction. The full existing suite must remain green.

Real verification is deliberately narrow: with the user-signed-in Chrome tabs open and **Allow JavaScript from Apple Events** enabled, start the API from a normal macOS Terminal session, call health, then call one authenticated sports endpoint while printing only HTTP status, source, count, and schema keys. Do not save the page response or any browser URL. The first run may require the user to approve macOS Automation access from Terminal to Google Chrome.
