'use strict';

// The live (滚球) feed is delta-only: it never sends a `sel` snapshot and
// bootstraps from `a:0` add-event entries. These tests cover that path plus the
// added remove / metadata / ignored-action handling.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createFeedState } = require('../src/realtime/feed-state');

function liveEvent() {
  const snapshot = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'im-live-snapshot.json'), 'utf8'),
  );
  return snapshot.sel[0];
}

function addDelta(event = liveEvent()) {
  return { StatusCode: 100, dc: [{ a: 0, eid: event.eid, sid: 1, v: [event] }] };
}

test('a delta of a:0 add-events bootstraps the feed with no prior snapshot', () => {
  const feed = createFeedState();
  const result = feed.ingest(addDelta());

  assert.deepEqual(result, { messages: [], needsResync: false });
  const snapshot = feed.snapshot();
  assert.equal(snapshot.type, 'snapshot');
  assert.equal(snapshot.seq, 1);
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].home, 'Example Home');
  assert.equal(feed.isStale(), false);
});

test('after an a:0 bootstrap, score/market deltas apply normally', () => {
  const feed = createFeedState();
  feed.ingest(addDelta());

  const scored = feed.ingest({
    StatusCode: 100,
    dc: [{ a: 5, eid: 900000001, sid: 1, v: { hs: 2, as: 0, hrc: 0, arc: 0 } }],
  });
  assert.equal(scored.messages.length, 1);
  assert.equal(scored.messages[0].type, 'score');
  assert.equal(scored.messages[0].score, '2-0');
});

test('a:1 removes an event from the feed', () => {
  const feed = createFeedState();
  feed.ingest(addDelta());
  assert.equal(feed.snapshot().events.length, 1);

  const removed = feed.ingest({ StatusCode: 100, dc: [{ a: 1, eid: 900000001, sid: 1 }] });
  assert.equal(removed.needsResync, false);
  assert.equal(feed.snapshot().events.length, 0);
});

test('a:2 merges event metadata (team / league names)', () => {
  const feed = createFeedState();
  feed.ingest(addDelta());

  const result = feed.ingest({
    StatusCode: 100,
    dc: [{ a: 2, eid: 900000001, sid: 1, v: { htn: 'Renamed Home', cn: 'Renamed League' } }],
  });
  assert.equal(result.needsResync, false);
  assert.equal(feed.snapshot().events[0].home, 'Renamed Home');
  assert.equal(feed.snapshot().events[0].league, 'Renamed League');
});

test('auxiliary actions 10/14/15 are ignored without resync or mutation', () => {
  const feed = createFeedState();
  feed.ingest(addDelta());
  const before = feed.snapshot();

  for (const entry of [
    { a: 10, eid: 900000001, sid: 1, v: 1 },
    { a: 14, eid: 900000001, sid: 1, v: { hcnr: true, c15mhs: 0, c15mas: 0 } },
    { a: 15, eid: 900000001, sid: 1, v: [{ gp: 1, btids: [6, 7] }] },
  ]) {
    assert.deepEqual(feed.ingest({ StatusCode: 100, dc: [entry] }), { messages: [], needsResync: false });
  }
  assert.deepEqual(feed.snapshot(), before);
  assert.equal(feed.isStale(), false);
});

test('an update batch with no add on a not-ready feed requests resync', () => {
  const feed = createFeedState();
  const result = feed.ingest({
    StatusCode: 100,
    dc: [{ a: 5, eid: 900000001, sid: 1, v: { hs: 1, as: 0, hrc: 0, arc: 0 } }],
  });
  assert.deepEqual(result, { messages: [], needsResync: true });
  assert.equal(feed.snapshot(), null);
});

test('a:0 for a non-live event (m !== 3) is tracked as ignored, later deltas skipped', () => {
  const event = liveEvent();
  event.m = 2; // not a live football event
  const feed = createFeedState();
  const boot = feed.ingest(addDelta(event));
  assert.equal(boot.needsResync, false);
  assert.equal(feed.snapshot().events.length, 0);

  // A later score delta for that ignored event must be skipped, not resynced.
  const later = feed.ingest({
    StatusCode: 100,
    dc: [{ a: 5, eid: 900000001, sid: 1, v: { hs: 1, as: 0, hrc: 0, arc: 0 } }],
  });
  assert.deepEqual(later, { messages: [], needsResync: false });
});

test('a new event can be added live via a:0 after the initial bootstrap', () => {
  const feed = createFeedState();
  feed.ingest(addDelta());

  const second = liveEvent();
  second.eid = 900000009;
  const result = feed.ingest(addDelta(second));
  assert.equal(result.needsResync, false);
  // The new event's selections surface as fresh delta messages.
  assert.ok(result.messages.length > 0);
  assert.equal(feed.snapshot().events.length, 2);
});
