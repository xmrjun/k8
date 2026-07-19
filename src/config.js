'use strict';

function integerSetting(name, fallback, isValid, requirement) {
  const rawValue = process.env[name];
  const value = Number(rawValue === undefined || rawValue === '' ? fallback : rawValue);

  if (!Number.isFinite(value) || !Number.isInteger(value) || !isValid(value)) {
    throw new Error(`${name} ${requirement}`);
  }

  return value;
}

function upstreamBaseUrl() {
  const value = process.env.UPSTREAM_BASE_URL || '';

  if (!value) {
    return '';
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('UPSTREAM_BASE_URL must be a valid URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('UPSTREAM_BASE_URL must use http: or https:');
  }

  return parsed.href;
}

function upstreamMode() {
  const value = process.env.UPSTREAM_MODE === undefined
    ? 'browser'
    : process.env.UPSTREAM_MODE;
  if (!['browser', 'http', 'disabled'].includes(value)) {
    throw new Error('UPSTREAM_MODE must be browser, http, or disabled');
  }
  return value;
}

function browserCdpUrl() {
  const rawValue = process.env.BROWSER_CDP_URL || 'http://127.0.0.1:9223';
  let parsed;
  try {
    parsed = new URL(rawValue);
  } catch {
    throw new Error('BROWSER_CDP_URL must be an http URL on a loopback IP address');
  }

  const loopbackHosts = new Set(['127.0.0.1', '::1', '[::1]']);
  if (parsed.protocol !== 'http:'
    || !loopbackHosts.has(parsed.hostname)
    || parsed.username
    || parsed.password) {
    throw new Error('BROWSER_CDP_URL must be an http URL on a loopback IP address');
  }
  return parsed.origin;
}

function browserPageOrigin() {
  const rawValue = process.env.BROWSER_PAGE_ORIGIN || 'https://k81128.com';
  let parsed;
  try {
    parsed = new URL(rawValue);
  } catch {
    throw new Error('BROWSER_PAGE_ORIGIN must be a valid https URL');
  }

  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('BROWSER_PAGE_ORIGIN must be a valid https URL');
  }
  return parsed.origin;
}

function loadConfig() {
  const apiToken = process.env.API_TOKEN;

  if (!apiToken) {
    throw new Error('API_TOKEN is required');
  }
  if (apiToken.length < 32) {
    throw new Error('API_TOKEN must be at least 32 characters');
  }

  return {
    host: process.env.HOST || '127.0.0.1',
    port: integerSetting(
      'PORT',
      8788,
      (value) => value >= 1 && value <= 65535,
      'must be an integer between 1 and 65535',
    ),
    apiToken,
    upstreamMode: upstreamMode(),
    upstreamBaseUrl: upstreamBaseUrl(),
    upstreamCredential: process.env.UPSTREAM_CREDENTIAL || '',
    sportsCacheMs: integerSetting(
      'SPORTS_CACHE_MS',
      5000,
      (value) => value >= 0,
      'must be a non-negative integer',
    ),
    browserCdpUrl: browserCdpUrl(),
    browserPageOrigin: browserPageOrigin(),
    browserOperationTimeoutMs: integerSetting(
      'BROWSER_OPERATION_TIMEOUT_MS',
      15000,
      (value) => value > 0,
      'must be a positive integer',
    ),
  };
}

function publicConfig() {
  const config = loadConfig();

  return {
    host: config.host,
    port: config.port,
    upstreamMode: config.upstreamMode,
    upstreamOrigin: config.upstreamBaseUrl
      ? new URL(config.upstreamBaseUrl).origin
      : '',
    sportsCacheMs: config.sportsCacheMs,
    browserPageOrigin: config.browserPageOrigin,
    browserOperationTimeoutMs: config.browserOperationTimeoutMs,
  };
}

module.exports = { loadConfig, publicConfig };
