const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadConfig, publicConfig } = require('../src/config');

function withEnv(overrides, callback) {
  const original = { ...process.env };

  try {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, overrides);
    return callback();
  } finally {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, original);
  }
}

test('loadConfig requires API_TOKEN', () => {
  withEnv({}, () => {
    assert.throws(() => loadConfig(), /API_TOKEN is required/);
  });
});

test('loadConfig rejects API_TOKEN values shorter than 32 characters', () => {
  withEnv({ API_TOKEN: 'too-short' }, () => {
    assert.throws(() => loadConfig(), /API_TOKEN must be at least 32 characters/);
  });
});

test('loadConfig defaults to the loopback Chrome browser bridge', () => {
  withEnv({ API_TOKEN: 'a'.repeat(32) }, () => {
    assert.deepEqual(loadConfig(), {
      host: '127.0.0.1',
      port: 8788,
      apiToken: 'a'.repeat(32),
      upstreamMode: 'browser',
      upstreamBaseUrl: '',
      upstreamCredential: '',
      sportsCacheMs: 5000,
      browserTransport: 'apple_events',
      browserCdpUrl: 'http://127.0.0.1:9223',
      browserPageOrigin: 'https://k81128.com',
      browserSportsOrigin: 'https://imsb-fxnag.utoyen.com:2053',
      browserOperationTimeoutMs: 15000,
    });
  });
});

test('loadConfig reads all configuration from process.env', () => {
  withEnv({
    API_TOKEN: 'b'.repeat(32),
    HOST: '127.0.0.2',
    PORT: '9000',
    UPSTREAM_BASE_URL: 'https://api.example.test/v1',
    UPSTREAM_CREDENTIAL: 'upstream-secret',
    UPSTREAM_MODE: 'http',
    SPORTS_CACHE_MS: '2500',
    BROWSER_TRANSPORT: 'cdp',
    BROWSER_CDP_URL: 'http://[::1]:9333',
    BROWSER_PAGE_ORIGIN: 'https://K81128.com',
    BROWSER_SPORTS_ORIGIN: 'https://IMSB-FXNAG.UTOYEN.COM:2053',
    BROWSER_OPERATION_TIMEOUT_MS: '9000',
  }, () => {
    assert.deepEqual(loadConfig(), {
      host: '127.0.0.2',
      port: 9000,
      apiToken: 'b'.repeat(32),
      upstreamMode: 'http',
      upstreamBaseUrl: 'https://api.example.test/v1',
      upstreamCredential: 'upstream-secret',
      sportsCacheMs: 2500,
      browserTransport: 'cdp',
      browserCdpUrl: 'http://[::1]:9333',
      browserPageOrigin: 'https://k81128.com',
      browserSportsOrigin: 'https://imsb-fxnag.utoyen.com:2053',
      browserOperationTimeoutMs: 9000,
    });
  });
});

test('publicConfig exposes only non-secret diagnostics', () => {
  const apiToken = 'private-api-token-that-is-long-enough';
  const upstreamCredential = 'private-upstream-credential';

  withEnv({
    API_TOKEN: apiToken,
    UPSTREAM_BASE_URL: 'https://api.example.test/v1/resources',
    UPSTREAM_CREDENTIAL: upstreamCredential,
  }, () => {
    const diagnostics = publicConfig();
    const serialized = JSON.stringify(diagnostics);

    assert.deepEqual(diagnostics, {
      host: '127.0.0.1',
      port: 8788,
      upstreamMode: 'browser',
      upstreamOrigin: 'https://api.example.test',
      sportsCacheMs: 5000,
      browserTransport: 'apple_events',
      browserPageOrigin: 'https://k81128.com',
      browserSportsOrigin: 'https://imsb-fxnag.utoyen.com:2053',
      browserOperationTimeoutMs: 15000,
    });
    assert.equal(serialized.includes(apiToken), false);
    assert.equal(serialized.includes(upstreamCredential), false);
    assert.equal(Object.hasOwn(diagnostics, 'apiToken'), false);
    assert.equal(Object.hasOwn(diagnostics, 'upstreamCredential'), false);
  });
});

for (const browserTransport of ['unknown', '', 'APPLE_EVENTS']) {
  test(`loadConfig rejects invalid BROWSER_TRANSPORT ${JSON.stringify(browserTransport)}`, () => {
    withEnv({
      API_TOKEN: 'a'.repeat(32),
      BROWSER_TRANSPORT: browserTransport,
    }, () => {
      assert.throws(
        () => loadConfig(),
        /BROWSER_TRANSPORT must be apple_events or cdp/,
      );
    });
  });
}

for (const upstreamMode of ['unknown', '', 'BROWSER']) {
  test(`loadConfig rejects invalid UPSTREAM_MODE ${JSON.stringify(upstreamMode)}`, () => {
    withEnv({ API_TOKEN: 'a'.repeat(32), UPSTREAM_MODE: upstreamMode }, () => {
      assert.throws(() => loadConfig(), /UPSTREAM_MODE must be browser, http, or disabled/);
    });
  });
}

