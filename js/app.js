import {
  API_URL,
  CATEGORIES,
  TIME_ZONE,
  computeStats,
  countValues,
  dayKey,
  dayLabel,
  filterEvents,
  formatClock,
  formatFull,
  formatShortDate,
  groupByDay,
  mapUrl,
  normalizeEvents,
  relativeTime,
} from './polisen.js';

const REFRESH_INTERVAL = 5 * 60_000;
const RETRY_DELAYS = [15_000, 30_000, 60_000, 2 * 60_000, 5 * 60_000];
const REQUEST_TIMEOUT = 15_000;
const PAGE_SIZE = 50;
// Markera nya händelser bara om förra hämtningen är någorlunda färsk.
const MARK_NEW_WITHIN = 12 * 60 * 60_000;
const STORAGE = { events: 'polis-api-500:handelser', theme: 'polis-api-500:tema' };
const URL_PARAMS = { q: 'q', county: 'lan', type: 'typ', category: 'kategori' };

const $ = (selector) => document.querySelector(selector);
const ui = {
  live: $('#live'),
  liveLabel: $('#live-label'),
  refresh: $('#refresh'),
  theme: $('#theme'),
  form: $('#filters'),
  q: $('#q'),
  county: $('#county'),
  type: $('#type'),
  chips: $('#chips'),
  clear: $('#clear'),
  count: $('#count'),
  notice: $('#notice'),
  feed: $('#feed'),
  more: $('#more'),
  stat: Object.fromEntries(
    ['total', 'total-sub', 'day', 'day-sub', 'type', 'type-sub', 'where-label', 'where', 'where-sub'].map((id) => [
      id,
      $(`#stat-${id}`),
    ]),
  ),
};

const state = {
  events: [],
  fetchedAt: null,
  loading: false,
  error: null,
  failures: 0,
  newIds: new Set(),
  filters: readFiltersFromUrl(),
  limit: PAGE_SIZE,
};

/* ------------------------------------------------------------------ */
/* Hjälpfunktioner                                                     */
/* ------------------------------------------------------------------ */

/** Skapar ett element. Barn som är strängar blir textnoder (aldrig HTML). */
function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value == null || value === false) continue;
    if (name === 'class') node.className = value;
    else node.setAttribute(name, value === true ? '' : value);
  }
  node.append(...children.filter((child) => child != null && child !== false));
  return node;
}

function icon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Privat läge eller full lagring: sidan fungerar ändå.
  }
}

function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

const numberFormat = new Intl.NumberFormat('sv-SE');
const longDateFormat = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TIME_ZONE,
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

function plural(count, one, many) {
  return `${numberFormat.format(count)} ${count === 1 ? one : many}`;
}

/** "03:12" om det är idag, annars "8 okt. 03:12". */
function formatWhen(date) {
  return dayKey(date) === dayKey(new Date()) ? formatClock(date) : `${formatShortDate(date)} ${formatClock(date)}`;
}

/* ------------------------------------------------------------------ */
/* Hämtning                                                            */
/* ------------------------------------------------------------------ */

class ApiError extends Error {}

async function fetchEvents() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    const response = await fetch(API_URL, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) throw new ApiError(`Polisens API svarade med felkod ${response.status}.`);
    const data = await response.json();
    if (!Array.isArray(data)) throw new ApiError('Polisens API skickade ett oväntat svar.');
    // API:et svarar ibland en kort stund med en tom lista.
    if (data.length === 0) throw new ApiError('Polisens API svarade utan händelser just nu.');
    return { data, events: normalizeEvents(data) };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error.name === 'AbortError') throw new ApiError('Polisens API svarade inte i tid.');
    if (error instanceof SyntaxError) throw new ApiError('Svaret från Polisens API gick inte att läsa.');
    throw new ApiError(navigator.onLine === false ? 'Du verkar vara offline.' : 'Kunde inte nå Polisens API.');
  } finally {
    clearTimeout(timer);
  }
}

