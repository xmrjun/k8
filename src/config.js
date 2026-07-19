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
    upstreamBaseUrl: upstreamBaseUrl(),
    upstreamCredential: process.env.UPSTREAM_CREDENTIAL || '',
    sportsCacheMs: integerSetting(
      'SPORTS_CACHE_MS',
      5000,
      (value) => value >= 0,
      'must be a non-negative integer',
    ),
  };
}

function publicConfig() {
  const config = loadConfig();

  return {
    host: config.host,
    port: config.port,
    upstreamOrigin: config.upstreamBaseUrl
      ? new URL(config.upstreamBaseUrl).origin
      : '',
    sportsCacheMs: config.sportsCacheMs,
  };
}

module.exports = { loadConfig, publicConfig };
