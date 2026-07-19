'use strict';

const { CODES, upstreamError } = require('../upstream/errors');

function createOperationQueue({ timeoutMs = 15000, maxPending = 100 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive integer');
  }
  if (!Number.isInteger(maxPending) || maxPending <= 0) {
    throw new TypeError('maxPending must be a positive integer');
  }

  let tail = Promise.resolve();
  let pending = 0;

  function run(operation) {
    if (typeof operation !== 'function') {
      return Promise.reject(new TypeError('operation must be a function'));
    }
    if (pending >= maxPending) {
      return Promise.reject(upstreamError(
        CODES.BROWSER_UNAVAILABLE,
        'Browser operation queue is full',
      ));
    }

    pending += 1;
    const execute = async () => {
      const controller = new AbortController();
      let timer;
      const operationPromise = Promise.resolve().then(() => operation({
        signal: controller.signal,
      }));
      const timeoutPromise = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          reject(upstreamError(CODES.TIMEOUT, 'Browser operation timed out'));
          controller.abort();
        }, timeoutMs);
        timer.unref?.();
      });

      try {
        return await Promise.race([operationPromise, timeoutPromise]);
      } finally {
        clearTimeout(timer);
        pending -= 1;
      }
    };

    const result = tail.then(execute, execute);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  return Object.freeze({
    run,
    get pending() {
      return pending;
    },
  });
}

module.exports = { createOperationQueue };
