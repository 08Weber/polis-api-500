/**
 * Datalager för Polisens öppna API över händelser.
 *
 * Bara rena funktioner utan DOM, så att samma kod används av sidan,
 * av testerna (test/) och av API-kontrollen (scripts/check-api.mjs).
 *
 * Dokumentation:
 * https://polisen.se/om-polisen/om-webbplatsen/oppna-data/api-over-polisens-handelser/
 */

export const API_URL = 'https://polisen.se/api/events';
export const POLISEN_URL = 'https://polisen.se';
export const TIME_ZONE = 'Europe/Stockholm';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/* ------------------------------------------------------------------ */
/* Tolkning av API-fälten                                              */
/* ------------------------------------------------------------------ */

// API:et skickar t.ex. "2026-10-11 2:13:45 +02:00" – mellanslag i stället
// för "T" och ibland timmen utan inledande nolla. Det formatet klarar inte
// alla webbläsare (t.ex. Safari) med new Date(), så vi tolkar det själva.
const DATETIME_RE =
  /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

/** Matchar värdet API:ets kända datumformat? */
export function isApiDateTime(value) {
  return typeof value === 'string' && DATETIME_RE.test(value.trim());
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
  if (parts[1] < 0 || parts[1] > 11 || parts[2] < 1 || parts[2] > 31 || parts[3] > 23 || parts[4] > 59 || parts[5] > 59) {
    return null;
  }

  let time;
  if (!zone) {
    time = new Date(...parts).getTime();
  } else {
    time = Date.UTC(...parts);
    if (zone.toUpperCase() !== 'Z') {
      const sign = zone[0] === '-' ? -1 : 1;
      const digits = zone.slice(1).replace(':', '');
      time -= sign * (+digits.slice(0, 2) * 60 + +digits.slice(2)) * MINUTE;
    }
  }
  return Number.isNaN(time) ? null : new Date(time);
}

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
 * API:et ger relativa länkar ("/aktuellt/handelser/2026/oktober/11/...").
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

/** Länk till OpenStreetMap för en koordinat. */
export function mapUrl(gps, zoom = 11) {
  if (!gps) return null;
  const lat = gps.lat.toFixed(5);
  const lng = gps.lng.toFixed(5);
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=${zoom}/${lat}/${lng}`;
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
// "Trafikolycka" ska bli trafik (inte olycka) och "Motorfordon, stöld" stöld.
// Nyckelord i stället för en fast lista, så att nya händelsetyper ändå hamnar rätt.
const CATEGORY_RULES = [
  ['sammanfattning', /^(sammanfattning|uppdatering)/],
  ['stold', /stöld|stulet|inbrott|häleri|snatteri|skadegörelse|bedrägeri|förfalskning|urkund|ekobrott|intrång|hemfrid/],
  ['trafik', /trafik|rattfylleri|olovlig körning|motorfordon/],
  [
    'vald',
    /mord|dråp|misshandel|(^|[^a-zåäö])rån|skottlossning|skjutning|detonation|sprängning|explosion|bombhot|våld|olaga hot|frihetsberövande|knivlag|vapenlag|överfall|bråk|ofredande|sedlighet|sexualbrott|kroppsskada|farligt föremål/,
  ],
  ['brand', /brand|olycka|olycksfall|räddning|drunkn|naturkatastrof|haveri|varningslarm|kemikalie|översvämning/],
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

  const date = parseDateTime(raw.datetime);
  const type = text(raw.type) || 'Händelse';
  const location = text(raw.location?.name) || 'Okänd plats';
  const title = text(raw.name);
  const summary = text(raw.summary);

  return {
    id: String(raw.id ?? `${raw.datetime}|${title}`),
    date,
    time: date ? date.getTime() : Number.NaN,
    type,
    category: categorize(type),
    location,
    title,
    summary,
    url: toPolisenUrl(raw.url),
    gps: parseGps(raw.location?.gps),
    searchText: `${type} ${location} ${title} ${summary}`.toLowerCase(),
  };
}

/** Hela API-svaret → normaliserade händelser, nyast först. */
export function normalizeEvents(data) {
  if (!Array.isArray(data)) {
    throw new TypeError('Oväntat svar från Polisens API: förväntade en lista med händelser.');
  }
  const sortTime = (event) => (Number.isFinite(event.time) ? event.time : -Infinity);
  return data
    .map(normalizeEvent)
    .filter(Boolean)
    .sort((a, b) => sortTime(b) - sortTime(a));
}

/* ------------------------------------------------------------------ */
/* Filtrering och statistik                                            */
/* ------------------------------------------------------------------ */

export const collator = new Intl.Collator('sv', { sensitivity: 'base', numeric: true });

/**
 * Filtrera på fritext (alla ord måste finnas), plats, typ och kategori.
 * Tomma filter ignoreras.
 */
export function filterEvents(events, { q = '', location = '', type = '', category = '' } = {}) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  return events.filter(
    (event) =>
      (!location || event.location === location) &&
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

export function computeStats(events, now = Date.now()) {
  let lastHour = 0;
  let lastDay = 0;
  let newest = null;
  let oldest = null;
  const typeCounts = new Map();

  for (const event of events) {
    if (!event.date) continue;
    const age = now - event.time;
    if (age < HOUR) lastHour += 1;
    if (age < DAY) {
      lastDay += 1;
      if (event.category !== 'sammanfattning') {
        typeCounts.set(event.type, (typeCounts.get(event.type) ?? 0) + 1);
      }
    }
    if (!newest || event.time > newest.getTime()) newest = event.date;
    if (!oldest || event.time < oldest.getTime()) oldest = event.date;
  }

  let topType = null;
  for (const [type, count] of typeCounts) {
    if (!topType || count > topType.count) topType = { type, count };
  }

  return { total: events.length, lastHour, lastDay, topType, newest, oldest };
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
const fullFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: TIME_ZONE, dateStyle: 'long', timeStyle: 'short' });
const relativeFormat = new Intl.RelativeTimeFormat('sv', { numeric: 'auto' });

/** "14:32" */
export function formatClock(date) {
  return clockFormat.format(date);
}

/** "11 oktober 2026 14:32" */
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