function loadCache() {
  try {
    const { savedAt, data } = JSON.parse(storageGet(STORAGE.events));
    if (!Number.isFinite(savedAt)) return null;
    const events = normalizeEvents(data);
    return events.length ? { events, savedAt: new Date(savedAt) } : null;
  } catch {
    return null;
  }
}

let refreshTimer = null;
let refreshDue = false;

function scheduleRefresh(delay) {
  clearTimeout(refreshTimer);
  refreshDue = false;
  refreshTimer = setTimeout(() => {
    // Hämta inte i onödan när fliken ligger i bakgrunden.
    if (document.visibilityState === 'visible') refresh();
    else refreshDue = true;
  }, delay);
}

async function refresh() {
  if (state.loading) return;
  state.loading = true;
  renderLive();

  try {
    const { data, events } = await fetchEvents();
    const previousAt = state.fetchedAt;
    const known = new Set(state.events.map((event) => event.id));
    const markNew = known.size > 0 && previousAt && Date.now() - previousAt < MARK_NEW_WITHIN;
    state.newIds = markNew
      ? new Set(events.filter((event) => !known.has(event.id)).map((event) => event.id))
      : new Set();
    Object.assign(state, { events, fetchedAt: new Date(), error: null, failures: 0 });
    storageSet(STORAGE.events, JSON.stringify({ savedAt: Date.now(), data }));
    scheduleRefresh(REFRESH_INTERVAL);
  } catch (error) {
    state.error = error;
    state.failures += 1;
    scheduleRefresh(RETRY_DELAYS[Math.min(state.failures, RETRY_DELAYS.length) - 1]);
  } finally {
    state.loading = false;
    render();
  }
}

/* ------------------------------------------------------------------ */
/* Filter och adressfält                                               */
/* ------------------------------------------------------------------ */

function readFiltersFromUrl() {
  const params = new URLSearchParams(location.search);
  const filters = {};
  for (const [key, name] of Object.entries(URL_PARAMS)) filters[key] = params.get(name)?.trim() ?? '';
  if (!CATEGORIES.some((category) => category.id === filters.category)) filters.category = '';
  return filters;
}

function writeFiltersToUrl() {
  const params = new URLSearchParams();
  for (const [key, name] of Object.entries(URL_PARAMS)) {
    const value = state.filters[key].trim();
    if (value) params.set(name, value);
  }
  const query = params.toString();
  const url = `${location.pathname}${query ? `?${query}` : ''}${location.hash}`;
  if (url !== `${location.pathname}${location.search}${location.hash}`) history.replaceState(null, '', url);
}

function hasFilters() {
  return Object.values(state.filters).some((value) => value.trim());
}

