'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { WebSocket } = require('ws');

const { createFeedState } = require('../src/realtime/feed-state');

let createWsFeedServer;
try {
  ({ createWsFeedServer } = require('../src/realtime/ws-feed-server'));
} catch {
  createWsFeedServer = undefined;
}

const TOKEN = 'websocket-test-token-that-is-at-least-32-characters';
const clientMessages = new WeakMap();

function snapshotPayload() {
  return {
    StatusCode: 100,
    sel: [{
      eid: 900000001,
      m: 3,
      cn: 'Example League',
      htn: 'Example Home',
      atn: 'Example Away',
      hs: 0,
      as: 0,
      rbt: '1H 10:00',
      mls: [{
        mi: 8101,
        bti: 1,
        gp: 1,
        il: false,
        ws: [
          { wsi: 9101, si: 1, dih: '-0.5', o: 0.95, ot: 2 },
          { wsi: 9102, si: 2, dih: '+0.5', o: 0.87, ot: 2 },
        ],
      }],
    }],
  };
}

function fakeIntervals() {
  const entries = [];
  return {
    entries,
    setIntervalImpl(callback, delay) {
      const entry = { callback, delay, cleared: false };
      entries.push(entry);
      return entry;
    },
    clearIntervalImpl(entry) {
      if (entry) entry.cleared = true;
    },
    run() {
      for (const entry of entries) if (!entry.cleared) entry.callback();
    },
  };
}

async function createHarness({ ready = true, serviceOptions = {}, feedOptions = {} } = {}) {
  const feed = createFeedState(feedOptions);
  if (ready) feed.ingest(snapshotPayload());
  const diagnostics = [];
  const server = http.createServer((request, response) => {
    response.writeHead(404).end();
  });
  const service = createWsFeedServer({
    server,
    feed,
    token: TOKEN,
    onDiagnostic(value) { diagnostics.push(value); },
    ...serviceOptions,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    feed,
    server,
    service,
    diagnostics,
    baseUrl: `ws://127.0.0.1:${port}`,
    async close() {
      await service.close();
      await new Promise((resolve, reject) => server.close((error) => (
        error ? reject(error) : resolve()
      )));
    },
  };
}

function openClient(url, options) {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(url, options);
    const state = { queued: [], waiting: [] };
    clientMessages.set(client, state);
    client.on('message', (data) => {
      const waiter = state.waiting.shift();
      if (waiter) waiter(data);
      else state.queued.push(data);
    });
    client.once('open', () => resolve(client));
    client.once('error', reject);
  });
}

function nextJson(client) {
  return new Promise((resolve, reject) => {
    const consume = (data) => {
      try { resolve(JSON.parse(data.toString())); } catch (error) { reject(error); }
    };
    const state = clientMessages.get(client);
    if (state?.queued.length > 0) consume(state.queued.shift());
    else if (state) state.waiting.push(consume);
    else client.once('message', consume);
    client.once('error', reject);
  });
}

function nextClose(client) {
  return new Promise((resolve) => {
    client.once('close', (code) => resolve(code));
  });
}

function rejectedStatus(url) {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(url);
    client.once('unexpected-response', (_request, response) => {
      const { statusCode } = response;
      response.resume();
      resolve(statusCode);
    });
    client.once('open', () => reject(new Error('unexpected WebSocket connection')));
    client.once('error', () => {});
  });
}

test('accepts only the sports route with one correct token', async (t) => {
  assert.equal(typeof createWsFeedServer, 'function');
  const harness = await createHarness();
  t.after(() => harness.close());

  assert.equal(await rejectedStatus(`${harness.baseUrl}/other?token=${TOKEN}`), 404);
  assert.equal(await rejectedStatus(`${harness.baseUrl}/ws/sports`), 401);
  assert.equal(await rejectedStatus(`${harness.baseUrl}/ws/sports?token=`), 401);
  assert.equal(await rejectedStatus(`${harness.baseUrl}/ws/sports?token=wrong`), 401);
  assert.equal(
    await rejectedStatus(`${harness.baseUrl}/ws/sports?token=${TOKEN}&token=${TOKEN}`),
    401,
  );
});

