import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  categorize,
  computeStats,
  countValues,
  dayKey,
  dayLabel,
  filterEvents,
  formatClock,
  fromStockholmTime,
  groupByDay,
  isApiDateTime,
  mapUrl,
  normalizeEvent,
  normalizeEvents,
  parseDateTime,
  parseEventName,
  parseGps,
  relativeTime,
  toPolisenUrl,
} from '../js/polisen.js';

// Riktiga händelser från polisen.se/api/events, hämtade 11 oktober 2026.
const fixturePath = fileURLToPath(new URL('./fixtures/events.json', import.meta.url));
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const events = normalizeEvents(fixture);
const ids = (list) => list.map((event) => event.id);
const iso = (date) => date?.toISOString();

test('parseDateTime tolkar API:ets datumformat', () => {
  assert.equal(iso(parseDateTime('2026-10-10 22:06:24 +02:00')), '2026-10-10T20:06:24.000Z');
  // Timmen kan sakna inledande nolla.
  assert.equal(iso(parseDateTime('2026-10-10 7:44:49 +02:00')), '2026-10-10T05:44:49.000Z');
  // Vintertid och dygnsgräns.
  assert.equal(iso(parseDateTime('2026-01-01 0:30:00 +01:00')), '2025-12-31T23:30:00.000Z');
  // ISO 8601 ifall API:et byter format.
  assert.equal(iso(parseDateTime('2026-10-11T14:32:05+02:00')), '2026-10-11T12:32:05.000Z');
  assert.equal(iso(parseDateTime('2026-10-11T12:32:05Z')), '2026-10-11T12:32:05.000Z');
  // Utan tidszon tolkas tiden som svensk tid.
  assert.equal(iso(parseDateTime('2026-10-11 14:32:05')), '2026-10-11T12:32:05.000Z');
});

test('parseDateTime ger null för trasiga värden', () => {
  for (const value of [undefined, null, '', 'igår', '2026-13-01 10:00:00 +02:00', '2026-10-11 25:00:00 +02:00', 42]) {
    assert.equal(parseDateTime(value), null, String(value));
  }
});

test('isApiDateTime känner igen formatet', () => {
  assert.ok(isApiDateTime('2026-10-10 7:44:49 +02:00'));
  assert.ok(!isApiDateTime('10 oktober 07.44'));
});

test('fromStockholmTime hanterar sommar- och vintertid', () => {
  assert.equal(iso(fromStockholmTime(2026, 6, 1, 12, 0)), '2026-07-01T10:00:00.000Z');
  assert.equal(iso(fromStockholmTime(2026, 0, 15, 12, 0)), '2026-01-15T11:00:00.000Z');
});

test('parseEventName plockar ut händelsetid och ort ur rubriken', () => {
  const published = parseDateTime('2026-10-10 22:06:24 +02:00');
  const brand = parseEventName('10 oktober 21.35, Brand, Huddinge', 'Brand', published);
  assert.equal(iso(brand.date), '2026-10-10T19:35:00.000Z');
  assert.equal(brand.place, 'Huddinge');

  // Typen kan innehålla kommatecken.
  assert.equal(parseEventName('10 oktober 20.06, Trafikolycka, singel, Perstorp', 'Trafikolycka, singel', published).place, 'Perstorp');
  // Ibland är "orten" länet.
  assert.equal(parseEventName('10 oktober 21.45, Övrigt, Hallands län', 'Övrigt', published).place, 'Hallands län');
  // Utan ort.
  assert.equal(parseEventName('10 oktober 21.45, Övrigt', 'Övrigt', published).place, null);
  // Typen i rubriken skiljer sig från type-fältet: ta sista delen.
  assert.equal(parseEventName('10 oktober 21.35, Brand i byggnad, Huddinge', 'Brand', published).place, 'Huddinge');
  // Ensiffrig dag och timme.
  assert.equal(iso(parseEventName('9 oktober 7.05, Brand, Lund', 'Brand', published).date), '2026-10-09T05:05:00.000Z');
});

