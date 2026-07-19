import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function generateToken() {
  return randomBytes(32).toString('base64url');
}

export function writeTokenFile(outputPath) {
  const token = generateToken();
  const contents = [
    `API_TOKEN=${token}`,
    'HOST=127.0.0.1',
    'PORT=8788',
    'SPORTS_CACHE_MS=5000',
    '',
  ].join('\n');

  let descriptor;
  try {
    descriptor = fs.openSync(outputPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, contents, 'utf8');
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(`${outputPath} already exists`);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function outputArgument(argv) {
  const index = argv.indexOf('--output');
  if (index === -1 || !argv[index + 1] || index + 2 !== argv.length) {
    throw new Error('Usage: node scripts/generate-token.mjs --output <env-file>');
  }
  return argv[index + 1];
}

function main() {
  const outputPath = path.resolve(outputArgument(process.argv.slice(2)));
  writeTokenFile(outputPath);
  process.stdout.write(`Created ${outputPath}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
