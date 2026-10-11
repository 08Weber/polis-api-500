#!/usr/bin/env node
/**
 * Kontrollerar att Polisens API fortfarande svarar så som sidan förväntar sig.
 * Använder samma tolkningskod som sidan (js/polisen.js).
 *
 *   node scripts/check-api.mjs                     hämta live från polisen.se
 *   node scripts/check-api.mjs --file svar.json    kontrollera ett sparat svar
 *   node scripts/check-api.mjs --sample 5          skriv även ut 5 råa händelser
 *
 * Avslutas med kod 1 om något som sidan är beroende av inte stämmer.
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  API_URL,
  categorize,
  categoryLabel,
  computeStats,
  formatFull,
  isApiDateTime,
  normalizeEvents,
  parseDateTime,
  parseGps,
  relativeTime,
  toPolisenUrl,
} from '../js/polisen.js';

const { values: args } = parseArgs({
  options: {
    file: { type: 'string' },
    origin: { type: 'string', default: 'https://08weber.github.io' },
    sample: { type: 'string', default: '0' },
  },
});

const errors = [];
const warnings = [];

function finish() {
  console.log('');
  for (const message of warnings) console.log(`VARNING: ${message}`);
  for (const message of errors) console.log(`FEL: ${message}`);
  console.log(errors.length ? '\n✗ API:et stämmer inte med vad sidan förväntar sig.' : '\n✓ API:et stämmer med vad sidan förväntar sig.');
  process.exit(errors.length ? 1 : 0);
}

/* ---- Hämta ---------------------------------------------------------- */

let data;
if (args.file) {
  console.log(`Kontrollerar ${args.file}`);
  data = JSON.parse(await readFile(args.file, 'utf8'));
} else {
  console.log(`Hämtar ${API_URL}  (Origin: ${args.origin})`);
  const started = performance.now();
  let response;
  try {
    response = await fetch(API_URL, {
      headers: {
        Accept: 'application/json',
        Origin: args.origin,
        'User-Agent': 'polis-api-500/api-check (+https://github.com/08Weber/polis-api-500)',
      },
    });
  } catch (cause) {
    errors.push(`Kunde inte nå API:et: ${cause.cause?.message ?? cause.message}`);
    finish();
  }
  console.log(`HTTP ${response.status} på ${Math.round(performance.now() - started)} ms`);
  for (const header of [
    'content-type',
    'content-length',
    'cache-control',
    'access-control-allow-origin',
    'access-control-allow-methods',
    'vary',
    'date',
    'last-modified',
    'age',
  ]) {
    const value = response.headers.get(header);
    if (value) console.log(`  ${header}: ${value}`);
  }

  // Sidan hämtar direkt från webbläsaren och behöver därför CORS.
  const allowOrigin = response.headers.get('access-control-allow-origin');
  if (allowOrigin === '*' || allowOrigin === args.origin) {
    console.log(`CORS: ok, webbläsare får läsa svaret (Access-Control-Allow-Origin: ${allowOrigin})`);
  } else {
    errors.push(
      `CORS: svaret saknar Access-Control-Allow-Origin för ${args.origin} (fick: ${allowOrigin ?? 'ingen'}), ` +
        'så webbläsaren kommer att blockera anropet från sidan.',
    );
  }

  const body = await response.text();
  if (!response.ok) {
    errors.push(`API:et svarade HTTP ${response.status}: ${body.slice(0, 200)}`);
    finish();
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) warnings.push(`Content-Type är "${contentType}", inte JSON.`);
  try {
    data = JSON.parse(body);
  } catch (cause) {
    errors.push(`Svaret är inte giltig JSON (${cause.message}): ${body.slice(0, 200)}`);
    finish();
  }
}

/* ---- Struktur --------------------------------------------------------- */

if (!Array.isArray(data)) {
  errors.push(`Svaret är inte en lista utan ${typeof data}.`);
  finish();
}
console.log(`\nAntal händelser: ${data.length} (dokumentationen anger 500)`);
if (data.length === 0) errors.push('API:et returnerade inga händelser.');
else if (data.length < 400) warnings.push(`Bara ${data.length} händelser, dokumentationen anger 500.`);

// [fält, kontroll, kritiskt för sidan?]
const checks = [
  ['id', (e) => typeof e.id === 'number', false],
  ['datetime (går att tolka)', (e) => parseDateTime(e.datetime) !== null, true],
  ['datetime (känt format)', (e) => isApiDateTime(e.datetime), false],
  ['name', (e) => typeof e.name === 'string' && e.name.length > 0, false],
  ['summary', (e) => typeof e.summary === 'string', false],
  ['url (polisen.se)', (e) => toPolisenUrl(e.url) !== null, true],
  ['type', (e) => typeof e.type === 'string' && e.type.length > 0, true],
  ['location.name', (e) => typeof e.location?.name === 'string' && e.location.name.length > 0, true],
  ['location.gps', (e) => parseGps(e.location?.gps) !== null, false],
];
const knownKeys = new Set(['id', 'datetime', 'name', 'summary', 'url', 'type', 'location']);
const newKeys = new Set();

console.log('\nFält som sidan använder:');
for (const [field, check, critical] of checks) {
  const failing = data.filter((event) => !event || typeof event !== 'object' || !check(event));
  const share = data.length ? failing.length / data.length : 0;
  console.log(`  ${failing.length ? '✗' : '✓'} ${field}${failing.length ? `: ${failing.length} st saknas/felaktiga` : ''}`);
  if (failing.length) {
    console.log(`      t.ex. ${JSON.stringify(failing[0]).slice(0, 300)}`);
    const message = `${failing.length} av ${data.length} händelser har problem med "${field}".`;
    (critical && share >= 0.05 ? errors : warnings).push(message);
  }
}
for (const event of data) {
  for (const key of Object.keys(event ?? {})) if (!knownKeys.has(key)) newKeys.add(key);
}
if (newKeys.size) warnings.push(`API:et har nya fält som sidan inte använder: ${[...newKeys].join(', ')}`);

/* ---- Innehåll --------------------------------------------------------- */

const events = normalizeEvents(data);
const stats = computeStats(events);
if (stats.newest) {
  console.log(`\nNyaste händelsen: ${formatFull(stats.newest)} (${relativeTime(stats.newest)})`);
  console.log(`Äldsta händelsen: ${formatFull(stats.oldest)} (${relativeTime(stats.oldest)})`);
  console.log(`Senaste timmen: ${stats.lastHour}, senaste dygnet: ${stats.lastDay}`);
  if (!args.file && Date.now() - stats.newest.getTime() > 24 * 3_600_000) {
    warnings.push('Nyaste händelsen är över ett dygn gammal, uppdateras API:et fortfarande?');
  }
}

const types = new Map();
for (const event of events) types.set(event.type, (types.get(event.type) ?? 0) + 1);
console.log(`\nHändelsetyper (${types.size} st) → kategori:`);
for (const [type, count] of [...types].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${type.padEnd(36)} ${categoryLabel(categorize(type))}`);
}

const locations = new Set(events.map((event) => event.location));
console.log(`\nPlatser: ${locations.size} st, t.ex. ${[...locations].slice(0, 8).join(', ')}`);

const sampleSize = Number.parseInt(args.sample, 10) || 0;
if (sampleSize > 0) {
  console.log(`\n--- ${sampleSize} råa händelser ---`);
  for (const event of data.slice(0, sampleSize)) console.log(JSON.stringify(event));
  console.log('--- slut ---');
}

finish();
