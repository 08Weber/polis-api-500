import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/check-api.mjs', import.meta.url));
const fixturePath = fileURLToPath(new URL('./fixtures/events.json', import.meta.url));
const fixture = await readFile(fixturePath, 'utf8');

function runCheck(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, '--retry-delay', '0', ...args], (error, stdout) => {
      resolve({ code: error?.code ?? 0, stdout });
    });
  });
}

/** Startar en lokal server som svarar med responses[0], responses[1] … (sista upprepas). */
async function withServer(responses, fn) {
  let calls = 0;
  const server = http.createServer((request, response) => {
    const { body, headers = { 'access-control-allow-origin': '*' } } = responses[Math.min(calls, responses.length - 1)];
    calls += 1;
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', ...headers });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/api/events`, () => calls);
  } finally {
    server.close();
  }
}

test('godkänner de riktiga exempelhändelserna från fil', async () => {
  const { code, stdout } = await runCheck(['--file', fixturePath]);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /✓ API:et stämmer/);
});

test('försöker igen när API:et tillfälligt svarar med en tom lista', async () => {
  await withServer([{ body: '[]' }, { body: '[]' }, { body: fixture }], async (url, calls) => {
    const { code, stdout } = await runCheck(['--url', url]);
    assert.equal(code, 0, stdout);
    assert.equal(calls(), 3);
    assert.match(stdout, /tom lista 2 gång/);
  });
});

test('larmar om API:et bara svarar med tomma listor', async () => {
  await withServer([{ body: '[]' }], async (url, calls) => {
    const { code, stdout } = await runCheck(['--url', url]);
    assert.equal(code, 1);
    assert.equal(calls(), 4);
    assert.match(stdout, /inga händelser/);
  });
});

test('larmar om CORS-headern saknas', async () => {
  await withServer([{ body: fixture, headers: {} }], async (url) => {
    const { code, stdout } = await runCheck(['--url', url]);
    assert.equal(code, 1);
    assert.match(stdout, /FEL: CORS/);
  });
});

test('--lan godkänner när alla händelser ligger i länet', async () => {
  const skane = JSON.stringify(JSON.parse(fixture).filter((event) => event.location.name === 'Skåne län'));
  await withServer([{ body: skane }], async (url) => {
    const { code, stdout } = await runCheck(['--url', url, '--lan', 'Skåne län']);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /Länsfilter: ok/);
  });
});

test('--lan larmar om länsfiltret släpper igenom andra län', async () => {
  await withServer([{ body: fixture }], async (url) => {
    const { code, stdout } = await runCheck(['--url', url, '--lan', 'Skåne län']);
    assert.equal(code, 1);
    assert.match(stdout, /länsfiltret fungerar inte/);
  });
});