test('rejects an otherwise valid connection when no fresh snapshot exists', async (t) => {
  const harness = await createHarness({ ready: false });
  t.after(() => harness.close());

  assert.equal(await rejectedStatus(`${harness.baseUrl}/ws/sports?token=${TOKEN}`), 503);
});

test('sends snapshot first and preserves later feed message order', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const client = await openClient(`${harness.baseUrl}/ws/sports?token=${TOKEN}`);
  t.after(() => client.close());

  const first = await nextJson(client);
  assert.equal(first.type, 'snapshot');
  assert.equal(first.seq, 1);
  assert.equal(first.events.length, 1);

  const updatedMessage = nextJson(client);
  harness.feed.ingest({
    StatusCode: 100,
    dc: [
      { a: 5, eid: 900000001, sid: 0, v: { hs: 1, as: 0, hrc: 0, arc: 0 } },
      { a: 6, eid: 900000001, sid: 0, v: '1H 11:00' },
    ],
  });
  const updated = await updatedMessage;

  assert.deepEqual([updated.type, updated.seq], ['score', 2]);
  assert.equal(updated.score, '1-0');
  assert.equal(updated.clock, '1H 11:00');
});

test('sends application and standard heartbeats every thirty seconds', async (t) => {
  const intervals = fakeIntervals();
  const harness = await createHarness({ serviceOptions: intervals });
  t.after(() => harness.close());
  const client = await openClient(`${harness.baseUrl}/ws/sports?token=${TOKEN}`);
  t.after(() => client.close());
  await nextJson(client);

  const appPing = nextJson(client);
  const controlPing = new Promise((resolve) => client.once('ping', resolve));
  intervals.run();

  assert.deepEqual(await appPing, { type: 'ping', seq: 2 });
  await controlPing;
  assert.equal(intervals.entries[0].delay, 30_000);
});

test('terminates a peer that does not answer standard ping frames', async (t) => {
  const intervals = fakeIntervals();
  const harness = await createHarness({ serviceOptions: intervals });
  t.after(() => harness.close());
  const client = await openClient(
    `${harness.baseUrl}/ws/sports?token=${TOKEN}`,
    { autoPong: false },
  );
  await nextJson(client);
  const closed = nextClose(client);

  intervals.run();
  await new Promise((resolve) => setImmediate(resolve));
  intervals.run();

  assert.equal(await closed, 1006);
});

test('closes clients whose outgoing buffer exceeds one megabyte', async (t) => {
  const harness = await createHarness({
    serviceOptions: { getBufferedAmount: () => 1_000_001 },
  });
  t.after(() => harness.close());
  const client = await openClient(`${harness.baseUrl}/ws/sports?token=${TOKEN}`);

  assert.equal(await nextClose(client), 1013);
});

test('closes clients with 1012 when the source becomes stale', async (t) => {
  let currentTime = 1_000;
  const intervals = fakeIntervals();
  const harness = await createHarness({
    feedOptions: { now: () => currentTime, staleMs: 15_000 },
    serviceOptions: intervals,
  });
  t.after(() => harness.close());
  const client = await openClient(`${harness.baseUrl}/ws/sports?token=${TOKEN}`);
  await nextJson(client);
  const closed = nextClose(client);

  currentTime = 16_001;
  intervals.run();

  assert.equal(await closed, 1012);
});

test('diagnostics never contain query strings or tokens', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const privateToken = 'private-token-must-not-appear';

  await rejectedStatus(`${harness.baseUrl}/ws/sports?token=${privateToken}&private=value`);
  const serialized = JSON.stringify(harness.diagnostics);
  assert.equal(serialized.includes(privateToken), false);
  assert.equal(serialized.includes('private=value'), false);
});

test('close is idempotent and detaches the HTTP upgrade listener', async () => {
  const harness = await createHarness();
  assert.equal(harness.server.listenerCount('upgrade'), 1);

  await harness.service.close();
  await harness.service.close();

  assert.equal(harness.server.listenerCount('upgrade'), 0);
  await new Promise((resolve, reject) => harness.server.close((error) => (
    error ? reject(error) : resolve()
  )));
});
