self.addEventListener('push', (event) => {
  if (!event.data) {
    return;
  }

  const payload = event.data.json();
  const title = payload.title || 'New Notification';

  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || '',
      image: payload.image || undefined,
      icon: payload.image || undefined,
      data: payload.data || { url: '/' }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if ('focus' in client) {
          client.focus();
          return;
        }
      }

      if (clients.openWindow) {
        return clients.openWindow(event.notification?.data?.url || '/');
      }
    })
  );
});
