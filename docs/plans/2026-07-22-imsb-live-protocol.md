# IM Sports (Sunflower 2.0) live (滚球) feed protocol

Reverse-engineered 2026-07-22 against the live signed-in venue by capturing the
site's own authenticated responses. Covers the live delta protocol and request
auth.

> **CORRECTION (2026-07-22, supersedes §3 below).** §3 originally concluded that
> bare `fetch()` fails because it lacks the per-request `x-sc` signature. **That
> was wrong** — the failing test simply omitted the `x-token` header. Verified:
> a bare fetch with `x-token` (the session token) + the constant headers
> (`x-v:90594, x-platform:3, x-lang:hans, x-oddsTemp:3, x-oddsTempBetType:1`)
> returns StatusCode 100 **with no x-sc at all** (and with a stale x-sc). So
> **x-sc is NOT enforced by the server.** The `x-token` is the session token =
> the page URL's `?token=` value (mirrored in `localStorage.siteProfile.t`); it
> **expires** and must be re-seeded with a fresh login URL. The active JSON
> approach therefore works for reads (GetSE/GetSEDelta) AND placement
> (GetBI/SPB); `imsb-api.FETCH_HEADERS` now injects these headers, reading the
> token in page context. The passive-monitor / DOM-placement fallbacks in §4 are
> no longer required (the feed-state live path is still used and still valid).

## 1. Live is a stateful delta stream (no reusable snapshot call)

Unlike pre-match (`GetSE {Market:1}` → full `sel` snapshot, see the 07-21 design
doc), the **live board never returns a `sel` snapshot** on demand. It is served
by `EventV6/GetSEDelta` (`Market:3`), which always returns `{ dc, Delta,
StatusCode }`:

- `dc` — an array of change entries (the live updates).
- `Delta` — a **gzip+base64 blob of the client's prior state**; the client sends
  it back on the next poll and the server returns only the diff.
- First poll (empty `Delta`) returns the **full current state** as a `dc` array
  of `a:0` "add event" entries; subsequent polls return small diffs.

So there is no one-shot live snapshot to reuse the way `parseSeEvents` reuses
pre-match `sel`. Live state must be **accumulated** from the delta stream.

## 2. `dc` entry shape and action types (`a`)

Each entry: `{ eid, a, sid, v }` (`sid` = 1 in all samples; `v` absent for some
actions). Action types observed in ~1 min of live football, with counts:

| `a` | count | meaning | `v` payload |
|---|---|---|---|
| **0** | 6 | **add event** (bootstrap unit) | `[ full event ]` — same shape as a `sel` event: `eid, htn, atn, cn, iop, edt, hs, as, rbt, mls[], m, …` |
| 1 | 14 | remove event | *(none)* |
| 2 | 148 | update event metadata | `{ htn, atn, cn, edt, iop, estr, … }` (partial event fields; not odds) |
| 3 | 393 | replace all markets | `[ markets ]` (full `mls`) |
| 4 | 38 | patch markets by `mi` | `[ markets ]` (merge onto existing `mls`) |
| 5 | 459 | score | `{ hs, as, hrc, arc }` |
| 6 | 457 | clock | `"string"` (→ `rbt`) |
| 10 | 59 | status flag (suspend/live toggle, unconfirmed) | scalar (e.g. `1`) |
| 11 | 459 | period scores | `[ { gp, st, hs, as } ]` |
| 14 | 24 | aux match stats | `{ hcnr, c15mhs, c15mas }` (corners / 15-min score) |
| 15 | 23 | available bet-type ids per period | `[ { gp, btids:[…] } ]` |

Key correction to the existing `src/realtime/feed-state.js` (built 07-19): it
seeds only from a `sel` snapshot and handles only `a` ∈ {3,4,5,6,11}, throwing →
resync on everything else. Against the current feed that means **no seed ever
arrives** (`a:0` is the seed now, not `sel`) and ~274 unhandled actions/min each
force a page reload. The feed-state needs updating to:
- seed per-event from `a:0`,
- apply `a:1` (remove), `a:2` (metadata), `a:3/4` (markets), `a:5/6` (score/clock),
- **ignore** `a:10/14/15` (and unknown) instead of resyncing.

