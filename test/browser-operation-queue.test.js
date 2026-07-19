const test = require('node:test');
const assert = require('node:assert/strict');

const { createOperationQueue } = require('../src/browser/operation-queue');
const { CODES } = require('../src/upstream/errors');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('browser operations execute strictly one at a time', async () => {
  const queue = createOperationQueue({ timeoutMs: 1000, maxPending: 10 });
  const firstGate = deferred();
  const started = [];
  let active = 0;
  let maximumActive = 0;

  const first = queue.run(async () => {
    started.push('first');
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await firstGate.promise;
    active -= 1;
    return 'first-result';
  });
  const second = queue.run(async () => {
    started.push('second');
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    active -= 1;
    return 'second-result';
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['first']);
  firstGate.resolve();
  assert.deepEqual(await Promise.all([first, second]), ['first-result', 'second-result']);
  assert.deepEqual(started, ['first', 'second']);
  assert.equal(maximumActive, 1);
});

test('a rejected operation does not block later work', async () => {
  const queue = createOperationQueue({ timeoutMs: 1000, maxPending: 10 });
  const secret = new Error('private browser failure');
  const failed = queue.run(async () => { throw secret; });
  const succeeded = queue.run(async () => 'ok');

  await assert.rejects(failed, (error) => error === secret);
  assert.equal(await succeeded, 'ok');
});

test('operation timeout aborts only the current operation and maps to UPSTREAM_TIMEOUT', async () => {
  const queue = createOperationQueue({ timeoutMs: 5, maxPending: 10 });
  const keepEventLoopAlive = setInterval(() => {}, 1000);
  let firstAborted = false;
  let secondAborted = false;

  const first = queue.run(({ signal }) => new Promise((resolve) => {
    signal.addEventListener('abort', () => {
      firstAborted = true;
      resolve('late-result');
    }, { once: true });
  }));
  const second = queue.run(async ({ signal }) => {
    secondAborted = signal.aborted;
    return 'next-result';
  });

  try {
    await assert.rejects(first, (error) => (
      error.code === CODES.TIMEOUT
        && !error.cause
        && !JSON.stringify(error).includes('late-result')
    ));
    assert.equal(await second, 'next-result');
    assert.equal(firstAborted, true);
    assert.equal(secondAborted, false);
  } finally {
    clearInterval(keepEventLoopAlive);
  }
});

test('queue rejects overload without allocating unbounded work', async () => {
  const queue = createOperationQueue({ timeoutMs: 1000, maxPending: 1 });
  const gate = deferred();
  const first = queue.run(async () => gate.promise);

  await assert.rejects(
    queue.run(async () => 'must-not-run'),
    (error) => error.code === CODES.BROWSER_UNAVAILABLE && !error.cause,
  );
  gate.resolve('done');
  assert.equal(await first, 'done');
});