test('parseEventName räknar ut rätt år kring årsskiftet', () => {
  const newYear = parseDateTime('2027-01-01 0:20:00 +01:00');
  assert.equal(iso(parseEventName('31 december 23.50, Brand, Kiruna', 'Brand', newYear).date), '2026-12-31T22:50:00.000Z');
  const winter = parseDateTime('2027-01-05 9:00:00 +01:00');
  assert.equal(iso(parseEventName('5 januari 08.00, Brand, Kiruna', 'Brand', winter).date), '2027-01-05T07:00:00.000Z');
});

test('parseEventName tål okända rubriker', () => {
  assert.deepEqual(parseEventName('Något helt annat', 'Brand', null), { date: null, place: null });
  assert.equal(parseEventName('10 oktobr 21.35, Brand, Huddinge', 'Brand', null).date, null);
  assert.deepEqual(parseEventName(undefined, undefined, null), { date: null, place: null });
});

test('parseGps', () => {
  assert.deepEqual(parseGps('59.602496,18.138438'), { lat: 59.602496, lng: 18.138438 });
  assert.deepEqual(parseGps(' 57.7 , 11.97 '), { lat: 57.7, lng: 11.97 });
  for (const value of ['', ',', '59.3', 'a,b', '91,10', '59.3,18.0,1', undefined]) {
    assert.equal(parseGps(value), null, String(value));
  }
});

test('toPolisenUrl gör relativa länkar absoluta och släpper bara igenom polisen.se', () => {
  assert.equal(
    toPolisenUrl('/aktuellt/handelser/2026/oktober/10/10-oktober-21.35-brand-huddinge/'),
    'https://polisen.se/aktuellt/handelser/2026/oktober/10/10-oktober-21.35-brand-huddinge/',
  );
  assert.equal(toPolisenUrl('http://polisen.se/a/'), 'https://polisen.se/a/');
  assert.equal(toPolisenUrl('https://www.polisen.se/a/'), 'https://www.polisen.se/a/');
  for (const value of ['https://example.com/a', 'javascript:alert(1)', '//evil.example/a', 'https://polisen.se.evil.example/', '', null]) {
    assert.equal(toPolisenUrl(value), null, String(value));
  }
});

test('mapUrl söker på orten, annars på länets koordinat', () => {
  assert.equal(
    mapUrl({ place: 'Huddinge', county: 'Stockholms län' }),
    'https://www.openstreetmap.org/search?query=Huddinge%2C%20Stockholms%20l%C3%A4n',
  );
  assert.equal(
    mapUrl({ place: 'Hallands län', county: 'Hallands län' }),
    'https://www.openstreetmap.org/search?query=Hallands%20l%C3%A4n',
  );
  assert.equal(
    mapUrl({ place: null, county: 'Stockholms län', gps: { lat: 59.602496, lng: 18.138438 } }),
    'https://www.openstreetmap.org/?mlat=59.60250&mlon=18.13844#map=9/59.60250/18.13844',
  );
  assert.equal(mapUrl({}), null);
});

