'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let createFeedState;
try {
  ({ createFeedState } = require('../src/realtime/feed-state'));
} catch {
  createFeedState = undefined;
}

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
}

function snapshotFixture() {
  return readFixture('im-live-snapshot.json');
}

function deltaFixtures() {
  return readFixture('im-live-deltas.json');
}

function createReadyFeed(options = {}) {
  const feed = createFeedState(options);
  const result = feed.ingest(snapshotFixture());
  assert.deepEqual(result, { messages: [], needsResync: false });
  return feed;
}

test('ingests a snapshot and returns an immutable current snapshot', () => {
  assert.equal(typeof createFeedState, 'function');
  const feed = createReadyFeed();
  const current = feed.snapshot();

  assert.equal(current.type, 'snapshot');
  assert.equal(current.seq, 1);
  assert.equal(current.events.length, 1);
  assert.equal(Object.isFrozen(current), true);
  assert.equal(Object.isFrozen(current.events[0].markets), true);
  assert.throws(() => { current.events[0].home = 'Changed'; }, TypeError);
  assert.equal(feed.snapshot().events[0].home, 'Example Home');
});

test('action 3 fully replaces markets and emits changed selections and removals', () => {
  const feed = createReadyFeed();
  const result = feed.ingest(deltaFixtures()[0]);

  assert.equal(result.needsResync, false);
  assert.equal(result.messages.length, 8);
  assert.deepEqual(result.messages[0], {
    type: 'delta',
    event_id: '900000001',
    selection_key: 'im:900000001:8101:9101',
    decimal_odds: '1.91',
    line: '-0.5',
    available: true,
    seq: 2,
  });
  assert.equal(result.messages.at(-1).available, false);
  assert.equal(result.messages.at(-1).seq, 9);
  assert.equal(feed.snapshot().events[0].markets.length, 1);
});

test('action 4 replaces only supplied markets and marks missing selections unavailable', () => {
  const feed = createReadyFeed();
  const result = feed.ingest(deltaFixtures()[1]);

  assert.deepEqual(result.messages, [
    {
      type: 'delta',
      event_id: '900000001',
      selection_key: 'im:900000001:8101:9101',
      decimal_odds: '1.96',
      line: '-0/0.5',
      available: true,
      seq: 2,
    },
    {
      type: 'delta',
      event_id: '900000001',
      selection_key: 'im:900000001:8101:9102',
      decimal_odds: null,
      line: '+0/0.5',
      available: false,
      seq: 3,
    },
  ]);
  assert.equal(feed.snapshot().events[0].markets.length, 5);
});

test('score and clock actions emit score messages only when values change', () => {
  const feed = createReadyFeed();
  const [, , scoreDelta, clockDelta] = deltaFixtures();

  assert.deepEqual(feed.ingest(scoreDelta).messages, [{
    type: 'score',
    event_id: '900000001',
    score: '1-1',
    clock: '2H 67:21',
    seq: 2,
  }]);
  assert.deepEqual(feed.ingest(clockDelta).messages, [{
    type: 'score',
    event_id: '900000001',
    score: '1-1',
    clock: '2H 68:02',
    seq: 3,
  }]);
  assert.deepEqual(feed.ingest(clockDelta).messages, []);
});

test('verified period-score actions are accepted without inventing public fields', () => {
  const feed = createReadyFeed();
  const periodDelta = deltaFixtures()[4];
  const before = feed.snapshot();

  assert.deepEqual(feed.ingest(periodDelta), { messages: [], needsResync: false });
  assert.deepEqual(feed.snapshot(), before);
});

test('newly locked selections and empty markets emit available false once', () => {
  const feed = createReadyFeed();
  const locked = snapshotFixture().sel[0].mls[0];
  locked.il = true;
  const delta = { StatusCode: 100, dc: [{ a: 4, eid: 900000001, sid: 0, v: [locked] }] };

  const first = feed.ingest(delta);
  assert.deepEqual(first.messages.map((message) => message.available), [false, false]);
  assert.deepEqual(feed.ingest(delta).messages, []);
});

test('no-change batches update freshness without advancing sequence', () => {
  let currentTime = 1_000;
  const feed = createReadyFeed({ now: () => currentTime, staleMs: 15_000 });
  currentTime = 10_000;

  const result = feed.ingest({
    StatusCode: 100,
    dc: [{ a: 6, eid: 900000001, sid: 0, v: '2H 67:21' }],
  });

  assert.deepEqual(result.messages, []);
  assert.equal(feed.snapshot().seq, 1);
  currentTime = 24_999;
  assert.equal(feed.isStale(), false);
  currentTime = 25_001;
  assert.equal(feed.isStale(), true);
});

test('unsupported actions and invalid shapes request resync without mutation', () => {
  const feed = createReadyFeed();
  const before = feed.snapshot();

  for (const delta of [
    { StatusCode: 100, dc: [{ a: 99, eid: 900000001, sid: 0, v: 'private' }] },
    { StatusCode: 100, dc: [{ a: 5, eid: 900000001, sid: 0, v: { hs: 'bad' } }] },
    { StatusCode: 100, dc: [{ a: 6, eid: 999999999, sid: 0, v: '2H 70:00' }] },
  ]) {
    assert.deepEqual(feed.ingest(delta), { messages: [], needsResync: true });
    assert.deepEqual(feed.snapshot(), before);
    assert.equal(feed.isStale(), true);
  }
});

test('a fresh snapshot clears resync state and replaces state transactionally', () => {
  const feed = createReadyFeed();
  feed.ingest({ StatusCode: 100, dc: [{ a: 99, eid: 900000001, sid: 0, v: null }] });
  assert.equal(feed.isStale(), true);

  const replacement = snapshotFixture();
  replacement.sel[0].hs = 2;
  const result = feed.ingest(replacement);

  assert.equal(result.needsResync, false);
  assert.equal(feed.isStale(), false);
  assert.equal(feed.snapshot().events[0].score.home, 2);
});

test('disconnect invalidation makes the feed unavailable until a new snapshot', () => {
  const feed = createReadyFeed();
  feed.invalidate();
  assert.equal(feed.isStale(), true);
  assert.equal(feed.snapshot(), null);
});