for (const browserCdpUrl of [
  'http://0.0.0.0:9223',
  'http://192.168.1.10:9223',
  'https://127.0.0.1:9223',
  'not a URL',
]) {
  test(`loadConfig rejects unsafe BROWSER_CDP_URL ${browserCdpUrl}`, () => {
    withEnv({ API_TOKEN: 'a'.repeat(32), BROWSER_CDP_URL: browserCdpUrl }, () => {
      assert.throws(
        () => loadConfig(),
        /BROWSER_CDP_URL must be an http URL on a loopback IP address/,
      );
    });
  });
}

for (const browserPageOrigin of [
  'http://k81128.com',
  'file:///tmp/k81128',
  'not a URL',
  'https://k81128.com/sports',
  'https://k81128.com?token=must-not-be-configured',
  'https://k81128.com/#sports',
]) {
  test(`loadConfig rejects unsafe BROWSER_PAGE_ORIGIN ${browserPageOrigin}`, () => {
    withEnv({ API_TOKEN: 'a'.repeat(32), BROWSER_PAGE_ORIGIN: browserPageOrigin }, () => {
      assert.throws(
        () => loadConfig(),
        /BROWSER_PAGE_ORIGIN must be a valid https origin without path, query, or fragment/,
      );
    });
  });
}

for (const browserSportsOrigin of [
  'http://imsb.example.test:2053',
  'file:///tmp/imsb',
  'not a URL',
  'https://user:secret@imsb.example.test:2053',
  'https://imsb.example.test:2053/sports',
  'https://imsb.example.test:2053?token=must-not-be-configured',
  'https://imsb.example.test:2053/#sports',
]) {
  test(`loadConfig rejects unsafe BROWSER_SPORTS_ORIGIN ${browserSportsOrigin}`, () => {
    withEnv({
      API_TOKEN: 'a'.repeat(32),
      BROWSER_SPORTS_ORIGIN: browserSportsOrigin,
    }, () => {
      assert.throws(
        () => loadConfig(),
        /BROWSER_SPORTS_ORIGIN must be a valid https origin without path, query, or fragment/,
      );
    });
  });
}

for (const timeoutMs of ['0', '-1', '1.5', 'Infinity', 'not-a-number']) {
  test(`loadConfig rejects invalid BROWSER_OPERATION_TIMEOUT_MS ${timeoutMs}`, () => {
    withEnv({
      API_TOKEN: 'a'.repeat(32),
      BROWSER_OPERATION_TIMEOUT_MS: timeoutMs,
    }, () => {
      assert.throws(
        () => loadConfig(),
        /BROWSER_OPERATION_TIMEOUT_MS must be a positive integer/,
      );
    });
  });
}

test('.env.example cannot provide an accepted API token when copied unchanged', () => {
  const example = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  const tokenLine = example.split('\n').find((line) => line.startsWith('API_TOKEN='));
  const token = tokenLine.slice('API_TOKEN='.length);

  assert.ok(token.length < 32);
});

for (const port of ['0', '65536', '1.5', 'not-a-number']) {
  test(`loadConfig rejects invalid PORT ${port}`, () => {
    withEnv({ API_TOKEN: 'a'.repeat(32), PORT: port }, () => {
      assert.throws(() => loadConfig(), /PORT must be an integer between 1 and 65535/);
    });
  });
}

for (const cacheMs of ['-1', '1.5', 'Infinity', 'not-a-number']) {
  test(`loadConfig rejects invalid SPORTS_CACHE_MS ${cacheMs}`, () => {
    withEnv({ API_TOKEN: 'a'.repeat(32), SPORTS_CACHE_MS: cacheMs }, () => {
      assert.throws(() => loadConfig(), /SPORTS_CACHE_MS must be a non-negative integer/);
    });
  });
}

test('loadConfig rejects a malformed UPSTREAM_BASE_URL', () => {
  withEnv({ API_TOKEN: 'a'.repeat(32), UPSTREAM_BASE_URL: 'not a URL' }, () => {
    assert.throws(() => loadConfig(), /UPSTREAM_BASE_URL must be a valid URL/);
  });
});

test('loadConfig rejects a non-HTTP UPSTREAM_BASE_URL', () => {
  withEnv({ API_TOKEN: 'a'.repeat(32), UPSTREAM_BASE_URL: 'file:///tmp/upstream' }, () => {
    assert.throws(
      () => loadConfig(),
      /UPSTREAM_BASE_URL must use http: or https:/,
    );
  });
});

test('loadConfig normalizes UPSTREAM_BASE_URL', () => {
  withEnv({
    API_TOKEN: 'a'.repeat(32),
    UPSTREAM_BASE_URL: 'https://API.Example.Test:443/v1',
  }, () => {
    assert.equal(loadConfig().upstreamBaseUrl, 'https://api.example.test/v1');
  });
});
