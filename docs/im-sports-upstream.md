# IM Sports browser reader

The sports browser gateway selects only the configured IM Sports HTTPS origin. The origin setting must not contain a path, query string, fragment, user name, or password. A venue page URL and its query token are browser-managed data and must never be copied into configuration, source control, logs, or API responses.

## Verified read-only page structure

The 2026-07-19 read-only inspection established these selectors:

- sports section: `.eventlisting_wrap`
- section header: `.eventlisting_header`
- competition label: `.competition_header_team`
- event row: `.event_row`
- stable event link: `.team a[href^="/sev/"]`
- team label: `.teamname_title`
- score and clock: `.score`, `.datetime`
- event odds area: `.info`, `.header_info_inner`, `.event_even`
- full-time 1X2: `.event_even.double .odds_wrap`
- handicap and total lines: `.handi`, `.ou`
- displayed odds and lock state: `.odds`, `.lock`

The reader extracts only the primary team-bearing row and the first verified full-time 1X2, handicap, and total groups. It reads at most 500 events and returns ordinary JSON fields. It does not click, navigate, place bets, issue page requests, inspect request headers, or access browser storage.

## Current Chrome transport

The default `apple_events` transport uses a repository-owned JXA helper. For each Chrome tab, the helper executes only `location.origin` and compares the result with the configured pure HTTPS origin. It must not request the Chrome tab's full URL property: the full venue URL may contain browser-managed query data and must not appear in process output, configuration, logs, tests, or API responses.

After an exact origin match, the helper evaluates only a repository-owned, bounded, read-only DOM expression. HTTP clients cannot supply JavaScript expressions. The Node gateway starts the fixed `/usr/bin/osascript` binary with separate arguments and no shell, caps expression and response sizes, and replaces process or permission failures with sanitized browser errors.

Chrome must have **View > Developer > Allow JavaScript from Apple Events** enabled. The macOS **Privacy & Security > Automation** permission for the process running this API must also allow control of Google Chrome.

## Status markers

- A visible login form becomes `login_required`, which maps to `UPSTREAM_AUTH_EXPIRED`.
- Missing verified sports structure becomes `schema_changed`, which maps to `UPSTREAM_SCHEMA_CHANGED`.
- A verified page structure may return a truthful empty list, but an unknown blank page must not be treated as success.

All automated fixtures are synthetic. Local Chrome integration checks may inspect status, result shape, and event count only; they must not save a real response snapshot or the full venue URL.
