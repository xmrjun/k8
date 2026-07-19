'use strict';

function sendJson(response, statusCode, body, requestId, additionalHeaders = {}) {
  const serialized = JSON.stringify(body);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(serialized),
    'x-request-id': requestId,
    ...additionalHeaders,
  });
  response.end(serialized);
}

function success(response, { data, source, fetchedAt, requestId }) {
  sendJson(response, 200, {
    data,
    source,
    fetched_at: fetchedAt,
    request_id: requestId,
  }, requestId);
}

function sendError(response, statusCode, code, message, requestId, headers) {
  sendJson(response, statusCode, {
    error: { code, message, request_id: requestId },
  }, requestId, headers);
}

function unauthorized(response, requestId) {
  sendError(response, 401, 'UNAUTHORIZED', 'Unauthorized', requestId, {
    'www-authenticate': 'Bearer realm="k8-api"',
  });
}

function methodNotAllowed(response, requestId, allowedMethods = ['GET']) {
  sendError(response, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed', requestId, {
    allow: allowedMethods.join(', '),
  });
}

function badGateway(response, requestId) {
  sendError(response, 502, 'BAD_GATEWAY', 'Bad gateway', requestId);
}

function gatewayTimeout(response, requestId) {
  sendError(response, 504, 'GATEWAY_TIMEOUT', 'Gateway timeout', requestId);
}

function internalError(response, requestId) {
  sendError(response, 500, 'INTERNAL_ERROR', 'Internal server error', requestId);
}

module.exports = {
  sendError,
  success,
  unauthorized,
  methodNotAllowed,
  badGateway,
  gatewayTimeout,
  internalError,
};
