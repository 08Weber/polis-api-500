import {
  API_URL,
  CATEGORIES,
  HOME_COUNTY,
  HOME_MUNICIPALITIES,
  TIME_ZONE,
  collator,
  computeStats,
  countValues,
  countyUrl,
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
const REQUEST_TIMEOUT = 20_000;
const PAGE_SIZE = 50;
// Markera nya händelser bara om förra hämtningen är någorlunda färsk.
const MARK_NEW_WITHIN = 12 * 60 * 60_000;
// Notiser bara för händelser som publicerats nyligen, aldrig för gamla.
const NOTIFY_MAX_AGE = 2 * 60 * 60_000;
const STORAGE = {
  theme: 'polis-api-500:tema',
  notify: 'polis-api-500:notiser',
  seen: 'polis-api-500:sedda',
  cache: (scope) => `polis-api-500:handelser:${scope}`,
};

// Östergötland i första hand, hela Sverige som tillval.
const SCOPES = {
  ostergotland: {
    url: countyUrl(HOME_COUNTY),
    name: 'Östergötland',
    all: 'Hela Östergötland',
    locationLabel: 'Ort',
    locationKey: 'place',
  },
  sverige: { url: API_URL, name: 'Sverige', all: 'Hela Sverige', locationLabel: 'Län', locationKey: 'county' },
};
const HOME = 'ostergotland';
const URL_PARAMS = { q: 'q', place: 'ort', county: 'lan', type: 'typ', category: 'kategori' };

const $ = (selector) => document.querySelector(selector);
const ui = {
  live: $('#live'),
  liveLabel: $('#live-label'),
  refresh: $('#refresh'),
  theme: $('#theme'),
  heroTitle: $('#hero-title'),
  form: $('#filters'),
  q: $('#q'),
  location: $('#location'),
  locationLabel: $('#location-label'),
  type: $('#type'),
  chips: $('#chips'),
  clear: $('#clear'),
  count: $('#count'),
  notice: $('#notice'),
  feed: $('#feed'),
  more: $('#more'),
  notifyButton: $('#notify-button'),
  notifyPanel: $('#notify-panel'),
  notifyOn: $('#notify-on'),
  notifyArea: $('#notify-area'),
  notifyTest: $('#notify-test'),
  notifyStatus: $('#notify-status'),
  stat: Object.fromEntries(
    ['total', 'total-sub', 'day', 'day-sub', 'type', 'type-sub', 'where-label', 'where', 'where-sub'].map((id) => [
      id,
      $(`#stat-${id}`),
    ]),
  ),
};

/** En datakälla per område. */
const sources = Object.fromEntries(
  Object.keys(SCOPES).map((scope) => [
    scope,
    {
      events: [],
      fetchedAt: null,
      loading: false,
      error: null,
      failures: 0,
      newIds: new Set(),
      timer: null,
      due: false,
    },
  ]),
);

const state = {
  ...readStateFromUrl(),
  limit: PAGE_SIZE,
  // Händelse att visa när sidan öppnas från en notis (#h-<id>).
  pendingEventId: location.hash.startsWith('#h-') ? location.hash.slice(3) : null,
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

function eventDomId(id) {
  return `h-${String(id).replace(/[^\w-]/g, '_')}`;
}

/* ------------------------------------------------------------------ */
/* Hämtning                                                            */
/* ------------------------------------------------------------------ */

class ApiError extends Error {}

async function fetchEvents(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    const response = await fetch(url, {
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

/** Länsfiltret i API:et ska bara ge länets händelser, men vi litar inte blint på det. */
function eventsForScope(scope, events) {
  return scope === HOME ? events.filter((event) => event.county === HOME_COUNTY) : events;
}

function loadCache(scope) {
  const source = sources[scope];
  if (source.events.length) return;
  try {
    const { savedAt, data } = JSON.parse(storageGet(STORAGE.cache(scope)));
    if (!Number.isFinite(savedAt)) return;
    const events = eventsForScope(scope, normalizeEvents(data));
    if (events.length) Object.assign(source, { events, fetchedAt: new Date(savedAt) });
  } catch {
    // Ingen eller trasig sparad data.
  }
}

function isStale(scope) {
  const { fetchedAt } = sources[scope];
  return !fetchedAt || Date.now() - fetchedAt >= REFRESH_INTERVAL;
}

function schedule(scope, delay) {
  const source = sources[scope];
  clearTimeout(source.timer);
  source.due = false;
  source.timer = setTimeout(() => {
    const visible = scope === state.scope && document.visibilityState === 'visible';
    // Med notiser på hämtas länet även när fliken ligger i bakgrunden.
    const watching = scope === HOME && notificationsOn();
    if (visible || watching) refresh(scope);
    else source.due = true;
  }, delay);
}

async function refresh(scope = state.scope) {
  const source = sources[scope];
  if (source.loading) return;
  source.loading = true;
  if (scope === state.scope) renderLive();

  try {
    const result = await fetchEvents(SCOPES[scope].url);
    const events = eventsForScope(scope, result.events);
    const known = new Set(source.events.map((event) => event.id));
    const markNew = known.size > 0 && source.fetchedAt && Date.now() - source.fetchedAt < MARK_NEW_WITHIN;
    source.newIds = markNew
      ? new Set(events.filter((event) => !known.has(event.id)).map((event) => event.id))
      : new Set();
    Object.assign(source, { events, fetchedAt: new Date(), error: null, failures: 0 });
    storageSet(STORAGE.cache(scope), JSON.stringify({ savedAt: Date.now(), data: result.data }));
    if (scope === HOME) notifyAboutNew(events);
    schedule(scope, REFRESH_INTERVAL);
  } catch (error) {
    source.error = error;
    source.failures += 1;
    schedule(scope, RETRY_DELAYS[Math.min(source.failures, RETRY_DELAYS.length) - 1]);
  } finally {
    source.loading = false;
    if (scope === state.scope) render();
  }
}

/* ------------------------------------------------------------------ */
/* Område, filter och adressfält                                       */
/* ------------------------------------------------------------------ */

function readStateFromUrl() {
  const params = new URLSearchParams(location.search);
  const scope = params.get('omrade') === 'sverige' ? 'sverige' : HOME;
  const filters = {};
  for (const [key, name] of Object.entries(URL_PARAMS)) filters[key] = params.get(name)?.trim() ?? '';
  // Ort hör till Östergötland och län till hela Sverige.
  if (scope === HOME) filters.county = '';
  else filters.place = '';
  if (!CATEGORIES.some((category) => category.id === filters.category)) filters.category = '';
  return { scope, filters };
}

function writeStateToUrl() {
  const params = new URLSearchParams();
  if (state.scope !== HOME) params.set('omrade', state.scope);
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

function setScope(scope) {
  if (scope === state.scope || !SCOPES[scope]) return;
  state.scope = scope;
  state.filters.place = '';
  state.filters.county = '';
  state.limit = PAGE_SIZE;
  loadCache(scope);
  render();
  if (isStale(scope) || sources[scope].due) refresh(scope);
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function render() {
  const filtered = filterEvents(sources[state.scope].events, state.filters);
  renderScope();
  renderLive();
  renderStats(filtered);
  renderFilters();
  renderNotice();
  renderFeed(filtered);
  writeStateToUrl();
  showPendingEvent();
}

function renderScope() {
  const scope = SCOPES[state.scope];
  ui.heroTitle.textContent = `Lägesbild ${scope.name}`;
  ui.locationLabel.textContent = scope.locationLabel;
  for (const radio of ui.form.elements.omrade) radio.checked = radio.value === state.scope;
}

function renderLive() {
  const { loading, error, events, fetchedAt } = sources[state.scope];
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
  } else if (fetchedAt) {
    status = 'live';
    label = `Live · uppdaterad ${formatClock(fetchedAt)}`;
  } else {
    status = 'loading';
    label = 'Hämtar händelser…';
  }
  ui.live.dataset.state = status;
  ui.liveLabel.textContent = label;
  ui.refresh.setAttribute('aria-busy', String(loading));
}

function renderStats(filtered) {
  const { stat } = ui;
  const { events } = sources[state.scope];
  if (!events.length) {
    for (const id of ['total', 'day', 'type', 'where']) stat[id].textContent = '–';
    for (const id of ['total-sub', 'day-sub', 'type-sub', 'where-sub']) stat[id].textContent = '';
    return;
  }

  const stats = computeStats(filtered);
  const home = state.scope === HOME;
  stat.total.textContent = numberFormat.format(stats.total);
  stat['total-sub'].textContent = stats.oldest
    ? `${formatShortDate(stats.oldest)} – ${formatShortDate(stats.newest)}`
    : 'Inga träffar';
  stat.day.textContent = numberFormat.format(stats.lastDay);
  // Länet har färre händelser, så veckan säger mer än timmen.
  stat['day-sub'].textContent = home
    ? `${numberFormat.format(stats.lastWeek)} senaste veckan`
    : `${numberFormat.format(stats.lastHour)} senaste timmen`;
  stat.type.textContent = stats.topType?.value ?? '–';
  stat['type-sub'].textContent = stats.topType ? plural(stats.topType.count, 'händelse', 'händelser') : '';

  // Inom ett län är det mer intressant vilken ort som har flest händelser.
  const byPlace = home || state.filters.county;
  const top = byPlace ? stats.topPlace : stats.topCounty;
  stat['where-label'].textContent = byPlace ? 'Flest i länet' : 'Flest händelser';
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
  const { events } = sources[state.scope];
  const { filters } = state;
  const scope = SCOPES[state.scope];
  const key = scope.locationKey;

  // Varje filter visar antal givet de andra filtren.
  const forLocation = filterEvents(events, { ...filters, [key]: '' });
  const counts = new Map(countValues(forLocation, key).map(({ value, count }) => [value, count]));
  // Alla länets kommuner finns alltid med, även utan händelser just nu.
  const values = new Set(countValues(events, key).map(({ value }) => value));
  if (state.scope === HOME) for (const municipality of HOME_MUNICIPALITIES) values.add(municipality);
  const locations = [...values]
    .sort((a, b) => collator.compare(a, b))
    .map((value) => ({ value, count: counts.get(value) ?? 0 }));
  fillSelect(ui.location, scope.all, locations, filters[key]);

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
  const { error, events, fetchedAt } = sources[state.scope];
  const key = error ? `${state.scope}|${error.message}|${events.length > 0}` : '';
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
  const { events, error, newIds } = sources[state.scope];
  ui.feed.setAttribute('aria-busy', String(!events.length && !error));

  if (!events.length) {
    // Behåll skelettet medan första hämtningen pågår.
    if (error) ui.feed.replaceChildren();
    ui.count.textContent = '';
    ui.more.hidden = true;
    return;
  }

  const where = `i ${SCOPES[state.scope].name}`;
  ui.count.textContent = hasFilters()
    ? `${numberFormat.format(filtered.length)} av ${plural(events.length, 'händelse', 'händelser')} ${where}`
    : `${plural(events.length, 'händelse', 'händelser')} ${where} · nyast först`;

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
        el(
          'ol',
          { class: 'day__list' },
          ...group.events.map((event) => el('li', {}, renderEvent(event, now, newIds.has(event.id)))),
        ),
      );
    }),
  );

  const remaining = filtered.length - visible.length;
  ui.more.hidden = remaining <= 0;
  ui.more.textContent = `Visa fler (${numberFormat.format(remaining)} till)`;
}

function renderEvent(event, now, isNew) {
  const titleId = eventDomId(event.id);
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

/** Visa en händelse, t.ex. när sidan öppnas från en notis. */
function showEvent(id) {
  state.pendingEventId = null;
  if (state.scope !== HOME) setScope(HOME);
  const { events } = sources[HOME];
  const index = events.findIndex((event) => event.id === String(id));
  if (index === -1) return false;
  if (!filterEvents(events, state.filters).some((event) => event.id === String(id))) {
    Object.assign(state.filters, { q: '', place: '', county: '', type: '', category: '' });
    ui.q.value = '';
  }
  state.limit = Math.max(state.limit, index + 1);
  render();
  const article = document.getElementById(eventDomId(id))?.closest('.event');
  if (!article) return false;
  const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  article.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
  article.focus({ preventScroll: true });
  article.classList.add('is-highlighted');
  setTimeout(() => article.classList.remove('is-highlighted'), 4000);
  return true;
}

function showPendingEvent() {
  const id = state.pendingEventId;
  if (!id || state.scope !== HOME || !sources[HOME].events.length) return;
  state.pendingEventId = null;
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  queueMicrotask(() => showEvent(id));
}

/* ------------------------------------------------------------------ */
/* Notiser                                                             */
/* ------------------------------------------------------------------ */

// primed: nästa hämtning ska bara markera allt som sett (när notiser slås på före första hämtningen).
const notify = { settings: readNotifySettings(), registration: null, primed: false };

function readNotifySettings() {
  try {
    const saved = JSON.parse(storageGet(STORAGE.notify));
    return { on: saved?.on === true, area: typeof saved?.area === 'string' ? saved.area : '' };
  } catch {
    return { on: false, area: '' };
  }
}

function saveNotifySettings() {
  storageSet(STORAGE.notify, JSON.stringify(notify.settings));
}

function notificationPermission() {
  return 'Notification' in window ? Notification.permission : 'unsupported';
}

function notificationsOn() {
  return notify.settings.on && notificationPermission() === 'granted';
}

function areaName() {
  return notify.settings.area || 'Östergötland';
}

function readSeen() {
  try {
    return new Set(JSON.parse(storageGet(STORAGE.seen)) ?? []);
  } catch {
    return new Set();
  }
}

function writeSeen(seen) {
  storageSet(STORAGE.seen, JSON.stringify([...seen].slice(-1000)));
}

function markSeen(events) {
  const seen = readSeen();
  for (const event of events) seen.add(event.id);
  writeSeen(seen);
}

/** Service worker behövs för notiser på Android och för att kunna klicka på dem. */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return Promise.resolve(null);
  notify.registration ??= navigator.serviceWorker
    .register('sw.js')
    .then(() => navigator.serviceWorker.ready)
    .catch(() => null);
  return notify.registration;
}

async function showNotification(title, options) {
  const settings = { lang: 'sv', icon: new URL('icon-192.png', location.href).href, ...options };
  try {
    const registration = await registerServiceWorker();
    if (registration?.showNotification) {
      await registration.showNotification(title, settings);
      return true;
    }
  } catch {
    // Prova det enklare sättet nedan.
  }
  try {
    const notification = new Notification(title, settings);
    notification.onclick = () => {
      window.focus();
      if (settings.data?.id) showEvent(settings.data.id);
      notification.close();
    };
    return true;
  } catch {
    return false;
  }
}

function notificationUrl(id) {
  return new URL(id ? `./#h-${id}` : './', location.href).href;
}

async function notifyAboutNew(events) {
  if (!notificationsOn()) return;
  if (notify.primed) {
    notify.primed = false;
    markSeen(events);
    return;
  }
  const seen = readSeen();
  const now = Date.now();
  const fresh = [];
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    const time = (event.published ?? event.date)?.getTime() ?? 0;
    if (now - time > NOTIFY_MAX_AGE) continue;
    // Sammanfattningar är inga händelser i sig.
    if (event.category === 'sammanfattning') continue;
    if (notify.settings.area && event.place !== notify.settings.area) continue;
    fresh.push(event);
  }
  writeSeen(seen);
  if (!fresh.length) return;

  if (fresh.length > 3) {
    await showNotification(`${fresh.length} nya händelser i ${areaName()}`, {
      body: fresh
        .slice(0, 4)
        .map((event) => `${event.date ? `${formatClock(event.date)} ` : ''}${event.type}, ${event.place}`)
        .join('\n'),
      tag: 'utryckning-flera',
      data: { url: notificationUrl() },
    });
    return;
  }
  for (const event of fresh) {
    await showNotification(`${event.type} · ${event.place}`, {
      body: [event.date ? formatClock(event.date) : '', event.summary].filter(Boolean).join(' – '),
      tag: eventDomId(event.id),
      data: { url: notificationUrl(event.id), id: event.id },
    });
  }
}

async function setNotificationsOn(on) {
  if (!on) {
    notify.settings.on = false;
    saveNotifySettings();
    renderNotify();
    return;
  }
  if (notificationPermission() === 'unsupported') {
    renderNotify();
    return;
  }
  let permission = Notification.permission;
  if (permission === 'default') permission = await Notification.requestPermission();
  notify.settings.on = permission === 'granted';
  saveNotifySettings();
  if (notify.settings.on) {
    // Bara nya händelser från och med nu.
    if (sources[HOME].fetchedAt) markSeen(sources[HOME].events);
    else notify.primed = true;
    registerServiceWorker();
    if (isStale(HOME)) refresh(HOME);
    else schedule(HOME, REFRESH_INTERVAL);
  }
  renderNotify();
}

function isIos() {
  return (
    /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

function renderNotify() {
  const permission = notificationPermission();
  const on = notificationsOn();
  ui.notifyButton.dataset.state = on ? 'on' : permission === 'denied' ? 'blocked' : 'off';
  ui.notifyButton.setAttribute('aria-label', on ? `Notiser på för ${areaName()}` : 'Notiser');
  ui.notifyOn.checked = on;
  ui.notifyOn.disabled = permission === 'denied' || permission === 'unsupported';
  ui.notifyArea.value = notify.settings.area;
  ui.notifyArea.disabled = !on;
  ui.notifyTest.disabled = !on;

  let status = '';
  if (permission === 'unsupported') {
    status = isIos()
      ? 'På iPhone fungerar notiser när sidan är tillagd på hemskärmen: tryck på Dela, välj Lägg till på hemskärmen och öppna den sedan därifrån.'
      : 'Den här webbläsaren kan inte visa notiser.';
  } else if (permission === 'denied') {
    status = 'Notiser är blockerade för sidan. Tillåt dem i webbläsarens inställningar för sidan.';
  } else if (on) {
    status = `Notiser är på för ${areaName()}.`;
  }
  ui.notifyStatus.textContent = status;
}

function toggleNotifyPanel(open = ui.notifyPanel.hidden) {
  ui.notifyPanel.hidden = !open;
  ui.notifyButton.setAttribute('aria-expanded', String(open));
  if (open) renderNotify();
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
  ui.notifyArea.replaceChildren(
    el('option', { value: '' }, 'Hela Östergötland'),
    ...HOME_MUNICIPALITIES.map((municipality) => el('option', { value: municipality }, municipality)),
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
  ui.location.addEventListener('change', () => setFilters({ [SCOPES[state.scope].locationKey]: ui.location.value }));
  ui.type.addEventListener('change', () => setFilters({ type: ui.type.value }));
  ui.form.addEventListener('change', (event) => {
    if (event.target.name === 'omrade') setScope(event.target.value);
  });
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
    setFilters({ q: '', place: '', county: '', type: '', category: '' });
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
    // Stäng notispanelen vid klick utanför.
    if (!ui.notifyPanel.hidden && !event.target.closest('#notify-panel, #notify-button')) toggleNotifyPanel(false);
  });
  ui.refresh.addEventListener('click', () => refresh());

  ui.notifyButton.addEventListener('click', () => toggleNotifyPanel());
  ui.notifyOn.addEventListener('change', () => setNotificationsOn(ui.notifyOn.checked));
  ui.notifyArea.addEventListener('change', () => {
    notify.settings.area = ui.notifyArea.value;
    saveNotifySettings();
    renderNotify();
  });
  ui.notifyTest.addEventListener('click', async () => {
    const shown = await showNotification('Utryckning LKPG', {
      body: `Så här ser en notis ut. Du får en när något händer i ${areaName()}.`,
      tag: 'utryckning-test',
      data: { url: notificationUrl() },
    });
    if (!shown) ui.notifyStatus.textContent = 'Testnotisen kunde inte visas i den här webbläsaren.';
  });
  navigator.serviceWorker?.addEventListener('message', (event) => {
    if (event.data?.type === 'visa-handelse') showEvent(event.data.id);
  });

  ui.theme.addEventListener('click', () => {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    storageSet(STORAGE.theme, theme);
    applyTheme(theme);
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
    if (!storageGet(STORAGE.theme)) applyTheme(event.matches ? 'dark' : 'light');
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !ui.notifyPanel.hidden) {
      toggleNotifyPanel(false);
      ui.notifyButton.focus();
      return;
    }
    // "/" hoppar till sökfältet.
    const typing = event.target.closest?.('input, select, textarea, [contenteditable]');
    if (event.key === '/' && !typing && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      ui.q.focus();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (sources[state.scope].due || isStale(state.scope)) refresh();
  });
  window.addEventListener('online', () => refresh());
  setInterval(updateRelativeTimes, 60_000);

  // Visa sparade händelser direkt och hämta nya i bakgrunden.
  loadCache(state.scope);
  render();
  renderNotify();
  refresh(state.scope);
  if (notificationsOn()) {
    registerServiceWorker();
    if (state.scope !== HOME) {
      loadCache(HOME);
      refresh(HOME);
    }
  }
}

init();
