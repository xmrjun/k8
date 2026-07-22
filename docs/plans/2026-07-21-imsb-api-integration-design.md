# IM Sports ("Sunflower 2.0") API Integration Design

Reverse-engineered 2026-07-21 against the live signed-in venue
(`imsb-fxnag.utoyen.com:2053`). Replaces DOM scraping / click automation with
the venue's own JSON API for both reading odds and placing bets.

## Why

DOM automation proved fragile: odds format varies (香港盘 vs 欧洲盘), the bet
slip collapses/clears on live-odds churn, and periods like 加时 (overtime) are
not in the scraped model. The venue exposes a clean JSON API that carries the
stable identifiers needed to place a bet directly.

## Authentication

- **Credential**: a per-session token supplied by the account holder (delivered
  as `?token=<uuid>` on the page URL). Carried to the API as the **`x-token`**
  request header. It expires; a bot must be re-seeded when it does.
- **Per-request signature**: every API call also carries **`x-sc`** — a 76-char
  base64 value that is unique per request (a client-side anti-bot signature).
  It is NOT reproducible server-side without reversing the (obfuscated) signer.
- **Key consequence**: a page-context `fetch()` to `/api/...` is **automatically
  signed and authenticated** by the site's own code. A bare
  `fetch('/api/HomeV6/GetSM', {method:'POST', body})` from the page returns 200.
  Therefore we execute all API calls **inside the browser page** (via the
  existing CDP `Runtime.evaluate` gateway) and let the site sign them. No signer
  reversing, no header assembly.

Other (constant) headers observed: `x-v:90594`, `x-platform:3`, `x-lang:hans`,
`x-oddsTemp:3`, `x-oddsTempBetType:1`. These are added by the site automatically
too and need not be set by us.

## Reading odds — `POST /api/EventV6/GetESI`

Request (minimal): `{ "Type": 2, "OddsType": 2, "SportId": 1 }`
(SportId 1 = football. `GetSEDelta` is the incremental-delta variant with a
richer filter body: SportId, Market, BetTypeIds, GamePeriods, OddsType,
DateFrom, DateTo, CompetitionIds, Delta, ProgrammeIds.)

Response: `{ es: [ { e: [event], obi: [...] } ], obc, StatusCode }`

Event (`e[0]`):
| field | meaning |
|---|---|
| `eid` | event id |
| `htn` / `htid` | home team name / id |
| `atn` / `atid` | away team name / id |
| `cn` / `cid` | competition name / id |
| `iop` | in-play (live) boolean |
| `edt` | event datetime |
| `mls` | markets (array) |

Market (`mls[j]`):
| field | meaning |
|---|---|
| `mi` | market id → maps to SPB `mlid` |
| `bti` / `btn` | bet type id / name (3=1X2, 9=半场/全场, 18=双方球队皆进球, …) |
| `gp` | game period → SPB `gp` |
| `ml` | market line |
| `ws` | wager selections (array) |

Wager selection (`ws[k]`):
| field | meaning |
|---|---|
| `wsi` | wager selection id → SPB `wsid` |
| `si` | selection id / index |
| `s` | handicap / line string → SPB `h` |
| `o` | odds (European decimal) → SPB `o` |
| `ot` | odds type → SPB `otid` |

## Placing a bet — two-step

### 1. Validate + limits: `POST /api/PlaceBetV6/GetBI`

Request: `{ "wss": [ { spid, eid, btid, gp, otid, mlid, wsid, btsid, h, o,
spf:"", md:0, sid:0, refid:<wsid>, wt:1 } ], "wt": 1 }`

Response: `{ wss:[{ ..., o:<current odds>, dih, s:<...> }],
bset:[{ mib:<min bet>, mab:<max bet>, epa:<odds>, ... }], StatusCode:100 }`
→ gives the **current odds** and **min/max stake** for the guardrails.

### 2. Submit: `POST /api/PlaceBetV6/SPB`

Request:
```json
{ "s": "1.00",
  "ws": { "spid":1, "eid":<eid>, "m":<market>, "otid":<ot>, "btid":<bti>,
          "hs":<home score>, "as":<away score>, "mlid":<mi>, "wsid":<wsi>,
          "btsid":<sub>, "h":<line>, "o":<odds>, "ortid":0, "spf":"",
          "Matchday":0, "SeasonId":0, "gp":<gp> },
  "fpf":"MacIntel" }
```

Response (success):
```json
{ "wid":"2607210946442701",  // bet id (投注编号)
  "pbs":3, "ao":1.01, "aos":"1.01",  // ao = accepted odds
  "h":0.5, "dih":"0.5", "est":35.35,
  "ab":1000.37,               // account balance after
  "StatusCode":100 }          // 100 = success
```

