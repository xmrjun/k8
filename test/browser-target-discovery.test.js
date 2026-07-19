const test = require('node:test');
const assert = require('node:assert/strict');

let createTargetDiscovery;
try {
  ({ createTargetDiscovery } = require('../src/browser/target-discovery'));
} catch {
  createTargetDiscovery = undefined;
}

const { CODES } = require('../src/upstream/errors');

function target(url, webSocketDebuggerUrl, type = 'page') {
  return { type, url, webSocketDebuggerUrl };
}

function responseFor(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('target discovery selects only an exact allow-listed page on the CDP endpoint', async () => {
  assert.equal(typeof createTargetDiscovery, 'function');
  const calls = [];
  const discovery = createTargetDiscovery({
    cdpUrl: 'http://127.0.0.1:9223',
    pageOrigin: 'https://k81128.com',
    async fetchImpl(url, options) {
      calls.push({ url, options });
      return responseFor([
        target('https://k81128.com.evil.example/', 'ws://127.0.0.1:9223/devtools/page/evil'),
        target('https://k81128.com/', 'ws://127.0.0.1:9223/devtools/page/allowed'),
      ]);
    },
  });

  const result = await discovery.discover();

  assert.equal(result.webSocketDebuggerUrl, 'ws://127.0.0.1:9223/devtools/page/allowed');
  assert.equal(calls[0].url, 'http://127.0.0.1:9223/json/list');
  assert.equal(calls[0].options.redirect, 'error');
});

test('target discovery separates same-origin pages by exact pathname', async () => {
  const discovery = createTargetDiscovery({
    cdpUrl: 'http://127.0.0.1:9223',
    pageOrigin: 'https://sports.example.test:2053',
    pagePathname: '/popup/',
    async fetchImpl() {
      return responseFor([
        target('https://sports.example.test:2053/?token=private', 'ws://127.0.0.1:9223/devtools/page/main'),
        target('https://sports.example.test:2053/popup/?token=private', 'ws://127.0.0.1:9223/devtools/page/popup'),
      ]);
    },
  });

  const result = await discovery.discover();

  assert.equal(result.webSocketDebuggerUrl, 'ws://127.0.0.1:9223/devtools/page/popup');
  assert.equal(discovery.pagePathname, '/popup/');
  assert.equal(JSON.stringify(discovery).includes('token=private'), false);
});

test('target discovery rejects unsafe configuration before fetching', () => {
  let fetched = false;
  assert.throws(() => createTargetDiscovery({
    cdpUrl: 'http://192.168.1.10:9223',
    pageOrigin: 'https://k81128.com',
    async fetchImpl() {
      fetched = true;
      return responseFor([]);
    },
  }), /loopback/);
  assert.equal(fetched, false);

  assert.throws(() => createTargetDiscovery({
    cdpUrl: 'http://127.0.0.1:9223',
    pageOrigin: 'https://k81128.com/path',
  }), /valid https origin/);

  for (const pagePathname of [
    'popup/',
    '/popup/?token=private',
    '/popup/#tab',
    'https://sports.example.test/popup/',
    '/popup\\records',
  ]) {
    assert.throws(() => createTargetDiscovery({
      cdpUrl: 'http://127.0.0.1:9223',
      pageOrigin: 'https://k81128.com',
      pagePathname,
    }), /Page pathname must be an absolute path without query or fragment/);
  }
});

test('target discovery rejects a debugger URL on another host', async () => {
  const discovery = createTargetDiscovery({
    cdpUrl: 'http://127.0.0.1:9223',
    pageOrigin: 'https://k81128.com',
    async fetchImpl() {
      return responseFor([
        target('https://k81128.com/', 'ws://attacker.example/devtools/page/private'),
      ]);
    },
  });

  await assert.rejects(
    discovery.discover(),
    (error) => error.code === CODES.BROWSER_UNAVAILABLE && !error.cause,
  );
});

test('target discovery bounds and validates the target list response', async () => {
  const oversized = createTargetDiscovery({
    cdpUrl: 'http://127.0.0.1:9223',
    pageOrigin: 'https://k81128.com',
    maxDiscoveryBytes: 8,
    async fetchImpl() {
      return responseFor([{ private: 'x'.repeat(100) }]);
    },
  });
  await assert.rejects(
    oversized.discover(),
    (error) => error.code === CODES.BAD_RESPONSE && !error.cause,
  );

  const malformed = createTargetDiscovery({
    cdpUrl: 'http://127.0.0.1:9223',
    pageOrigin: 'https://k81128.com',
    async fetchImpl() {
      return new Response('{', { status: 200 });
    },
  });
  await assert.rejects(
    malformed.discover(),
    (error) => error.code === CODES.BAD_RESPONSE && !error.cause,
  );
});

test('target discovery errors never retain private target details', async () => {
  const privateUrl = 'https://k81128.com/private?token=must-not-leak';
  const discovery = createTargetDiscovery({
    cdpUrl: 'http://127.0.0.1:9223',
    pageOrigin: 'https://k81128.com',
    async fetchImpl() {
      throw new Error(privateUrl);
    },
  });

  await assert.rejects(discovery.discover(), (error) => (
    error.code === CODES.BROWSER_UNAVAILABLE
      && !error.cause
      && !JSON.stringify(error).includes(privateUrl)
  ));
});
