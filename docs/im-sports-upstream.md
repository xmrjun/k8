# IM Sports browser reader

The sports browser gateway selects only the configured IM Sports HTTPS origin. The origin setting must not contain a path, query string, fragment, user name, or password. A venue page URL and its query token are browser-managed data and must never be copied into configuration, source control, logs, or API responses.

## Verified read-only page structure

The 2026-07-19 read-only inspection established these selectors:

- scope group: `.main_left > .leftmenu_items`
- group heading: `.sports_menu_header .menu_name`
- today/early tab: `.leftmenu_tab_filter .tab_label`
- scope-specific sport item: `.leftmenu_sports_item`
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

The page has three independent sport lists: `滚球中`, `所有体育 → 今日`, and
`所有体育 → 早盘`. Every HTTP read therefore requires both a scope and a sport.
Inside the serialized browser operation, the selector first chooses the exact scope,
then chooses the exact sport only inside that scope's container, and waits for an
event header that confirms both values. A missing sport in an otherwise verified
scope is a truthful empty result. Ambiguous groups or a mismatched result header are
schema failures.

The first supported scope keys are `live`, `today`, and `early`. The first supported
sport keys and verified `/sev/<sport-id>/...` identities are:

| Sport key | Visible label | `/sev` sport id |
| --- | --- | --- |
| `football` | `足球` | `1` |
| `basketball` | `篮球` | `2` |
| `tennis` | `网球` | `3` |

The event reader extracts only the primary team-bearing row. Football emits `1x2`,
`handicap`, and `total`; basketball emits `moneyline`, `handicap`, and `total`;
tennis emits `moneyline`, `handicap`, `total`, and structurally verified
`odd_even`. Football and basketball may emit `full_time` and `first_half`; tennis
currently emits only the first verified `full_time` container. Sport-id/header
conflicts and mixed sport ids are schema failures, not guessed data.

It reads at most 500 events and returns ordinary JSON fields. Controlled interaction
is limited to exact scope tabs and sport filters. It does not click odds, bet slips,
cash-out, confirmations, record rows, or funds controls; issue page requests;
inspect request headers; or access browser storage.

## Verified account-summary structure

The 2026-07-19 read-only inspection also established the IM Sports account panel contract:

- unique account container: `#left_panel .leftmenu_account`
- currency heading: `.leftmenu_account_title`
- bounded account rows: `.leftmenu_content .row`
- row value: `.text-right`

The reader identifies rows by the exact visible labels `余额` and `未结算注单`; it does not depend on row position. It inspects at most eight account rows and returns only the currency heading, available balance, and unsettled amount. Real account amounts are never stored in fixtures or documentation.

## Bet-record popup contract

The IM Sports bet history is a separate same-origin page whose pathname is exactly
`/popup/`. The main sports reader is restricted to pathname `/`, while the bet
reader is restricted to `/popup/`; query strings are never copied, logged, or
returned.

The popup exposes the exact record tabs `未结算注单` and `已结算注单`, the visible
currency label `投注金额 (CODE)`, and record rows containing a placed time and bet
identifier, description, displayed odds, stake/potential-payout text, and visible
state. The reader inspects at most 200 rows and normalizes local GMT+8 timestamps in
Node. Fixtures use synthetic identifiers, descriptions, and amounts only.

For `status=all`, the dedicated Chrome page may switch only between those two exact
record-filter tabs and restores the originally selected tab after reading. It does
not click record rows, cash-out controls, bet slips, wager buttons, confirmations,
or links, and it does not issue page requests or access browser storage.

## Current Chrome transport

The default `cdp` transport discovers only an exact allow-listed origin and pathname
through the loopback-only Chrome debugger. It evaluates only repository-owned,
bounded expressions; HTTP clients cannot supply JavaScript expressions. The full
venue URL may contain browser-managed query data and must not appear in process
output, configuration, logs, tests, or API responses.

The `apple_events` rollback transport uses the repository-owned JXA helper and the
same origin/path restrictions. It executes only `location.origin` for tab discovery,
then the fixed expression after an exact match. It must not request Chrome's full tab
URL property. Apple Events mode additionally requires **View > Developer > Allow
JavaScript from Apple Events** and macOS Automation permission for the API process.

## Status markers

- A visible login form becomes `login_required`, which maps to `UPSTREAM_AUTH_EXPIRED`.
- Missing verified sports structure becomes `schema_changed`, which maps to `UPSTREAM_SCHEMA_CHANGED`.
- A verified scope with no matching sport becomes an empty successful snapshot.
- A verified page structure may return a truthful empty list, but an unknown blank page must not be treated as success.

All automated fixtures are synthetic. Local Chrome integration checks may inspect status, result shape, and event count only; they must not save a real response snapshot or the full venue URL.
