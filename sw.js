// Service worker för notiser. Den cachar ingenting, sidan hämtar alltid färsk data.
// Behövs för att kunna visa notiser på Android och för att öppna sidan när man trycker på en notis.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

/** Adressen i notisen, men bara om den pekar på den här sidan. */
function pageUrl(url) {
  const { scope } = self.registration;
  try {
    const href = new URL(url, scope).href;
    return href.startsWith(scope) ? href : scope;
  } catch {
    return scope;
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { id, url } = event.notification.data ?? {};
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const page = windows.find((client) => client.url.startsWith(self.registration.scope));
      if (page) {
        await page.focus();
        if (typeof id === 'string' && id) page.postMessage({ type: 'visa-handelse', id });
        return;
      }
      await self.clients.openWindow(pageUrl(url));
    })(),
  );
});
