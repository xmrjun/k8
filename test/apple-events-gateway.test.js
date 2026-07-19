'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createAppleEventsGateway } = require('../src/browser/apple-events-gateway');
const { CODES } = require('../src/upstream/errors');

const HELPER_PATH = path.resolve(__dirname, '..', 'scripts', 'chrome-evaluate.jxa');

test('gateway invokes the fixed JXA helper without a shell and decodes its JSON value', async () => {
  const calls = [];
  const controller = new AbortController();
  const gateway = createAppleEventsGateway({
    pageOrigin: 'https://K81128.com',
    async runImpl(command, args, options) {
      calls.push({ command, args, options });
      return { exitCode: 0, stdout: '{"status":"ready"}' };
    },
  });

  const value = await gateway.evaluate('({ status: "ready" })', {
    signal: controller.signal,
  });

  assert.deepEqual(value, { status: 'ready' });
  assert.deepEqual(calls, [{
    command: '/usr/bin/osascript',
    args: [
      '-l',
      'JavaScript',
      HELPER_PATH,
      'https://k81128.com',
      '/',
      '({ status: "ready" })',
    ],
    options: {
      signal: controller.signal,
      maxOutputBytes: 1_000_000,
    },
  }]);
  assert.equal(Object.hasOwn(calls[0].options, 'shell'), false);
});

test('gateway passes a separately validated pathname to the helper', async () => {
  const calls = [];
  const gateway = createAppleEventsGateway({
    pageOrigin: 'https://sports.example.test:2053',
    pagePathname: '/popup/',
    async runImpl(_command, args) {
      calls.push(args);
      return { exitCode: 0, stdout: 'true' };
    },
  });

  await gateway.evaluate('true');

  assert.deepEqual(calls[0].slice(-3), [
    'https://sports.example.test:2053',
    '/popup/',
    'true',
  ]);
});

for (const pagePathname of ['popup/', '/popup/?token=private', '/popup/#tab']) {
  test(`gateway rejects an unsafe page pathname: ${pagePathname}`, () => {
    assert.throws(
      () => createAppleEventsGateway({
        pageOrigin: 'https://k81128.com',
        pagePathname,
      }),
      /Page pathname must be an absolute path without query or fragment/,
    );
  });
}

for (const pageOrigin of [
  'http://k81128.com',
  'file:///tmp/k81128',
  'https://user:secret@k81128.com',
  'https://k81128.com/sports',
  'https://k81128.com?token=must-not-be-configured',
  'https://k81128.com/#sports',
]) {
  test(`gateway rejects an unsafe page origin: ${pageOrigin}`, () => {
    assert.throws(
      () => createAppleEventsGateway({ pageOrigin }),
      /valid https origin without path, query, or fragment/,
    );
  });
}

test('gateway rejects empty and oversized expressions before starting a process', async () => {
  let calls = 0;
  const gateway = createAppleEventsGateway({
    pageOrigin: 'https://k81128.com',
    maxExpressionBytes: 8,
    async runImpl() {
      calls += 1;
      return { exitCode: 0, stdout: 'null' };
    },
  });

  await assert.rejects(gateway.evaluate(''), /non-empty string/);
  await assert.rejects(gateway.evaluate('x'.repeat(9)), /too large/);
  assert.equal(calls, 0);
});

test('gateway rejects oversized output before parsing it', async () => {
  const gateway = createAppleEventsGateway({
    pageOrigin: 'https://k81128.com',
    maxResponseBytes: 8,
    async runImpl() {
      return { exitCode: 0, stdout: '"12345678"' };
    },
  });

  await assert.rejects(
    gateway.evaluate('1'),
    (error) => error.code === CODES.BAD_RESPONSE && !error.cause,
  );
});

test('gateway maps malformed helper output to a sanitized bad response', async () => {
  const gateway = createAppleEventsGateway({
    pageOrigin: 'https://k81128.com',
    async runImpl() {
      return { exitCode: 0, stdout: 'not-json-private-page-data' };
    },
  });

  await assert.rejects(
    gateway.evaluate('1'),
    (error) => error.code === CODES.BAD_RESPONSE
      && !error.cause
      && !JSON.stringify(error).includes('private-page-data'),
  );
});

test('gateway maps helper and permission failures without retaining private details', async () => {
  const privateFailure = new Error('token=must-not-survive');
  const thrownGateway = createAppleEventsGateway({
    pageOrigin: 'https://k81128.com',
    async runImpl() { throw privateFailure; },
  });
  const exitedGateway = createAppleEventsGateway({
    pageOrigin: 'https://k81128.com',
    async runImpl() {
      return { exitCode: 1, stdout: 'private-browser-output' };
    },
  });

  for (const gateway of [thrownGateway, exitedGateway]) {
    await assert.rejects(
      gateway.evaluate('1'),
      (error) => error.code === CODES.BROWSER_UNAVAILABLE
        && !error.cause
        && !JSON.stringify(error).includes('private'),
    );
  }
});

test('gateway status is limited to page availability and close is a no-op', async () => {
  let available = true;
  const gateway = createAppleEventsGateway({
    pageOrigin: 'https://k81128.com',
    async runImpl() {
      if (!available) throw new Error('denied');
      return { exitCode: 0, stdout: 'true' };
    },
  });

  assert.equal(await gateway.status(), 'page_found');
  available = false;
  assert.equal(await gateway.status(), 'unavailable');
  assert.equal(await gateway.close(), undefined);
});
