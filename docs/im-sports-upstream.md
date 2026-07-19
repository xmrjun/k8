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

## Status markers

- A visible login form becomes `login_required`, which maps to `UPSTREAM_AUTH_EXPIRED`.
- Missing verified sports structure becomes `schema_changed`, which maps to `UPSTREAM_SCHEMA_CHANGED`.
- A verified page structure may return a truthful empty list, but an unknown blank page must not be treated as success.

All automated fixtures are synthetic. Local Chrome integration checks may inspect status, result shape, and event count only; they must not save a real response snapshot or the full venue URL.
