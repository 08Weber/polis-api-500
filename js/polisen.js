/**
 * Datalager för Polisens öppna API över händelser.
 *
 * Bara rena funktioner utan DOM, så att samma kod används av sidan,
 * av testerna (test/) och av API-kontrollen (scripts/check-api.mjs).
 *
 * Dokumentation:
 * https://polisen.se/om-polisen/om-webbplatsen/oppna-data/api-over-polisens-handelser/
 *
 * Så ser en händelse ut (oktober 2026):
 *   {
 *     "id": 655837,
 *     "datetime": "2026-10-10 22:06:24 +02:00",       ← när notisen publicerades
 *     "name": "10 oktober 21.35, Brand, Huddinge",     ← händelsetid, typ och ort
 *     "summary": "Polis och räddningstjänst är på plats …",
 *     "url": "/aktuellt/handelser/2026/oktober/10/10-oktober-21.35-brand-huddinge/",
 *     "type": "Brand",
 *     "location": { "name": "Stockholms län", "gps": "59.602496,18.138438" }  ← länet
 *   }
 */

export const API_URL = 'https://polisen.se/api/events';
export const POLISEN_URL = 'https://polisen.se';
export const TIME_ZONE = 'Europe/Stockholm';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/* ------------------------------------------------------------------ */
/* Tid                                                                 */
/* ------------------------------------------------------------------ */

// "datetime" ser ut som "2026-10-10 7:44:49 +02:00": mellanslag i stället för
// "T" och ibland timmen utan inledande nolla. Det klarar inte alla webbläsare
// (t.ex. Safari) med new Date(), så vi tolkar det själva.
const DATETIME_RE =
  /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

/** Matchar värdet API:ets kända datumformat? */
export function isApiDateTime(value) {
  return typeof value === 'string' && DATETIME_RE.test(value.trim());
}

function validParts(month, day, hour, minute, second = 0) {
  return month >= 0 && month <= 11 && day >= 1 && day <= 31 && hour <= 23 && minute <= 59 && second <= 59;
}

/** "2026-10-11 02:13:45 +02:00" → Date, eller null om det inte går att tolka. */
export function parseDateTime(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const match = DATETIME_RE.exec(value.trim());
  if (!match) {
    // Okänt format: låt webbläsaren försöka hellre än att tappa händelsen.
    const fallback = new Date(value);
    return Number.isNaN(fallback.getTime()) ? null : fallback;
  }

  const [, y, mo, d, h, mi, s = '0', zone] = match;
  const parts = [+y, +mo - 1, +d, +h, +mi, +s];
  if (!validParts(...parts.slice(1))) return null;

  if (!zone) return fromStockholmTime(...parts);
  let time = Date.UTC(...parts);
  if (zone.toUpperCase() !== 'Z') {
    const sign = zone[0] === '-' ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    time -= sign * (+digits.slice(0, 2) * 60 + +digits.slice(2)) * MINUTE;
  }
  return new Date(time);
}

const zoneFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

/** Hur många ms svensk tid ligger före UTC vid en viss tidpunkt (1 eller 2 timmar). */
function stockholmOffset(time) {
  const whole = Math.floor(time / 1000) * 1000;
  const p = {};
  for (const { type, value } of zoneFormat.formatToParts(new Date(whole))) p[type] = +value;
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - whole;
}

/** Svensk lokal tid (månad 0–11) → Date, med hänsyn till sommartid. */
export function fromStockholmTime(year, month, day, hour, minute, second = 0) {
  const local = Date.UTC(year, month, day, hour, minute, second);
  const guess = local - stockholmOffset(local);
  return new Date(local - stockholmOffset(guess));
}

/* ------------------------------------------------------------------ */
/* Rubriken: "10 oktober 21.35, Brand, Huddinge"                       */
/* ------------------------------------------------------------------ */

const MONTHS = [
  'januari',
  'februari',
  'mars',
  'april',
  'maj',
  'juni',
  'juli',
  'augusti',
  'september',
  'oktober',
  'november',
  'december',
];
const NAME_RE = /^(\d{1,2}) ([a-zåäö]+) (\d{1,2})[.:](\d{2}),\s*(.+)$/i;

/**
 * Plockar ut händelsetid och ort ur rubriken. Rubriken saknar år, så året tas
 * från publiceringstiden (en händelse 31 december kan publiceras 1 januari).
 */
export function parseEventName(name, type, published) {
  const result = { date: null, place: null };
  const match = NAME_RE.exec(typeof name === 'string' ? name.trim() : '');
  if (!match) return result;

  const [, d, monthName, h, mi, rest] = match;
  const month = MONTHS.indexOf(monthName.toLowerCase());
  if (validParts(month, +d, +h, +mi)) {
    const reference = published ?? new Date();
    const year = +dayKey(reference).slice(0, 4);
    let date = fromStockholmTime(year, month, +d, +h, +mi);
    if (date - reference > 180 * DAY) date = fromStockholmTime(year - 1, month, +d, +h, +mi);
    else if (reference - date > 180 * DAY) date = fromStockholmTime(year + 1, month, +d, +h, +mi);
    result.date = date;
  }

  // Det som står efter typen är orten. Typen kan själv innehålla kommatecken
  // ("Trafikolycka, singel"), så vi letar efter just den typen först.
  let place = null;
  if (type && rest.startsWith(`${type},`)) place = rest.slice(type.length + 1);
  else if (rest.includes(',')) place = rest.slice(rest.lastIndexOf(',') + 1);
  result.place = place?.trim() || null;
  return result;
}

