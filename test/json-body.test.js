'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const {
  JsonBodyError,
  readJsonBody,
} = require('../src/json-body');

function bodyStream(chunks, headers = { 'content-type': 'application/json' }) {
  const request = Readable.from(chunks);
  request.headers = headers;
  return request;
}

function assertBodyError(code) {
  return (error) => error instanceof JsonBodyError
    && error.name === 'JsonBodyError'
    && error.code === code
    && error.message === code
    && !Object.hasOwn(error, 'body');
}

test('reads a valid JSON body from a real readable stream', async () => {
  const request = bodyStream(['{"value":', '42}']);

  assert.deepEqual(await readJsonBody(request), { value: 42 });
  assert.equal(JsonBodyError.prototype instanceof Error, true);
});

test('accepts case-insensitive JSON media type with optional UTF-8 charset', async () => {
  for (const contentType of [
    'Application/JSON',
    'APPLICATION/JSON; CHARSET=UTF-8',
    'application/json ; charset = "utf-8"',
  ]) {
    const request = bodyStream(['{"ok":true}'], {
      'content-type': contentType,
      'content-length': '11',
    });
    assert.deepEqual(await readJsonBody(request), { ok: true });
  }
});

for (const [name, headers, code] of [
  ['missing content type', {}, 'UNSUPPORTED_MEDIA_TYPE'],
  ['another media type', { 'content-type': 'text/plain' }, 'UNSUPPORTED_MEDIA_TYPE'],
  ['unsupported charset', { 'content-type': 'application/json; charset=utf-16' }, 'UNSUPPORTED_CHARSET'],
  ['unknown media parameter', { 'content-type': 'application/json; version=1' }, 'UNSUPPORTED_MEDIA_TYPE'],
  ['empty content length', { 'content-type': 'application/json', 'content-length': '' }, 'INVALID_CONTENT_LENGTH'],
  ['negative content length', { 'content-type': 'application/json', 'content-length': '-1' }, 'INVALID_CONTENT_LENGTH'],
  ['non-numeric content length', { 'content-type': 'application/json', 'content-length': '12x' }, 'INVALID_CONTENT_LENGTH'],
  ['conflicting content length', { 'content-type': 'application/json', 'content-length': ['2', '3'] }, 'INVALID_CONTENT_LENGTH'],
  ['oversized declared length', { 'content-type': 'application/json', 'content-length': '8193' }, 'PAYLOAD_TOO_LARGE'],
]) {
  test(`rejects ${name} before reading the body`, async () => {
    let reads = 0;
    const request = new Readable({
      read() {
        reads += 1;
        this.push('{"private":"secret"}');
        this.push(null);
      },
    });
    request.headers = headers;

    await assert.rejects(readJsonBody(request), assertBodyError(code));
    assert.equal(reads, 0);
  });
}

test('accepts a streamed body exactly at the configured byte limit', async () => {
  const json = `"${'x'.repeat(8190)}"`;
  assert.equal(Buffer.byteLength(json), 8192);

  assert.equal(await readJsonBody(bodyStream([json])), JSON.parse(json));
});

test('rejects an oversized streamed body and drains or closes the stream safely', async () => {
  const request = bodyStream([
    Buffer.alloc(4096, 0x20),
    Buffer.alloc(4097, 0x20),
    'private-body-detail',
  ]);

  await assert.rejects(readJsonBody(request), assertBodyError('PAYLOAD_TOO_LARGE'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(request.readableEnded || request.destroyed, true);
});

for (const [name, chunks, code] of [
  ['empty input', [], 'EMPTY_BODY'],
  ['whitespace-only input', [' \n\t'], 'EMPTY_BODY'],
  ['malformed JSON', ['{"private":"body-detail"'], 'MALFORMED_JSON'],
  ['malformed UTF-8 JSON', [Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])], 'MALFORMED_JSON'],
]) {
  test(`rejects ${name} with a sanitized stable code`, async () => {
    await assert.rejects(readJsonBody(bodyStream(chunks)), assertBodyError(code));
  });
}

test('rejects an aborted stream without exposing stream details', async () => {
  const request = new Readable({ read() {} });
  request.headers = { 'content-type': 'application/json' };
  const pending = readJsonBody(request);
  request.emit('aborted');
  request.destroy();

  await assert.rejects(pending, assertBodyError('REQUEST_ABORTED'));
});

test('rejects a stream error without exposing its message', async () => {
  const request = new Readable({ read() {} });
  request.headers = { 'content-type': 'application/json' };
  const pending = readJsonBody(request);
  request.destroy(new Error('private-stream-detail'));

  await assert.rejects(pending, assertBodyError('REQUEST_ERROR'));
});

test('rejects an already destroyed request with a stable code', async () => {
  const request = bodyStream(['{"ok":true}']);
  request.destroy();

  await assert.rejects(readJsonBody(request), assertBodyError('REQUEST_ABORTED'));
});

test('rejects unsafe parser options without executing an accessor', async () => {
  let getterCalls = 0;
  const options = {};
  Object.defineProperty(options, 'maxBytes', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 8192;
    },
  });
  const request = bodyStream(['{"ok":true}']);

  await assert.rejects(readJsonBody(request, options), assertBodyError('INVALID_OPTIONS'));
  assert.equal(getterCalls, 0);
});

test('rejects Proxy parser options without executing their traps', async () => {
  let trapCalls = 0;
  const options = new Proxy({ maxBytes: 8192 }, {
    getPrototypeOf(target) {
      trapCalls += 1;
      return Reflect.getPrototypeOf(target);
    },
    ownKeys(target) {
      trapCalls += 1;
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, key) {
      trapCalls += 1;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });

  await assert.rejects(
    readJsonBody(bodyStream(['{"ok":true}']), options),
    assertBodyError('INVALID_OPTIONS'),
  );
  assert.equal(trapCalls, 0);
});

test('sanitizes revoked Proxy parser options', async () => {
  const { proxy, revoke } = Proxy.revocable({ maxBytes: 8192 }, {});
  revoke();

  await assert.rejects(
    readJsonBody(bodyStream(['{"ok":true}']), proxy),
    assertBodyError('INVALID_OPTIONS'),
  );
});

for (const options of [
  null,
  [],
  { maxBytes: 0 },
  { maxBytes: 8193 },
  { maxBytes: 1.5 },
  { extra: true },
  Object.create(null),
]) {
  test('rejects invalid parser options without reading the body', async () => {
    let reads = 0;
    const request = new Readable({
      read() {
        reads += 1;
        this.push('{"ok":true}');
        this.push(null);
      },
    });
    request.headers = { 'content-type': 'application/json' };

    await assert.rejects(readJsonBody(request, options), assertBodyError('INVALID_OPTIONS'));
    assert.equal(reads, 0);
  });
}
