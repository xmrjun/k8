# IM Sports Sport Separation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reliably distinguish football, basketball, and tennis across IM Sports HTTP snapshots and normalize each project's verified markets.

**Architecture:** Use the first numeric segment of `/sev/<sport-id>/<view-id>/<event-id>` as the stable sport identity and cross-check it against the event-listing header. Keep `scope` and `sport` independent, then parse period and market layouts with a small sport-specific contract while retaining the existing common event envelope.

**Tech Stack:** Node.js 22, CommonJS, `node:test`, bounded read-only DOM expressions.

---

### Task 1: Lock the verified sport identity contract

**Files:**
- Modify: `test/browser-sports-reader.test.js`
- Modify: `src/browser/readers/sports.js`

**Step 1: Write the failing tests**

Add synthetic DOM tests whose event links use `/sev/1/3/...`, `/sev/2/3/...`, and `/sev/3/3/...`. Assert that the expression emits `football`, `basketball`, and `tennis` respectively, and that an ID/header mismatch emits `schema_changed`.

**Step 2: Run tests to verify RED**

Run: `node --test test/browser-sports-reader.test.js`

Expected: basketball or tennis is misclassified because the current fallback reads the second path segment.

**Step 3: Implement minimal identity mapping**

Add a verified `sport-id` map for `1`, `2`, and `3`. Parse the first path segment, cross-check it with the header sport, and reject unknown or conflicting identities.

**Step 4: Run tests to verify GREEN**

Run: `node --test test/browser-sports-reader.test.js`

Expected: PASS.

### Task 2: Normalize sport-specific winner markets and periods

**Files:**
- Modify: `test/browser-sports-reader.test.js`
- Modify: `test/fixtures/im-sports-raw.json`
- Modify: `src/browser/readers/sports.js`

**Step 1: Write failing normalization tests**

Add synthetic basketball and tennis payloads containing `moneyline`, plus football and basketball `first_half` markets. Add a tennis `odd_even` market. Assert stable selection keys and that line-less markets do not require a line.

**Step 2: Run tests to verify RED**

Run: `node --test test/browser-sports-reader.test.js`

Expected: FAIL because the current schema only accepts `1x2`, `handicap`, `total`, and `full_time`.

**Step 3: Implement minimal normalization**

Add `moneyline` and `odd_even` selection contracts and `first_half` to the allowed periods. Preserve the existing validation for line-bearing markets.

**Step 4: Run tests to verify GREEN**

Run: `node --test test/browser-sports-reader.test.js`

Expected: PASS.

### Task 3: Parse verified football, basketball, and tennis DOM layouts

**Files:**
- Modify: `test/browser-sports-reader.test.js`
- Modify: `src/browser/readers/sports.js`

**Step 1: Write failing DOM-expression tests**

Build bounded synthetic event rows matching the verified `.event_even` shapes. Assert football's three-way `1x2`, basketball and tennis two-way `moneyline`, common handicap/total pairs, optional tennis odd/even, and a second `first_half` period.

**Step 2: Run tests to verify RED**

Run: `node --test test/browser-sports-reader.test.js`

Expected: FAIL because the current expression only accepts a three-odds winner cell and reads one period.

**Step 3: Implement minimal parser changes**

Parse direct `.header_info_inner` period containers, select the winner market type from the verified sport, retain the existing paired line/odds parsing, and add the verified tennis odd/even pair without reading unverified markets.

**Step 4: Run tests to verify GREEN**

Run: `node --test test/browser-sports-reader.test.js`

Expected: PASS.

### Task 4: Verify HTTP filtering and documentation

**Files:**
- Modify: `test/app.test.js`
- Modify: `README.md`
- Modify: `docs/im-sports-upstream.md`

**Step 1: Add or tighten endpoint tests**

Assert separate upstream calls and cache keys for football, basketball, and tennis across supported scopes. Confirm unknown and duplicate `sport` parameters remain rejected.

**Step 2: Run endpoint tests**

Run: `node --test test/app.test.js`

Expected: PASS after any required fixture adjustment; endpoint separation already exists and must remain stable.

**Step 3: Update documentation**

Document the independent `scope` and `sport` dimensions, verified sport keys, sport-specific market types, and the current WebSocket limitation to verified live football.

**Step 4: Run full verification**

Run: `npm run check`

Expected: exit 0.

Run: `npm test`

Expected: all tests pass with zero failures.
