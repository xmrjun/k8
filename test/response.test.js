const test = require('node:test');
const assert = require('node:assert/strict');

const {
  success,
  unauthorized,
  methodNotAllowed,
  badGateway,
  gatewayTimeout,
  internalError,
} = require('../src/response');

function responseDouble() {
  return {
    statusCode: undefined,
    headers: {},
    body: '',
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

function call(helper, ...args) {
  const response = responseDouble();
  helper(response, ...args);
  return {
    statusCode: response.statusCode,
    headers: response.headers,
    body: JSON.parse(response.body),
  };
}

test('success sends JSON with a stable envelope and request ID', () => {
  const response = call(success, {
    data: [{ event_id: 'event-1' }],
    source: 'k81128',
    fetchedAt: '2026-07-19T12:00:00.000Z',
    requestId: 'request-success',
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(response.headers['x-request-id'], 'request-success');
  assert.deepEqual(response.body, {
    data: [{ event_id: 'event-1' }],
    source: 'k81128',
    fetched_at: '2026-07-19T12:00:00.000Z',
    request_id: 'request-success',
  });
});

const errorCases = [
  ['unauthorized', unauthorized, 401, 'UNAUTHORIZED', 'Unauthorized'],
  ['method not allowed', methodNotAllowed, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed'],
  ['bad gateway', badGateway, 502, 'BAD_GATEWAY', 'Bad gateway'],
  ['gateway timeout', gatewayTimeout, 504, 'GATEWAY_TIMEOUT', 'Gateway timeout'],
  ['internal error', internalError, 500, 'INTERNAL_ERROR', 'Internal server error'],
];

for (const [name, helper, status, code, message] of errorCases) {
  test(`${name} sends a stable JSON error envelope with request ID`, () => {
    const response = call(helper, 'request-error');

    assert.equal(response.statusCode, status);
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(response.headers['x-request-id'], 'request-error');
    assert.deepEqual(response.body, {
      error: { code, message, request_id: 'request-error' },
    });
  });
}

test('unauthorized identifies Bearer authentication without exposing a credential', () => {
  const response = call(unauthorized, 'request-auth-challenge');
  assert.equal(response.headers['www-authenticate'], 'Bearer realm="k8-api"');
});

test('method not allowed advertises GET by default', () => {
  const response = call(methodNotAllowed, 'request-allow');
  assert.equal(response.headers.allow, 'GET');
});

test('method not allowed can advertise an explicit method list', () => {
  const response = call(methodNotAllowed, 'request-allow-list', ['GET', 'HEAD']);
  assert.equal(response.headers.allow, 'GET, HEAD');
});

test('unauthorized never includes received credentials', () => {
  const credential = 'Bearer secret-value-that-must-not-escape';
  const response = call(unauthorized, 'request-private');
  assert.equal(JSON.stringify(response).includes(credential), false);
});
