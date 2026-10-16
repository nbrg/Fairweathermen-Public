/* Fairweathermen service worker.
 *
 * Its only real job is web-push: receive a push while the app is closed and
 * show a notification, then focus/open the right page when it's tapped. We keep
 * a trivial fetch handler so the app is a valid installable PWA, but do NOT
 * cache API responses — live scores must never be served stale (the server
 * sends Cache-Control: no-store for /api/* on purpose). */

self.addEventListener("install", () => {
  // Activate this SW immediately on first install / update.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Pass-through fetch (no offline cache). Present so the PWA is installable.
self.addEventListener("fetch", () => {});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Fairweathermen", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Fairweathermen";
  const options = {
    body: data.body || "",
    icon: data.icon || "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: data.tag || undefined, // collapses duplicate reminders on the device
    data: { url: data.url || "/" },
    requireInteraction: false,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      // Focus an existing tab if one is open, otherwise open a new one.
      for (const client of clientList) {
        if ("focus" in client) {
          client.navigate(targetUrl).catch(() => {});
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    }),
  );
});
