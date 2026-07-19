import { pathToFileURL } from 'node:url';

async function readJson(response, name) {
  try {
    return await response.json();
  } catch {
    throw new Error(`${name} returned non-JSON data`);
  }
}

export async function smokeTest({
  baseUrl,
  token,
  fetchImpl = globalThis.fetch,
}) {
  if (!token) throw new Error('API_TOKEN is required');

  const base = new URL(baseUrl);
  const healthUrl = new URL('/health', base);
  const sportsUrl = new URL('/api/sports', base);

  const healthResponse = await fetchImpl(healthUrl.toString());
  const healthBody = await readJson(healthResponse, 'health endpoint');
  if (!healthResponse.ok || healthBody?.data?.status !== 'ok') {
    throw new Error('health check failed');
  }

  const protectedResponse = await fetchImpl(sportsUrl.toString(), {
    headers: { authorization: `Bearer ${token}` },
  });
  await readJson(protectedResponse, 'protected endpoint');
  if (protectedResponse.status === 401 || protectedResponse.status === 403) {
    throw new Error('protected endpoint authentication failed');
  }

  return {
    health: 'ok',
    protected_status: protectedResponse.status,
  };
}

async function main() {
  const result = await smokeTest({
    baseUrl: process.env.K8_API_BASE_URL || 'http://127.0.0.1:8788',
    token: process.env.API_TOKEN,
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
