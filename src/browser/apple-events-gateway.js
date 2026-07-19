'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const { CODES, upstreamError } = require('../upstream/errors');

const OSASCRIPT_PATH = '/usr/bin/osascript';
const HELPER_PATH = path.resolve(__dirname, '..', '..', 'scripts', 'chrome-evaluate.jxa');

class OutputLimitError extends Error {}

function allowedPageOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('Page origin must be a valid https origin without path, query, or fragment');
  }
  if (parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash) {
    throw new TypeError('Page origin must be a valid https origin without path, query, or fragment');
  }
  return parsed.origin;
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function runProcess(command, args, { signal, maxOutputBytes }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let child;
    try {
      child = spawn(command, args, {
        shell: false,
        signal,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }

    const chunks = [];
    let bytes = 0;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };

    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) {
        child.kill();
        finish(reject, new OutputLimitError());
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.resume();
    child.once('error', (error) => finish(reject, error));
    child.once('close', (exitCode) => finish(resolve, {
      exitCode,
      stdout: Buffer.concat(chunks).toString('utf8'),
    }));
  });
}

function createAppleEventsGateway({
  pageOrigin,
  runImpl = runProcess,
  maxExpressionBytes = 64 * 1024,
  maxResponseBytes = 1_000_000,
} = {}) {
  const expectedPageOrigin = allowedPageOrigin(pageOrigin);
  positiveInteger(maxExpressionBytes, 'maxExpressionBytes');
  positiveInteger(maxResponseBytes, 'maxResponseBytes');
  if (typeof runImpl !== 'function') throw new TypeError('runImpl must be a function');

  async function evaluate(expression, { signal } = {}) {
    if (typeof expression !== 'string' || expression.length === 0) {
      throw new TypeError('expression must be a non-empty string');
    }
    if (Buffer.byteLength(expression) > maxExpressionBytes) {
      throw new TypeError('expression was too large');
    }

    let result;
    try {
      result = await runImpl(OSASCRIPT_PATH, [
        '-l',
        'JavaScript',
        HELPER_PATH,
        expectedPageOrigin,
        expression,
      ], {
        signal,
        maxOutputBytes: maxResponseBytes,
      });
    } catch (error) {
      if (error instanceof OutputLimitError) {
        throw upstreamError(CODES.BAD_RESPONSE, 'Browser evaluation response was too large');
      }
      throw upstreamError(CODES.BROWSER_UNAVAILABLE, 'Browser evaluation failed');
    }

    if (!result || result.exitCode !== 0 || typeof result.stdout !== 'string') {
      throw upstreamError(CODES.BROWSER_UNAVAILABLE, 'Browser evaluation failed');
    }
    if (Buffer.byteLength(result.stdout) > maxResponseBytes) {
      throw upstreamError(CODES.BAD_RESPONSE, 'Browser evaluation response was too large');
    }

    try {
      return JSON.parse(result.stdout);
    } catch {
      throw upstreamError(CODES.BAD_RESPONSE, 'Browser evaluation returned invalid JSON');
    }
  }

  async function status() {
    try {
      await evaluate('true');
      return 'page_found';
    } catch {
      return 'unavailable';
    }
  }

  async function close() {}

  return Object.freeze({ evaluate, status, close });
}

module.exports = { createAppleEventsGateway };
