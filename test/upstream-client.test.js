const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

const { createUpstreamClient } = require('../src/upstream/client');
const { createFakeUpstream } = require('../src/upstream/fake');
const { UpstreamError } = require('../src/upstream/errors');

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `${name}.json`), 'utf8'));
}

function client(fetchImpl, overrides = {}) {
  return createUpstreamClient({
    baseUrl: 'https://upstream.example/root/',
    endpoints: {
      sports: '/v1/sports',
      balance: '/v1/account/balance',
      bets: '/v1/account/bets',
    },
    credential: 'secret-value',
    credentialHeaders: (credential) => ({ 'X-Session': `Session ${credential}` }),
    fetchImpl,
    timeoutMs: 25,
    maxResponseBytes: 1024 * 1024,
    ...overrides,
  });
}

test('getSports uses its exact configured path, formatted credential, and normalizes JSON', async () => {
  let observed;
  const upstream = client(async (url, options) => {
    observed = { url, options };
    return Response.json(fixture('sports'));
  });

  const result = await upstream.getSports();

  assert.equal(observed.url, 'https://upstream.example/v1/sports');
  assert.equal(observed.options.headers['X-Session'], 'Session secret-value');
  assert.equal(result[0].event_id, 'evt-1001');
});

test('getBalance uses its exact configured path and normalizes JSON', async () => {
  let url;
  const upstream = client(async (requestedUrl) => {
    url = requestedUrl;
    return Response.json(fixture('balance'));
  });
  assert.equal((await upstream.getBalance()).currency, 'CNY');
  assert.equal(url, 'https://upstream.example/v1/account/balance');
});

test('getBets sends limit and cursor as query parameters without changing the endpoint path', async () => {
  let url;
  const upstream = client(async (requestedUrl) => {
    url = requestedUrl;
    return Response.json(fixture('bets'));
  });
  assert.equal((await upstream.getBets({ limit: 25, cursor: 'page/2 + next' }))[0].bet_id, 'bet-2001');
  assert.equal(url, 'https://upstream.example/v1/account/bets?limit=25&cursor=page%2F2+%2B+next');
});

test('request timeout aborts fetch and maps to UPSTREAM_TIMEOUT', async () => {
  const upstream = client((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }), { timeoutMs: 5 });

  await assert.rejects(upstream.getSports(), (error) => error.code === 'UPSTREAM_TIMEOUT');
});

