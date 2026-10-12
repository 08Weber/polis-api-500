import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createServer, resolveFile } from '../scripts/serve.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('resolveFile lämnar bara ut sidans egna filer', () => {
  assert.equal(resolveFile(root, '/'), path.join(root, 'index.html'));
  assert.equal(resolveFile(root, '/js/app.js'), path.join(root, 'js', 'app.js'));
  assert.equal(resolveFile(root, '/fonts/barlow-400.woff2'), path.join(root, 'fonts', 'barlow-400.woff2'));
  for (const bad of [
    '/../package.json',
    '/%2e%2e/%2e%2e/etc/passwd',
    '/js/..%2f..%2fetc/passwd',
    '/..%5c..%5cetc%5cpasswd',
    '/.git/config',
    '/%2egit/config',
    '/js/.hemlig.js',
    '/package.json%00.js',
    '/%E0%A4%A',
    '/scripts/serve.mjs',
  ]) {
    assert.equal(resolveFile(root, bad), null, bad);
  }
});

test('servern svarar bara på GET/HEAD och aldrig med dolda filer', async () => {
  const server = createServer(root);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await page.text(), /Utryckning LKPG/);

    assert.equal((await fetch(`${base}/.git/HEAD`)).status, 404);
    assert.equal((await fetch(`${base}/finns-inte.html`)).status, 404);
    assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
  } finally {
    server.close();
  }
});
