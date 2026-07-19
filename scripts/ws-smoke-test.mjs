import { WebSocket } from 'ws';
import { pathToFileURL } from 'node:url';

const TYPES = Object.freeze(['snapshot', 'delta', 'score', 'ping']);

function feedUrl(baseUrl, token) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('K8_WS_BASE_URL is invalid');
  }
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('K8_WS_BASE_URL must use HTTP or WebSocket');
  }
  url.pathname = '/ws/sports';
  url.search = '';
  url.hash = '';
  url.searchParams.set('token', token);
  return url.toString();
}

export function wsSmokeTest({
  baseUrl,
  token,
  WebSocketImpl = WebSocket,
  timeoutMs = 10_000,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}) {
  if (!token) return Promise.reject(new Error('WS_TOKEN is required'));
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    return Promise.reject(new Error('timeoutMs must be between 1 and 60000'));
  }

  let url;
  try {
    url = feedUrl(baseUrl, token);
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    const counts = { snapshot: 0, delta: 0, score: 0, ping: 0 };
    let messages = 0;
    let lastSequence = -1;
    let settled = false;
    let socket;

    function result() {
      return {
        status: 'ok',
        messages,
        types: counts,
        monotonic_seq: true,
      };
    }

    function fail() {
      if (settled) return;
      settled = true;
      clearTimeoutImpl(timer);
      reject(new Error('WebSocket feed validation failed'));
      try { socket.close(); } catch { /* ignored */ }
    }

    function succeed() {
      if (settled) return;
      if (counts.snapshot !== 1 || messages === 0) {
        fail();
        return;
      }
      settled = true;
      clearTimeoutImpl(timer);
      resolve(result());
      try { socket.close(); } catch { /* ignored */ }
    }

    try {
      socket = new WebSocketImpl(url);
    } catch {
      reject(new Error('WebSocket smoke test connection failed'));
      return;
    }

    const timer = setTimeoutImpl(succeed, timeoutMs);
    socket.on('message', (data) => {
      if (settled) return;
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        fail();
        return;
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)
        || !TYPES.includes(message.type)
        || !Number.isSafeInteger(message.seq)
        || message.seq <= lastSequence
        || (messages === 0 && message.type !== 'snapshot')
        || (message.type === 'snapshot' && counts.snapshot !== 0)) {
        fail();
        return;
      }
      lastSequence = message.seq;
      counts[message.type] += 1;
      messages += 1;
    });
    socket.on('error', fail);
    socket.on('close', () => {
      if (!settled) succeed();
    });
  });
}

async function main() {
  const result = await wsSmokeTest({
    baseUrl: process.env.K8_WS_BASE_URL || 'ws://127.0.0.1:8788',
    token: process.env.WS_TOKEN,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
