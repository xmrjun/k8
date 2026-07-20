# IM Sports Catalog and Odds Boost Read-Only Design

## Goal

Expose the verified navigation and promotion surfaces without mixing them into the
ordinary `scope + sport` event model and without adding any wagering capability.

## Endpoints

`GET /api/sports/catalog` returns:

- the verified `live`, `today`, and `early` scopes;
- the visible `today`, `early`, and `parlay` navigation tabs;
- scope-specific live sports and the complete visible sports catalog;
- visible popular tournament names and counts;
- sports currently represented in the odds-boost section.

`GET /api/sports/boosts` returns bounded, visible promotional cards with their
kind, participant count, plain-text composition, original odds, boosted odds, and
availability. It never exposes an action URL or browser-managed identifier.

## Verified page structure

- live sports: `#leftpanel_live .leftmenu_sports_item`
- popular tournaments: `#leftpanel_popular_tournament .leftmenu_sports_item`
- all sports and tabs: `#leftpanel_all_sports`
- odds-boost sports: `#leftpanel_oddsboost`
- odds-boost cards: `.ob_card`
- card kind: `.ob_pap_label`
- participant count: `.ob_bet_placed`
- composition: `.ob_pap`
- original/boosted odds: `.odds.ob_odds.old`, `.odds.ob_odds.new`

The catalog uses an exact label allow-list for stable public sport keys. Unknown
labels cause a schema error instead of being guessed. Popular tournament names are
dynamic visible text and are bounded by count, length, and character validation.

## Safety boundary

Both endpoints are authenticated GET-only reads using the existing serialized IM
Sports browser gateway. Expressions do not read Cookie, browser storage, passwords,
request headers, full URLs, or login credentials. They do not click odds, bet slips,
confirmations, cash-out, or funds controls.

No order, confirmation, or cash-out endpoint is added. The public gateway remains
read-only even when a promotion card describes a parlay.

## Initial sports catalog

The first catalog maps the exact visible labels for football, electronic football,
basketball, electronic basketball, esports, tennis, fantasy marble, table tennis,
volleyball, baseball, virtual sports, combat sports, and snooker/billiards. Catalog
presence does not imply that event and market parsing is supported for that sport;
the existing `/api/sports` endpoint remains limited to football, basketball, and
tennis until each additional event layout is separately verified.

