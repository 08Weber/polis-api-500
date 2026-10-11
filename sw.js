// Service worker för notiser. Den cachar ingenting, sidan hämtar alltid färsk data.
// Behövs för att kunna visa notiser på Android och för att öppna sidan när man trycker på en notis.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { id, url } = event.notification.data ?? {};
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const page = windows.find((client) => client.url.startsWith(self.registration.scope));
      if (page) {
        await page.focus();
        if (id) page.postMessage({ type: 'visa-handelse', id });
        return;
      }
      await self.clients.openWindow(url ?? self.registration.scope);
    })(),
  );
});
