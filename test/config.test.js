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

test('loadConfig uses loopback, port 8788, and a five-second cache by default', () => {
  withEnv({ API_TOKEN: 'a'.repeat(32) }, () => {
    assert.deepEqual(loadConfig(), {
      host: '127.0.0.1',
      port: 8788,
      apiToken: 'a'.repeat(32),
      upstreamBaseUrl: '',
      upstreamCredential: '',
      sportsCacheMs: 5000,
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
    SPORTS_CACHE_MS: '2500',
  }, () => {
    assert.deepEqual(loadConfig(), {
      host: '127.0.0.2',
      port: 9000,
      apiToken: 'b'.repeat(32),
      upstreamBaseUrl: 'https://api.example.test/v1',
      upstreamCredential: 'upstream-secret',
      sportsCacheMs: 2500,
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
      upstreamOrigin: 'https://api.example.test',
      sportsCacheMs: 5000,
    });
    assert.equal(serialized.includes(apiToken), false);
    assert.equal(serialized.includes(upstreamCredential), false);
    assert.equal(Object.hasOwn(diagnostics, 'apiToken'), false);
    assert.equal(Object.hasOwn(diagnostics, 'upstreamCredential'), false);
  });
});

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