test('categorize sorterar händelsetyper i rätt kategori', () => {
  const expected = {
    Trafikolycka: 'trafik',
    'Trafikolycka, personskada': 'trafik',
    'Trafikolycka, smitning från': 'trafik', // inte "rån"
    'Trafikolycka, singel': 'trafik',
    Trafikkontroll: 'trafik',
    Trafikhinder: 'trafik',
    Rattfylleri: 'trafik',
    'Olovlig körning': 'trafik',
    'Motorfordon, stöld': 'stold', // inte trafik
    'Motorfordon, anträffat stulet': 'stold',
    Stöld: 'stold',
    'Stöld/inbrott': 'stold',
    'Larm Inbrott': 'stold',
    'Olaga intrång': 'stold',
    Skadegörelse: 'stold',
    Bedrägeri: 'stold',
    Häleri: 'stold',
    Rån: 'vald',
    'Rån väpnat': 'vald',
    'Rån, försök': 'vald',
    Misshandel: 'vald',
    'Misshandel, grov': 'vald',
    'Mord/dråp, försök': 'vald',
    'Skottlossning, misstänkt': 'vald',
    Sexualbrott: 'vald',
    Detonation: 'vald',
    'Våld/hot mot tjänsteman': 'vald',
    'Olaga hot': 'vald',
    Knivlagen: 'vald',
    'Larm Överfall': 'vald',
    Brand: 'brand',
    Mordbrand: 'brand', // inte "mord"
    'Brand automatlarm': 'brand',
    Arbetsplatsolycka: 'brand',
    Räddningsinsats: 'brand',
    'Sjukdom/olycksfall': 'brand',
    'Sammanfattning natt': 'sammanfattning',
    'Sammanfattning kväll och natt': 'sammanfattning',
    Uppdatering: 'sammanfattning',
    Narkotikabrott: 'ovrigt',
    Fylleri: 'ovrigt',
    Kontroll: 'ovrigt',
    'Försvunnen person': 'ovrigt',
    Information: 'ovrigt',
    Övrigt: 'ovrigt',
    'Någon helt ny typ': 'ovrigt',
  };
  for (const [type, category] of Object.entries(expected)) {
    assert.equal(categorize(type), category, type);
  }
});

test('normalizeEvent', () => {
  const event = normalizeEvent(fixture[0]);
  assert.equal(event.id, '655837');
  assert.equal(event.type, 'Brand');
  assert.equal(event.category, 'brand');
  assert.equal(event.place, 'Huddinge');
  assert.equal(event.county, 'Stockholms län');
  assert.equal(iso(event.date), '2026-10-10T19:35:00.000Z'); // 21.35 enligt rubriken
  assert.equal(iso(event.published), '2026-10-10T20:06:24.000Z'); // datetime
  assert.equal(event.url, 'https://polisen.se/aktuellt/handelser/2026/oktober/10/10-oktober-21.35-brand-huddinge/');
  assert.deepEqual(event.gps, { lat: 59.602496, lng: 18.138438 });
  assert.ok(event.searchText.includes('snättringe'));
});

test('normalizeEvent tål saknade fält', () => {
  const event = normalizeEvent({ id: 1 });
  assert.equal(event.date, null);
  assert.equal(event.type, 'Händelse');
  assert.equal(event.place, 'Okänd plats');
  assert.equal(event.county, 'Okänd plats');
  assert.equal(event.url, null);
  assert.equal(event.gps, null);
  assert.equal(normalizeEvent(null), null);

  // Rubrik som inte går att tolka: använd publiceringstid och län.
  const fallback = normalizeEvent({ id: 2, datetime: '2026-10-10 8:29:23 +02:00', name: 'Rubrik', location: { name: 'Uppsala län' } });
  assert.equal(iso(fallback.date), '2026-10-10T06:29:23.000Z');
  assert.equal(fallback.place, 'Uppsala län');
});

test('normalizeEvents sorterar på händelsetid, nyast först', () => {
  assert.deepEqual(ids(events), [
    '655836', // 21.45
    '655837', // 21.35 (publicerad senare än 655836)
    '655834',
    '655832',
    '655833',
    '655827',
    '655815', // 13.36
    '655809', // 11.38
    '655818', // 11.32 (publicerad 14:06)
    '655805',
    '655802',
    '655788',
  ]);
  const withBroken = normalizeEvents([{ id: 1, datetime: 'trasig' }, ...fixture.slice(0, 2)]);
  assert.equal(withBroken.at(-1).id, '1');
  assert.throws(() => normalizeEvents({ error: 'nope' }), TypeError);
});

