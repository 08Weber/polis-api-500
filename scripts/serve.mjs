// Lokal utvecklingsserver utan beroenden: node scripts/serve.mjs [--port 8080]
// Lyssnar bara på den egna datorn och lämnar bara ut sidans egna filer,
// aldrig dolda filer som .git eller filer utanför projektmappen.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Filen som en adress pekar på, eller null om den inte får lämnas ut. */
export function resolveFile(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const parts = decoded.split(/[/\\]+/).filter(Boolean);
  if (parts.some((part) => part.startsWith('.'))) return null;
  if (decoded.endsWith('/') || parts.length === 0) parts.push('index.html');
  const file = path.resolve(root, ...parts);
  return file.startsWith(path.resolve(root) + path.sep) && TYPES[path.extname(file)] ? file : null;
}

export function createServer(root = ROOT) {
  return http.createServer(async (request, response) => {
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { ...headers, allow: 'GET, HEAD' }).end();
      return;
    }
    const file = resolveFile(root, new URL(request.url, 'http://localhost').pathname);
    const info = file && (await stat(file).catch(() => null));
    if (!info?.isFile()) {
      response.writeHead(404, { ...headers, 'content-type': 'text/plain; charset=utf-8' }).end('Hittades inte');
      return;
    }
    response.writeHead(200, { ...headers, 'content-type': TYPES[path.extname(file)], 'content-length': info.size });
    if (request.method === 'HEAD') response.end();
    else createReadStream(file).pipe(response);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { port: { type: 'string', default: '8080' } } });
  const port = Number(values.port);
  createServer().listen(port, '127.0.0.1', () => console.log(`Utryckning LKPG: http://localhost:${port}/`));
}
