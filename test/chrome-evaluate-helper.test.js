'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HELPER_PATH = path.resolve(__dirname, '..', 'scripts', 'chrome-evaluate.jxa');

function helperRun(tabs) {
  const source = `${fs.readFileSync(HELPER_PATH, 'utf8')}\nrun`;
  const Application = () => ({
    windows: () => [{ tabs: () => tabs }],
  });
  return vm.runInNewContext(source, { Application });
}

function fakeTab(result, pathname = '/') {
  return {
    execute({ javascript }) {
      if (javascript === 'location.origin') return 'https://k81128.com';
      if (javascript === 'location.pathname') return pathname;
      return JSON.stringify(result);
    },
  };
}

test('helper prefers a ready same-origin tab over a login page', () => {
  const run = helperRun([
    fakeTab({ status: 'login_required', wallets: [] }),
    fakeTab({ status: 'ready', wallets: [{ currency: 'USDT' }] }),
  ]);

  const serialized = run(['https://k81128.com', '/', '({ status: "ready" })']);

  assert.deepEqual(JSON.parse(serialized), {
    status: 'ready',
    wallets: [{ currency: 'USDT' }],
  });
});

test('helper selects the exact pathname without reading the full URL', () => {
  const executions = [];
  const tab = (pathname, result) => ({
    execute({ javascript }) {
      executions.push(javascript);
      if (javascript === 'location.origin') return 'https://k81128.com';
      if (javascript === 'location.pathname') return pathname;
      return JSON.stringify(result);
    },
  });
  const run = helperRun([
    tab('/', { status: 'ready', page: 'main' }),
    tab('/popup/', { status: 'ready', page: 'popup' }),
  ]);

  const serialized = run(['https://k81128.com', '/popup/', '({ status: "ready" })']);

  assert.equal(JSON.parse(serialized).page, 'popup');
  assert.equal(executions.includes('location.href'), false);
  assert.equal(executions.some((value) => value.includes('document.cookie')), false);
});