test('filterEvents', () => {
  assert.equal(filterEvents(events).length, 12);
  assert.deepEqual(ids(filterEvents(events, { county: 'Skåne län' })), ['655834', '655832']);
  assert.deepEqual(ids(filterEvents(events, { category: 'trafik' })), ['655834', '655832', '655833', '655827', '655805', '655802']);
  assert.deepEqual(ids(filterEvents(events, { type: 'Rattfylleri' })), ['655833', '655805']);
  // Fritext: alla ord måste finnas, skiftlägesokänsligt, även åäö, och orten går att söka på.
  assert.deepEqual(ids(filterEvents(events, { q: 'STOCKHOLM' })), ['655837', '655827']);
  assert.deepEqual(ids(filterEvents(events, { q: 'rattfull ludvika' })), ['655805']);
  assert.deepEqual(ids(filterEvents(events, { q: 'östersund' })), ['655809']);
  assert.deepEqual(ids(filterEvents(events, { q: 'Huddinge', county: 'Skåne län' })), []);
});

test('countValues sorterar i svensk bokstavsordning (å, ä, ö sist)', () => {
  assert.deepEqual(countValues(events, 'place').map((entry) => entry.value).slice(-2), ['Ängelholm', 'Östersund']);
  assert.equal(countValues(events, 'county').find((entry) => entry.value === 'Skåne län').count, 2);
});

test('computeStats', () => {
  const now = Date.parse('2026-10-10T20:00:00Z'); // 22.00 svensk tid
  const stats = computeStats(events, now);
  assert.equal(stats.total, 12);
  assert.equal(stats.lastHour, 2); // 21.45 och 21.35
  assert.equal(stats.lastDay, 12);
  assert.equal(iso(stats.newest), '2026-10-10T19:45:00.000Z');
  assert.equal(iso(stats.oldest), '2026-10-10T05:44:00.000Z');
  assert.deepEqual(stats.topType, { value: 'Rattfylleri', count: 2 });
  assert.equal(stats.topCounty.count, 2);
});

test('svenska tidsformat i svensk tid', () => {
  const date = events.find((event) => event.id === '655837').date;
  const now = new Date('2026-10-11T01:00:00Z'); // 03.00 svensk tid dagen efter
  assert.equal(formatClock(date), '21:35');
  assert.equal(dayKey(date), '2026-10-10');
  assert.equal(dayLabel(date, now), 'Igår');
  assert.equal(dayLabel(date, new Date('2026-10-10T21:00:00Z')), 'Idag');
  assert.equal(dayLabel(date, new Date('2026-10-13T10:00:00Z')), 'Lördag 10 oktober');
  assert.equal(dayLabel(parseDateTime('2025-12-31 09:12:00 +01:00'), now), 'Onsdag 31 december 2025');
  assert.equal(relativeTime(date, date.getTime() + 20_000), 'nyss');
  assert.equal(relativeTime(date, date.getTime() + 12 * 60_000), 'för 12 minuter sedan');
  assert.equal(relativeTime(date, date.getTime() + 3 * 3_600_000), 'för 3 timmar sedan');
});

test('groupByDay grupperar per svensk kalenderdag, inte UTC', () => {
  const location = { name: 'Skåne län' };
  const list = normalizeEvents([
    // 00.05 svensk tid den 11:e är 22.05 UTC den 10:e.
    { id: 1, datetime: '2026-10-11 0:10:00 +02:00', name: '11 oktober 00.05, Brand, Lund', type: 'Brand', location },
    { id: 2, datetime: '2026-10-10 23:59:00 +02:00', name: '10 oktober 23.50, Brand, Lund', type: 'Brand', location },
    // Publicerad den 11:e men hände den 10:e.
    { id: 3, datetime: '2026-10-11 1:00:00 +02:00', name: '10 oktober 23.55, Brand, Lund', type: 'Brand', location },
  ]);
  assert.deepEqual(
    groupByDay(list).map((group) => [group.key, ids(group.events)]),
    [
      ['2026-10-11', ['1']],
      ['2026-10-10', ['3', '2']],
    ],
  );
});

test('API-kontrollen godkänner de riktiga exempelhändelserna', async () => {
  const script = fileURLToPath(new URL('../scripts/check-api.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [script, '--file', fixturePath]);
  assert.match(stdout, /✓ API:et stämmer/);
});
