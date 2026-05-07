/**
 * sw.js — Service Worker для Web Push уведомлений LogiCRM
 *
 * Размещается в frontend/public/sw.js → Vite раздаёт его как /sw.js
 * Scope: /  (весь сайт)
 *
 * События:
 *   push             — входящий push от сервера → showNotification
 *   notificationclick — клик по уведомлению → открыть нужную страницу
 *   pushsubscriptionchange — браузер обновил подписку → переподписаться
 */

const APP_NAME = 'LogiCRM';

// ── Push: получаем данные от сервера и показываем уведомление ─────────────────

self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data?.json() ?? {};
  } catch {
    data = { title: APP_NAME, body: event.data?.text() ?? 'Новое уведомление' };
  }

  const title   = data.title || APP_NAME;
  const options = {
    body:    data.body    || '',
    icon:    data.icon    || '/favicon.svg',
    badge:   '/favicon.svg',
    tag:     data.tag     || 'logicrm-default', // группировка — заменяет предыдущее с тем же тегом
    renotify:data.renotify ?? false,
    silent:  false,
    data: {
      url: data.url || '/',
    },
    // Кнопки действий (если поддерживаются браузером)
    actions: data.actions || [],
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// ── Клик по уведомлению ───────────────────────────────────────────────────────

self.addEventListener('notificationclick', event => {
  event.notification.close();

  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // Если вкладка уже открыта — переходим в неё
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      // Иначе открываем новую вкладку
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});

// ── Обновление подписки (браузер обновил endpoint) ────────────────────────────

self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil(
    event.newSubscription
      ? fetch('/api/notifications/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(event.newSubscription.toJSON()),
        })
      : Promise.resolve()
  );
});