The market/selection/odds mapping is otherwise identical to pre-match (verified):
bti 1=让球/让分, 2=大/小, 3=1X2, 4=独赢(basketball); si 1/2 home/away, 3/4
over/under, 5/6/7 home/draw/away, 8/9 home/away; gp 1=full_time, 2=first_half;
odds per selection by `ot` (2=Hong Kong, 3=European); line from `dih`.

## 3. BLOCKER — bare `fetch()` is not signed; the whole active-call model fails

The venue authenticates every `/api/...` POST with per-request headers the
site's own http client computes and passes **explicitly** in `fetch(url,
{headers})`:

```
Accept, Content-Type, x-token, x-sc, x-v, x-platform, x-lang, x-oddsTemp, x-oddsTempBetType
```

- `x-token` = the session UUID (from the page URL). Reusable.
- **`x-sc`** = a per-request signature, **recomputed for every call** by an
  obfuscated signer. Not reproducible without reversing it.

A bare `fetch('/api/EventV6/GetSE', {headers:{Accept,Content-Type}, body})` from
page context — exactly what `buildGetSeExpression` / `buildGetEventsExpression` /
`buildPlaceExpression` emit — is **missing `x-sc` and rejected** (`StatusCode`
500 / 102), while the site's own client call succeeds (`100`). This is
header-driven, so it fails the same way under CDP `Runtime.evaluate` (main world)
as under the extension — the execution world is irrelevant.

**The 07-21 design premise ("a bare page-context fetch is automatically signed")
does not hold on the current venue build.** Consequences:

- The `imsb_api` **read** path (`getSports` via bare-fetch GetSE — Step 1) does
  **not** work against the live venue. It returns empty/500, not real odds.
- The `imsb_api` **placement** path (bare-fetch GetBI/SPB) does **not** work
  either — and placement *requires* an active signed call, so it cannot fall
  back to passive observation.

The signer + api client live inside webpack module `1985` (493 KB, minified;
contains `x-sc`, `GetSE`, `PlaceBetV6`). Its exports are empty (internal
closures), so the signer is **not callable** without instrumenting minified
internals — fragile across redeploys and effectively "reversing x-sc", which the
design explicitly avoids.

## 4. Viable architectures (given signing cannot be reproduced)

- **Reads — passive.** Observe the site's own signed GetSE/GetSEDelta responses
  via CDP `Network.getResponseBody` and accumulate state. This is exactly what
  `src/realtime/im-network-monitor.js` + `feed-state.js` already do (they never
  sign anything). Live `getSports` should read from that accumulated state, not
  make its own call. `feed-state` needs the §2 updates first.
- **Placement — signer-free option is DOM automation.** `src/browser/place-bet.js`
  already drives the bet slip via the UI; the site signs its *own* SPB when the
  slip is confirmed. This is the only placement path that avoids the signer. The
  JSON-API placement (`imsb-api.buildPlaceExpression`) is blocked unless the
  signer is extracted/reversed.
- **Active JSON calls — only if the signer is solved.** Either extract a callable
  reference to the site's client from module `1985` (fragile) or reverse `x-sc`
  (discouraged, high effort).

## 5. Verification (2026-07-22) — signing blocker CONFIRMED in the main world

Run in the venue page's **main world** (proven: page global
`webpackChunksunflower2` is visible, and `window.fetch` is native/unwrapped —
`toString` shows `[native code]`, so the site does not auto-sign fetch). CDP
`Runtime.evaluate` uses this same main world, so this is equivalent to the
gateway path. Airtight A/B at the same instant on the same session:

| call | x-sc header | StatusCode |
|---|---|---|
| site's own GetSEDelta (its http client) | present | **100** (works) |
| the exact `buildGetSeExpression` output, bare `fetch` | absent | **500** (0 events) |

Only x-sc differs. The session is valid (site calls succeed) — the bare-fetch
read simply is not signed. Confirmed: the `imsb_api` bare-fetch read/placement
path does not work against the live venue.

## 6. Open items

- Decide reads-passive vs. active-signer, and placement DOM vs. signer.
- Decode `a:10` semantics precisely; confirm empty-`Delta` → full `dc` on a
  captured cold bootstrap.