/* ------------------------------------------------------------------ */
/* Övriga fält                                                         */
/* ------------------------------------------------------------------ */

/** "59.329324,18.068581" → { lat, lng }, eller null. */
export function parseGps(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split(',').map((part) => part.trim());
  if (parts.length !== 2 || parts.some((part) => part === '')) return null;
  const [lat, lng] = parts.map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/**
 * API:et ger relativa länkar ("/aktuellt/handelser/2026/oktober/10/...").
 * Gör om till absolut https-länk och släpp bara igenom polisen.se.
 */
export function toPolisenUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let url;
  try {
    url = new URL(value.trim(), POLISEN_URL);
  } catch {
    return null;
  }
  const host = url.hostname;
  if (host !== 'polisen.se' && !host.endsWith('.polisen.se')) return null;
  if (url.protocol === 'http:') url.protocol = 'https:';
  return url.protocol === 'https:' ? url.href : null;
}

/**
 * Kartlänk till OpenStreetMap. API:ets koordinat är länets mittpunkt, så vi
 * söker hellre på orten och faller tillbaka på koordinaten.
 */
export function mapUrl({ place, county, gps }) {
  if (place) {
    const query = place === county || !county ? place : `${place}, ${county}`;
    return `https://www.openstreetmap.org/search?query=${encodeURIComponent(query)}`;
  }
  if (!gps) return null;
  const lat = gps.lat.toFixed(5);
  const lng = gps.lng.toFixed(5);
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=9/${lat}/${lng}`;
}

/* ------------------------------------------------------------------ */
/* Kategorier                                                          */
/* ------------------------------------------------------------------ */

export const CATEGORIES = [
  { id: 'vald', label: 'Våld & hot' },
  { id: 'stold', label: 'Stöld & inbrott' },
  { id: 'trafik', label: 'Trafik' },
  { id: 'brand', label: 'Brand & olycka' },
  { id: 'sammanfattning', label: 'Sammanfattning' },
  { id: 'ovrigt', label: 'Övrigt' },
];

// Första regeln som matchar vinner, så ordningen spelar roll:
// "Trafikolycka" ska bli trafik (inte olycka), "Motorfordon, stöld" stöld
// och "Mordbrand" brand. Nyckelord i stället för en fast lista, så att nya
// händelsetyper ändå hamnar rätt.
const CATEGORY_RULES = [
  ['sammanfattning', /^(sammanfattning|uppdatering)/],
  ['stold', /stöld|stulet|inbrott|häleri|snatteri|skadegörelse|bedrägeri|förfalskning|urkund|ekobrott|intrång|hemfrid/],
  ['trafik', /trafik|rattfylleri|olovlig körning|motorfordon/],
  ['brand', /brand|olycka|olycksfall|räddning|drunkn|naturkatastrof|haveri|varningslarm|kemikalie|översvämning/],
  [
    'vald',
    /mord|dråp|misshandel|(^|[^a-zåäö])rån|skottlossning|skjutning|detonation|sprängning|explosion|bombhot|våld|olaga hot|frihetsberövande|knivlag|vapenlag|överfall|bråk|ofredande|sedlighet|sexualbrott|kroppsskada|farligt föremål/,
  ],
];

/** Händelsetyp ("Trafikolycka, personskada") → kategori-id ("trafik"). */
export function categorize(type) {
  const text = String(type ?? '').toLowerCase();
  for (const [id, pattern] of CATEGORY_RULES) {
    if (pattern.test(text)) return id;
  }
  return 'ovrigt';
}

export function categoryLabel(id) {
  return CATEGORIES.find((category) => category.id === id)?.label ?? 'Övrigt';
}

/* ------------------------------------------------------------------ */
/* Normalisering                                                       */
/* ------------------------------------------------------------------ */

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Rå händelse från API:et → objektet som sidan arbetar med. */
export function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const type = text(raw.type) || 'Händelse';
  const county = text(raw.location?.name);
  const title = text(raw.name);
  const summary = text(raw.summary);
  const published = parseDateTime(raw.datetime);
  const fromName = parseEventName(title, type, published);
  const date = fromName.date ?? published;
  const place = fromName.place ?? county;

  return {
    id: String(raw.id ?? `${raw.datetime}|${title}`),
    date, // när det hände (ur rubriken), annars publiceringstiden
    time: date ? date.getTime() : Number.NaN,
    published,
    type,
    category: categorize(type),
    place: place || 'Okänd plats', // orten, t.ex. "Huddinge"
    county: county || place || 'Okänd plats', // länet, t.ex. "Stockholms län"
    title,
    summary,
    url: toPolisenUrl(raw.url),
    gps: parseGps(raw.location?.gps),
    searchText: `${type} ${place} ${county} ${title} ${summary}`.toLowerCase(),
  };
}

function byNewest(a, b) {
  const time = (event) => (Number.isFinite(event.time) ? event.time : -Infinity);
  return time(b) - time(a) || (b.published?.getTime() ?? 0) - (a.published?.getTime() ?? 0) || collator.compare(b.id, a.id);
}

/** Hela API-svaret → normaliserade händelser, nyast först. */
export function normalizeEvents(data) {
  if (!Array.isArray(data)) {
    throw new TypeError('Oväntat svar från Polisens API: förväntade en lista med händelser.');
  }
  return data.map(normalizeEvent).filter(Boolean).sort(byNewest);
}

/* ------------------------------------------------------------------ */
/* Filtrering och statistik                                            */
/* ------------------------------------------------------------------ */

export const collator = new Intl.Collator('sv', { sensitivity: 'base', numeric: true });

/**
 * Filtrera på fritext (alla ord måste finnas), län, typ och kategori.
 * Tomma filter ignoreras.
 */
export function filterEvents(events, { q = '', county = '', type = '', category = '' } = {}) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  return events.filter(
    (event) =>
      (!county || event.county === county) &&
      (!type || event.type === type) &&
      (!category || event.category === category) &&
      terms.every((term) => event.searchText.includes(term)),
  );
}

/** Räkna förekomster → [{ value, count }] sorterat i svensk bokstavsordning. */
export function countValues(events, key) {
  const counts = new Map();
  for (const event of events) counts.set(event[key], (counts.get(event[key]) ?? 0) + 1);
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => collator.compare(a.value, b.value));
}

function mostCommon(counts) {
  let top = null;
  for (const [value, count] of counts) {
    if (!top || count > top.count) top = { value, count };
  }
  return top;
}

export function computeStats(events, now = Date.now()) {
  let lastHour = 0;
  let lastDay = 0;
  let newest = null;
  let oldest = null;
  const types = new Map();
  const counties = new Map();

  for (const event of events) {
    counties.set(event.county, (counties.get(event.county) ?? 0) + 1);
    // Sammanfattningar är inte händelser i sig.
    if (event.category !== 'sammanfattning') types.set(event.type, (types.get(event.type) ?? 0) + 1);
    if (!event.date) continue;
    const age = now - event.time;
    if (age < HOUR) lastHour += 1;
    if (age < DAY) lastDay += 1;
    if (!newest || event.time > newest.getTime()) newest = event.date;
    if (!oldest || event.time < oldest.getTime()) oldest = event.date;
  }

  return {
    total: events.length,
    lastHour,
    lastDay,
    newest,
    oldest,
    topType: mostCommon(types),
    topCounty: mostCommon(counties),
  };
}

/* ------------------------------------------------------------------ */
/* Svenska tidsformat (alltid svensk tid, oavsett var läsaren är)      */
/* ------------------------------------------------------------------ */

const clockFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit' });
const dayKeyFormat = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const shortDateFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: TIME_ZONE, day: 'numeric', month: 'short' });
const fullFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: TIME_ZONE, dateStyle: 'long', timeStyle: 'short' });
const relativeFormat = new Intl.RelativeTimeFormat('sv', { numeric: 'auto' });

/** "14:32" */
export function formatClock(date) {
  return clockFormat.format(date);
}

/** "10 okt." */
export function formatShortDate(date) {
  return shortDateFormat.format(date);
}

/** "11 oktober 2026 kl. 14:32" */
export function formatFull(date) {
  return fullFormat.format(date);
}

/** Kalenderdag i svensk tid, "2026-10-11". */
export function dayKey(date) {
  return dayKeyFormat.format(date);
}

function shiftDayKey(key, days) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** "Idag", "Igår" eller t.ex. "Fredag 9 oktober". */
export function dayLabel(date, now = new Date()) {
  const key = dayKey(date);
  const today = dayKey(now);
  if (key === today) return 'Idag';
  if (key === shiftDayKey(today, -1)) return 'Igår';
  const sameYear = key.slice(0, 4) === today.slice(0, 4);
  const label = new Intl.DateTimeFormat('sv-SE', {
    timeZone: TIME_ZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(date);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** "nyss", "för 12 minuter sedan", "för 3 timmar sedan", "i förrgår" … */
export function relativeTime(date, now = Date.now()) {
  const diff = date.getTime() - now;
  const abs = Math.abs(diff);
  if (abs < MINUTE) return 'nyss';
  if (abs < HOUR) return relativeFormat.format(Math.round(diff / MINUTE), 'minute');
  if (abs < DAY) return relativeFormat.format(Math.round(diff / HOUR), 'hour');
  return relativeFormat.format(Math.round(diff / DAY), 'day');
}

/** Gruppera (redan sorterade) händelser per kalenderdag i svensk tid. */
export function groupByDay(events) {
  const groups = [];
  let current = null;
  for (const event of events) {
    const key = event.date ? dayKey(event.date) : 'okänt';
    if (!current || current.key !== key) {
      current = { key, date: event.date, events: [] };
      groups.push(current);
    }
    current.events.push(event);
  }
  return groups;
}