- **Success** = `StatusCode === 100`; bet id = `wid`.
- **Odds drift** is authoritative here: compare `ao` (accepted odds) against the
  draft's `expected_odds` / `max_odds_drift`. The venue auto-accepts *better*
  odds; worse-than-tolerance drift should be rejected by us BEFORE calling SPB
  (using GetBI's returned odds), and re-checked against `ao` after.

## Target architecture

Replace the DOM readers/writers with API calls executed in page context:

- `getSports(scope, sport)` → evaluate `fetch('/api/EventV6/GetESI', …)`, parse
  `es[].e[].mls[].ws[]` into the normalized selection shape, **carrying the
  placement ids** (`eid, mi, bti, gp, wsi, si, s, o, ot`) on each selection.
- `placeBet(draft)` → evaluate GetBI (limits + current odds; enforce
  `mib ≤ stake ≤ mab` and drift) then SPB; return `{ bet_id: wid, accepted_odds: ao }`.
- Guardrails from `bet-placement.js` stay: kill switch, dry-run, single/daily
  stake caps, idempotency. Drift check now uses `ao`/GetBI odds.

Open items:
- Map our `scope` (live/today/early) to the GetESI/GetSEDelta filter (iop +
  date range). `iop:true` = live; date range selects today/early.
- Map `selection_key` (`eid:period:type:pick`) to `(mi, wsi)` — either embed ids
  in the selection returned by `getSports`, or re-resolve at placement via a
  fresh GetESI keyed on eid.
- Token lifecycle: detect expiry (StatusCode ≠ 100 / auth error) and surface a
  re-seed signal.

## Security / safety notes

- The session token is a bearer credential to a real-money account. Never log
  it, never place it in URLs we control, never commit it. It lives only as the
  browser session's `x-token`.
- Placement stays behind the existing guardrails; the first live API placement
  must be supervised at minimum stake.
- Nothing here reverses the `x-sc` signer; if the venue changes page-context
  signing, the in-browser approach still works because the site signs its own
  fetches.

## Update 2026-07-22 — verified GetSE read path (early / today)

Reverse-engineered against the live signed-in venue by capturing the site's own
authenticated `fetch` responses (real fixtures saved under
`test/fixtures/imsb-getse-*.json`). Key correction to the plan above: **the full
markets (让球/大小/1X2/独赢) do NOT come from `GetESI` (`Type:2`)** — that is a
"highlights" subset carrying single selections and no handicap/total. They come
from **`EventV6/GetSE`**, whose events are in `data.sel[]` (each with `mls`
markets; `data.d` is a compressed side-dictionary we ignore).

Request: `{ SportId, Market, BetTypeIds, GamePeriods:[1,2], IsCombo:false,
OddsType:2, DateFrom, DateTo, CompetitionIds:[], SortType:2, ProgrammeIds:[] }`.

- **Scope → Market** (resolves the old open item): `Market:1` = 早盘 (pre-match)
  serves `scope` today/early (today = `DateFrom=DateTo=today`, early =
  `DateFrom=today, DateTo=''`); `Market:3` = 滚球 (live) serves `scope=live` and
  streams over WebSocket — a separate, later path. For now `scope=live` returns
  an empty snapshot rather than a partial one.
- **Sports**: football = `SportId 1` (bet types 1/2/3), basketball = `SportId 2`
  (bet types 1/2/4). (`SportId 54` seen earlier was a different highlights
  category, not pre-match basketball.)
- **Bet types → draft market** (verified, both sports):
  | bti | market | draft type | `si` order | line |
  |---|---|---|---|---|
  | 1 | 让球 / 让分 | handicap | si 1=home, 2=away | `dih` |
  | 2 | 大/小 | total | si 3=over, 4=under | `dih` |
  | 3 | 1X2 (football) | 1x2 | si 5=home, 6=draw, 7=away | — |
  | 4 | 独赢 (basketball) | moneyline | si 8=home, 9=away | — |
- **Game period** `gp`: 1 = full_time, 2 = first_half.
- **Odds are per-selection via `ot`**: `ot 3` = European decimal (draft
  `decimal_odds = o`, `display_odds = o-1`); `ot 2` = Hong Kong (`display_odds =
  o`, `decimal_odds = o+1`). Within one event 1X2/独赢 use `ot 3` while 让球/大小
  use `ot 2`.
- **Line**: handicap/total carry a numeric `hdp` and a display `dih` (e.g.
  `+0.5/1`, `-0.5/1`, `2/2.5`, `173`); `dih` maps directly to the draft `line`.
- **Main line only**: 让球/大小 offer several lines at once as separate `mls`
  entries distinguished by `ml` (1 = main, 2+ = alternates). The draft
  `selection_key` (`eid:period:type:name`) has no line component, so only `ml:1`
  is exposed; alternate lines need a selection_key redesign to carry the line.
- **Placement id re-resolution** (resolves the other open item): the strict
  draft snapshot cannot carry imsb ids (its validator rejects extra fields), so
  `placeBet` re-runs GetSE and re-resolves `selection_key → (eid, mi, wsi, …)`
  through the same normalizer used on the read path.

Still open: live (滚球) via GetSEDelta + WebSocket; alternate lines; token
expiry re-seed signal; tennis and other sports.