function setFilters(changes) {
  Object.assign(state.filters, changes);
  state.limit = PAGE_SIZE;
  render();
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function render() {
  const filtered = filterEvents(state.events, state.filters);
  renderLive();
  renderStats(filtered);
  renderFilters();
  renderNotice();
  renderFeed(filtered);
  writeFiltersToUrl();
}

function renderLive() {
  const { loading, error, events, fetchedAt } = state;
  let status;
  let label;
  if (loading) {
    status = 'loading';
    label = events.length ? 'Uppdaterar…' : 'Hämtar händelser…';
  } else if (error) {
    status = events.length ? 'stale' : 'error';
    label = events.length
      ? `Kunde inte uppdatera · data från ${formatWhen(fetchedAt)}`
      : 'Ingen kontakt med Polisens API';
  } else {
    status = 'live';
    label = `Live · uppdaterad ${formatClock(fetchedAt)}`;
  }
  ui.live.dataset.state = status;
  ui.liveLabel.textContent = label;
  ui.refresh.setAttribute('aria-busy', String(loading));
}

function renderStats(filtered) {
  const { stat } = ui;
  if (!state.events.length) return;

  const stats = computeStats(filtered);
  stat.total.textContent = numberFormat.format(stats.total);
  stat['total-sub'].textContent = stats.oldest
    ? `${formatShortDate(stats.oldest)} – ${formatShortDate(stats.newest)}`
    : 'Inga träffar';
  stat.day.textContent = numberFormat.format(stats.lastDay);
  stat['day-sub'].textContent = `${numberFormat.format(stats.lastHour)} senaste timmen`;
  stat.type.textContent = stats.topType?.value ?? '–';
  stat['type-sub'].textContent = stats.topType ? plural(stats.topType.count, 'händelse', 'händelser') : '';

  // Med ett län valt är det mer intressant vilken ort som har flest händelser.
  const top = state.filters.county ? stats.topPlace : stats.topCounty;
  stat['where-label'].textContent = state.filters.county ? 'Flest i länet' : 'Flest händelser';
  stat.where.textContent = top?.value ?? '–';
  stat['where-sub'].textContent = top ? plural(top.count, 'händelse', 'händelser') : '';
}

function fillSelect(select, allLabel, options, selected) {
  const values = options.map((option) => option.value);
  if (selected && !values.includes(selected)) options = [...options, { value: selected, count: 0 }];
  select.replaceChildren(
    el('option', { value: '' }, allLabel),
    ...options.map(({ value, count }) => el('option', { value }, `${value} (${numberFormat.format(count)})`)),
  );
  select.value = selected;
}

function renderFilters() {
  const { events, filters } = state;

  // Varje filter visar antal givet de andra filtren.
  const forCounty = filterEvents(events, { ...filters, county: '' });
  const countyCounts = new Map(countValues(forCounty, 'county').map(({ value, count }) => [value, count]));
  const counties = countValues(events, 'county').map(({ value }) => ({ value, count: countyCounts.get(value) ?? 0 }));
  fillSelect(ui.county, 'Hela Sverige', counties, filters.county);

  const forType = filterEvents(events, { ...filters, type: '' });
  fillSelect(ui.type, 'Alla typer', countValues(forType, 'type'), filters.type);

  const forCategory = filterEvents(events, { ...filters, category: '' });
  const categoryCounts = new Map(countValues(forCategory, 'category').map(({ value, count }) => [value, count]));
  for (const chip of ui.chips.children) {
    const value = chip.dataset.value;
    const count = value ? (categoryCounts.get(value) ?? 0) : forCategory.length;
    chip.setAttribute('aria-pressed', String(filters.category === value));
    chip.toggleAttribute('data-empty', events.length > 0 && count === 0);
    chip.querySelector('.chip__count').textContent = events.length ? numberFormat.format(count) : '';
  }

  ui.clear.hidden = !hasFilters();
}

let lastNotice = '';

function renderNotice() {
  const { error, events, fetchedAt } = state;
  const key = error ? `${error.message}|${events.length > 0}` : '';
  if (key === lastNotice) return;
  lastNotice = key;

  if (!error) {
    ui.notice.hidden = true;
    ui.notice.replaceChildren();
    return;
  }
  const stale = events.length > 0;
  ui.notice.className = `notice ${stale ? 'notice--warn' : 'notice--error'}`;
  ui.notice.replaceChildren(
    icon('i-alert'),
    el(
      'div',
      {},
      el('p', { class: 'notice__title' }, stale ? 'Kunde inte uppdatera just nu' : 'Kunde inte hämta händelserna'),
      el(
        'p',
        { class: 'notice__text' },
        `${error.message} `,
        stale
          ? `Visar händelserna från ${formatWhen(fetchedAt)}. Sidan försöker igen automatiskt.`
          : 'Sidan försöker igen automatiskt.',
      ),
      stale
        ? null
        : el('button', { class: 'btn btn--outline', type: 'button', 'data-action': 'refresh' }, 'Försök igen'),
    ),
  );
  ui.notice.hidden = false;
}

function renderFeed(filtered) {
  const { events, error } = state;
  ui.feed.setAttribute('aria-busy', String(!events.length && !error));

  if (!events.length) {
    // Behåll skelettet medan första hämtningen pågår.
    if (error) ui.feed.replaceChildren();
    ui.count.textContent = '';
    ui.more.hidden = true;
    return;
  }

  ui.count.textContent = hasFilters()
    ? `${numberFormat.format(filtered.length)} av ${plural(events.length, 'händelse', 'händelser')}`
    : `${plural(events.length, 'händelse', 'händelser')} · nyast först`;

  if (!filtered.length) {
    ui.feed.replaceChildren(
      el(
        'div',
        { class: 'empty' },
        el('p', { class: 'empty__title' }, 'Inga träffar'),
        el('p', {}, 'Inga händelser matchar filtret just nu.'),
        el('button', { class: 'btn btn--outline', type: 'button', 'data-action': 'clear' }, 'Rensa filter'),
      ),
    );
    ui.more.hidden = true;
    return;
  }

  const visible = filtered.slice(0, state.limit);
  const perDay = new Map();
  for (const event of filtered) {
    const key = event.date ? dayKey(event.date) : 'okänt';
    perDay.set(key, (perDay.get(key) ?? 0) + 1);
  }

  const now = new Date();
  ui.feed.replaceChildren(
    ...groupByDay(visible).map((group) => {
      const label = group.date ? dayLabel(group.date, now) : 'Okänt datum';
      const relative = label === 'Idag' || label === 'Igår';
      const headingId = `dag-${group.key}`;
      return el(
        'section',
        { class: 'day', 'aria-labelledby': headingId },
        el(
          'h3',
          { class: 'day__head', id: headingId },
          el('span', {}, label),
          relative ? el('span', { class: 'day__date' }, longDateFormat.format(group.date)) : null,
          el('span', { class: 'day__count' }, plural(perDay.get(group.key), 'händelse', 'händelser')),
        ),
        el('ol', { class: 'day__list' }, ...group.events.map((event) => el('li', {}, renderEvent(event, now)))),
      );
    }),
  );

  const remaining = filtered.length - visible.length;
  ui.more.hidden = remaining <= 0;
  ui.more.textContent = `Visa fler (${numberFormat.format(remaining)} till)`;
}

function renderEvent(event, now) {
  const isNew = state.newIds.has(event.id);
  const titleId = `h-${event.id.replace(/[^\w-]/g, '_')}`;
  const publishedLate = event.published && event.date && event.published - event.date >= 30 * 60_000;
  const map = mapUrl(event);

  return el(
    'article',
    { class: isNew ? 'event is-new' : 'event', 'data-cat': event.category, 'aria-labelledby': titleId, tabindex: '-1' },
    el('div', { class: 'event__icon', 'aria-hidden': 'true' }, icon(`i-${event.category}`)),
    el(
      'div',
      { class: 'event__body' },
      el(
        'div',
        { class: 'event__head' },
        el(
          'h4',
          { class: 'event__type', id: titleId },
          event.type,
          isNew ? el('span', { class: 'badge' }, 'Ny') : null,
        ),
        event.date
          ? el(
              'time',
              { class: 'event__time', datetime: event.date.toISOString(), title: formatFull(event.date) },
              formatClock(event.date),
            )
          : null,
      ),
      el(
        'p',
        { class: 'event__where' },
        icon('i-pin'),
        el('span', { class: 'event__place' }, event.place),
        event.county !== event.place ? el('span', { class: 'event__county' }, event.county) : null,
      ),
      event.summary ? el('p', { class: 'event__summary' }, event.summary) : null,
      el(
        'div',
        { class: 'event__foot' },
        el(
          'span',
          { class: 'event__when' },
          event.date ? el('span', { 'data-time': String(event.time) }, relativeTime(event.date, now)) : null,
          publishedLate ? ` · publicerad ${formatWhen(event.published)}` : null,
        ),
        event.url
          ? el(
              'a',
              { class: 'event__link', href: event.url, target: '_blank', rel: 'noopener' },
              'Läs på polisen.se',
              el('span', { class: 'sr-only' }, ` om ${event.type}, ${event.place}`),
              icon('i-external'),
            )
          : null,
        map
          ? el(
              'a',
              { class: 'event__link', href: map, target: '_blank', rel: 'noopener' },
              'Karta',
              el('span', { class: 'sr-only' }, ` över ${event.place}`),
              icon('i-external'),
            )
          : null,
      ),
    ),
  );
}

function updateRelativeTimes() {
  const now = Date.now();
  for (const node of ui.feed.querySelectorAll('[data-time]')) {
    node.textContent = relativeTime(new Date(Number(node.dataset.time)), now);
  }
}

/* ------------------------------------------------------------------ */
/* Färgtema                                                            */
/* ------------------------------------------------------------------ */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  ui.theme.setAttribute('aria-label', theme === 'dark' ? 'Byt till ljust läge' : 'Byt till mörkt läge');
}

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

