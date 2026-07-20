'use strict';

const { isProxy } = require('node:util/types');

class JsonBodyError extends Error {
  constructor(code) {
    super(code);
    this.name = 'JsonBodyError';
    this.code = code;
  }
}

const DEFAULT_MAX_BYTES = 8192;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function fail(code) {
  throw new JsonBodyError(code);
}

function readMaximum(options) {
  if (options === undefined) return DEFAULT_MAX_BYTES;

  let keys;
  let descriptors;
  try {
    if (options === null
      || typeof options !== 'object'
      || isProxy(options)
      || Array.isArray(options)
      || Object.getPrototypeOf(options) !== Object.prototype) {
      fail('INVALID_OPTIONS');
    }
    keys = Reflect.ownKeys(options);
    descriptors = Object.getOwnPropertyDescriptors(options);
  } catch (error) {
    if (error instanceof JsonBodyError) throw error;
    fail('INVALID_OPTIONS');
  }

  if (keys.some((key) => key !== 'maxBytes')
    || (descriptors.maxBytes && !Object.hasOwn(descriptors.maxBytes, 'value'))) {
    fail('INVALID_OPTIONS');
  }
  const maxBytes = descriptors.maxBytes?.value ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes)
    || maxBytes <= 0
    || maxBytes > DEFAULT_MAX_BYTES) {
    fail('INVALID_OPTIONS');
  }
  return maxBytes;
}

function validateContentType(value) {
  if (typeof value !== 'string') fail('UNSUPPORTED_MEDIA_TYPE');
  if (/^\s*application\/json\s*$/i.test(value)) return;
  if (/^\s*application\/json\s*;\s*charset\s*=\s*(?:utf-8|"utf-8")\s*$/i.test(value)) {
    return;
  }
  if (/^\s*application\/json\s*;\s*charset\s*=/i.test(value)) {
    fail('UNSUPPORTED_CHARSET');
  }
  fail('UNSUPPORTED_MEDIA_TYPE');
}

function validateContentLength(value, maxBytes) {
  if (value === undefined) return;
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0
    || values.some((item) => typeof item !== 'string' || !/^(?:0|[1-9]\d*)$/.test(item))
    || new Set(values).size !== 1) {
    fail('INVALID_CONTENT_LENGTH');
  }
  const length = Number(values[0]);
  if (!Number.isSafeInteger(length)) fail('INVALID_CONTENT_LENGTH');
  if (length > maxBytes) fail('PAYLOAD_TOO_LARGE');
}

function drainAfterFailure(request) {
  const ignoreError = () => {};
  const cleanup = () => {
    request.off('error', ignoreError);
    request.off('end', cleanup);
    request.off('close', cleanup);
  };
  request.on('error', ignoreError);
  request.once('end', cleanup);
  request.once('close', cleanup);
  request.resume?.();
}

function readBoundedStream(request, maxBytes) {
  if (!request || typeof request.on !== 'function' || request.destroyed) {
    return Promise.reject(new JsonBodyError('REQUEST_ABORTED'));
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let ended = false;
    let settled = false;

    function cleanup() {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('aborted', onAborted);
      request.off('error', onError);
      request.off('close', onClose);
    }

    function rejectWith(code, drain = false) {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      cleanup();
      if (drain) drainAfterFailure(request);
      reject(new JsonBodyError(code));
    }

    function onData(value) {
      let chunk;
      try {
        chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      } catch {
        rejectWith('REQUEST_ERROR', true);
        return;
      }
      if (chunk.length > maxBytes - totalBytes) {
        rejectWith('PAYLOAD_TOO_LARGE', true);
        return;
      }
      totalBytes += chunk.length;
      chunks.push(chunk);
    }

    function onEnd() {
      if (settled) return;
      ended = true;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, totalBytes));
    }

    function onAborted() {
      rejectWith('REQUEST_ABORTED', true);
    }

    function onError() {
      rejectWith('REQUEST_ERROR');
    }

    function onClose() {
      if (!ended) rejectWith('REQUEST_ABORTED');
    }

    request.on('data', onData);
    request.once('end', onEnd);
    request.once('aborted', onAborted);
    request.once('error', onError);
    request.once('close', onClose);
  });
}

async function readJsonBody(request, options) {
  const maxBytes = readMaximum(options);
  const headers = request?.headers;
  validateContentType(headers?.['content-type']);
  validateContentLength(headers?.['content-length'], maxBytes);

  const body = await readBoundedStream(request, maxBytes);
  let text;
  try {
    text = UTF8_DECODER.decode(body);
  } catch {
    fail('MALFORMED_JSON');
  }
  if (text.trim().length === 0) fail('EMPTY_BODY');
  try {
    return JSON.parse(text);
  } catch {
    fail('MALFORMED_JSON');
  }
}

module.exports = { JsonBodyError, readJsonBody };