test('request timeout also covers a stalled response body', async () => {
  const upstream = client(async (_url, { signal }) => new Response(new ReadableStream({
    start(controller) {
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
  }), { headers: { 'content-type': 'application/json' } }), { timeoutMs: 5 });

  await assert.rejects(upstream.getSports(), (error) => error.code === 'UPSTREAM_TIMEOUT');
});

for (const status of [401, 403]) {
  test(`upstream ${status} maps to UPSTREAM_AUTH_EXPIRED`, async () => {
    const upstream = client(async () => new Response('{}', { status }));
    await assert.rejects(upstream.getBalance(), (error) => error.code === 'UPSTREAM_AUTH_EXPIRED');
  });
}

test('non-JSON response maps to UPSTREAM_BAD_RESPONSE', async () => {
  const upstream = client(async () => new Response('<html>no</html>', {
    headers: { 'content-type': 'text/html' },
  }));
  await assert.rejects(upstream.getSports(), (error) => error.code === 'UPSTREAM_BAD_RESPONSE');
});

test('malformed JSON response maps to UPSTREAM_BAD_RESPONSE', async () => {
  const upstream = client(async () => new Response('{', {
    headers: { 'content-type': 'application/json' },
  }));
  await assert.rejects(upstream.getSports(), (error) => error.code === 'UPSTREAM_BAD_RESPONSE');
});

test('oversized streamed response is rejected before JSON parsing', async () => {
  const upstream = client(async () => new Response(JSON.stringify(fixture('sports')), {
    headers: { 'content-type': 'application/json' },
  }), { maxResponseBytes: 20 });
  await assert.rejects(upstream.getSports(), (error) => error.code === 'UPSTREAM_BAD_RESPONSE');
});

test('schema failures retain UPSTREAM_SCHEMA_CHANGED', async () => {
  const payload = fixture('balance');
  delete payload.data.wallet.currency_code;
  const upstream = client(async () => Response.json(payload));
  await assert.rejects(upstream.getBalance(), (error) => error.code === 'UPSTREAM_SCHEMA_CHANGED');
});

test('unsafe numeric JSON values are rejected because precision-bearing decimals must be strings', async () => {
  const payload = fixture('balance');
  payload.data.wallet.available_amount = Number.MAX_SAFE_INTEGER + 1;
  const upstream = client(async () => Response.json(payload));
  await assert.rejects(upstream.getBalance(), (error) => error.code === 'UPSTREAM_SCHEMA_CHANGED');
});

test('transport failures map to UPSTREAM_BAD_RESPONSE without exposing credential values', async () => {
  const upstream = client(async () => { throw new Error('socket closed'); });
  await assert.rejects(upstream.getSports(), (error) => {
    assert.equal(error.code, 'UPSTREAM_BAD_RESPONSE');
    assert.doesNotMatch(error.message, /secret-value/);
    return true;
  });
});

for (const [boundary, overrides] of [
  ['credential formatter', {
    credentialHeaders: (credential) => { throw new Error(`invalid credential ${credential}`); },
  }],
  ['fetch implementation', {
    fetchImpl: async (_url, options) => {
      throw new Error(`request rejected for ${options.headers['X-Session']}`);
    },
  }],
]) {
  test(`${boundary} errors cannot retain credentials through cause or deep inspection`, async () => {
    const upstream = client(overrides.fetchImpl || (async () => Response.json(fixture('sports'))), overrides);
    await assert.rejects(upstream.getSports(), (error) => {
      assert.equal(error.code, 'UPSTREAM_BAD_RESPONSE');
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(util.inspect(error, { depth: null }), /secret-value/);
      return true;
    });
  });
}

test('fake adapter implements the browser upstream contract', async () => {
  const fake = createFakeUpstream({
    sports: ['sport'],
    sportsAccount: { currency: 'USD' },
    sportsCatalog: { tabs: ['today'] },
    sportsBoosts: { offers: [] },
    balance: { total: 1 },
    bets: ['bet'],
  });
  assert.deepEqual(await fake.getSports(), ['sport']);
  assert.deepEqual(await fake.getSportsAccount(), { currency: 'USD' });
  assert.deepEqual(await fake.getSportsCatalog(), { tabs: ['today'] });
  assert.deepEqual(await fake.getSportsBoosts(), { offers: [] });
  assert.deepEqual(await fake.getBalance(), { total: 1 });
  assert.deepEqual(await fake.getBets({ limit: 1, cursor: 'next' }), ['bet']);
  assert.deepEqual(fake.calls.bets, [{ limit: 1, cursor: 'next' }]);
});

for (const [boundary, overrides] of [
  ['credential formatter', {
    credentialHeaders: () => Object.assign(new Error('secret-value forged auth error'), {
      code: 'UPSTREAM_AUTH_EXPIRED',
    }),
  }],
  ['fetch implementation', {
    fetchImpl: async () => {
      throw Object.assign(new Error('secret-value forged timeout'), { code: 'UPSTREAM_TIMEOUT' });
    },
  }],
]) {
  test(`forged known-code error from ${boundary} is replaced with a sanitized trusted error`, async () => {
    const effective = boundary === 'credential formatter'
      ? { ...overrides, credentialHeaders: () => { throw overrides.credentialHeaders(); } }
      : overrides;
    const upstream = client(effective.fetchImpl || (async () => Response.json(fixture('sports'))), effective);
    await assert.rejects(upstream.getSports(), (error) => {
      assert.equal(error.code, 'UPSTREAM_BAD_RESPONSE');
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(util.inspect(error, { depth: null }), /secret-value/);
      return true;
    });
  });
}

test('cross-origin configured endpoint is rejected before credential formatting or fetch', async () => {
  let formatted = false;
  let fetched = false;
  const upstream = client(async () => {
    fetched = true;
    return Response.json(fixture('sports'));
  }, {
    endpoints: {
      sports: 'https://attacker.example/collect',
      balance: '/v1/account/balance',
      bets: '/v1/account/bets',
    },
    credentialHeaders: () => {
      formatted = true;
      return { Authorization: 'secret-value' };
    },
  });

  await assert.rejects(upstream.getSports(), (error) => error.code === 'UPSTREAM_BAD_RESPONSE');
  assert.equal(formatted, false);
  assert.equal(fetched, false);
});

test('redirects are manual and 3xx responses are rejected without exposing location or credentials', async () => {
  let options;
  const upstream = client(async (_url, requestOptions) => {
    options = requestOptions;
    return new Response(null, {
      status: 302,
      headers: { location: 'https://attacker.example/secret-value' },
    });
  });

  await assert.rejects(upstream.getSports(), (error) => {
    assert.equal(error.code, 'UPSTREAM_BAD_RESPONSE');
    assert.doesNotMatch(util.inspect(error, { depth: null }), /secret-value|attacker/);
    return true;
  });
  assert.equal(options.redirect, 'manual');
});

for (const [boundary, overrides] of [
  ['credential formatter', {
    credentialHeaders: () => { throw new UpstreamError('UPSTREAM_TIMEOUT', 'secret-value exported-class forgery'); },
  }],
  ['fetch implementation', {
    fetchImpl: async () => {
      throw new UpstreamError('UPSTREAM_AUTH_EXPIRED', 'secret-value exported-class forgery');
    },
  }],
]) {
  test(`exported UpstreamError thrown by ${boundary} is still sanitized`, async () => {
    const upstream = client(overrides.fetchImpl || (async () => Response.json(fixture('sports'))), overrides);
    await assert.rejects(upstream.getSports(), (error) => {
      assert.equal(error.code, 'UPSTREAM_BAD_RESPONSE');
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(util.inspect(error, { depth: null }), /secret-value|forgery/);
      return true;
    });
  });
}