function init() {
  ui.chips.replaceChildren(
    ...[{ id: '', label: 'Alla' }, ...CATEGORIES].map(({ id, label }) =>
      el(
        'button',
        { class: 'chip', type: 'button', 'data-value': id, 'data-cat': id || null, 'aria-pressed': 'false' },
        id ? el('span', { class: 'chip__dot', 'aria-hidden': 'true' }) : null,
        label,
        el('span', { class: 'chip__count' }),
      ),
    ),
  );
  ui.q.value = state.filters.q;
  applyTheme(document.documentElement.dataset.theme);

  ui.q.addEventListener(
    'input',
    debounce(() => setFilters({ q: ui.q.value }), 150),
  );
  ui.q.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && ui.q.value) {
      ui.q.value = '';
      setFilters({ q: '' });
    }
  });
  ui.county.addEventListener('change', () => setFilters({ county: ui.county.value }));
  ui.type.addEventListener('change', () => setFilters({ type: ui.type.value }));
  ui.chips.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    const { value } = chip.dataset;
    setFilters({ category: value && state.filters.category === value ? '' : value });
  });
  ui.form.addEventListener('submit', (event) => {
    event.preventDefault();
    // "Sök" på mobilens tangentbord: stäng tangentbordet så att resultaten syns.
    if (matchMedia('(hover: none)').matches) ui.q.blur();
  });
  ui.form.addEventListener('reset', (event) => {
    event.preventDefault();
    ui.q.value = '';
    setFilters({ q: '', county: '', type: '', category: '' });
    ui.q.focus();
  });

  ui.more.addEventListener('click', () => {
    const firstNew = state.limit;
    state.limit += PAGE_SIZE;
    render();
    ui.feed.querySelectorAll('.event')[firstNew]?.focus();
  });
  document.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'refresh') refresh();
    if (action === 'clear') ui.form.reset();
  });
  ui.refresh.addEventListener('click', () => refresh());

  ui.theme.addEventListener('click', () => {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    storageSet(STORAGE.theme, theme);
    applyTheme(theme);
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
    if (!storageGet(STORAGE.theme)) applyTheme(event.matches ? 'dark' : 'light');
  });

  // "/" hoppar till sökfältet.
  document.addEventListener('keydown', (event) => {
    const typing = event.target.closest?.('input, select, textarea, [contenteditable]');
    if (event.key === '/' && !typing && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      ui.q.focus();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const stale = !state.fetchedAt || Date.now() - state.fetchedAt >= REFRESH_INTERVAL;
    if (refreshDue || stale) refresh();
  });
  window.addEventListener('online', () => refresh());
  setInterval(updateRelativeTimes, 60_000);

  // Visa sparade händelser direkt och hämta nya i bakgrunden.
  const cached = loadCache();
  if (cached) Object.assign(state, { events: cached.events, fetchedAt: cached.savedAt });
  render();
  refresh();
}

init();
