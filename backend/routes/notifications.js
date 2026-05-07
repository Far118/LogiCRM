/**
 * routes/notifications.js — Web Push уведомления
 *
 * GET  /api/notifications/vapid-key  — публичный VAPID ключ для браузера
 * POST /api/notifications/subscribe  — сохранить подписку
 * DELETE /api/notifications/subscribe — удалить подписку (отключить)
 * POST /api/notifications/test       — тестовый push (для проверки)
 * GET  /api/notifications/status     — статус подписки текущего браузера
 */

import { Router } from 'express';
import knex       from '../db/knex.js';
import { authenticate } from '../middleware/auth.js';
import { notifyUser }   from '../services/notifier.js';
import { config }       from '../config.js';

const router = Router();
router.use(authenticate);

// ── GET /api/notifications/vapid-key ─────────────────────────────────────────
// Браузер запрашивает публичный ключ при первой подписке

router.get('/vapid-key', (_req, res) => {
  if (!config.vapidPublicKey) {
    return res.status(503).json({ error: 'Push уведомления не настроены на сервере' });
  }
  res.json({ publicKey: config.vapidPublicKey });
});

// ── GET /api/notifications/status ────────────────────────────────────────────
// Проверяем: есть ли активная подписка у текущего пользователя

router.get('/status', async (req, res) => {
  try {
    const { endpoint } = req.query;
    if (!endpoint) return res.json({ subscribed: false });

    const sub = await knex('push_subscriptions')
      .where({ user_id: req.user.id, endpoint })
      .first();

    res.json({ subscribed: !!sub });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/notifications/subscribe ────────────────────────────────────────
// Сохраняем подписку от браузера

router.post('/subscribe', async (req, res) => {
  try {
    if (!config.vapidPublicKey) {
      return res.status(503).json({ error: 'Push не настроен' });
    }

    const { endpoint, keys } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'Некорректные данные подписки' });
    }

    // Upsert: обновляем если уже есть, создаём если нет
    await knex('push_subscriptions')
      .insert({
        user_id:    req.user.id,
        endpoint,
        p256dh:     keys.p256dh,
        auth:       keys.auth,
        user_agent: req.headers['user-agent']?.slice(0, 200) || '',
      })
      .onConflict('endpoint')
      .merge({ p256dh: keys.p256dh, auth: keys.auth, user_id: req.user.id });

    res.json({ ok: true });
  } catch (err) {
    console.error('[notifications/subscribe]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/notifications/subscribe ──────────────────────────────────────
// Удаляем подписку (пользователь отключил уведомления)

router.delete('/subscribe', async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: 'endpoint обязателен' });

    await knex('push_subscriptions')
      .where({ user_id: req.user.id, endpoint })
      .del();

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/notifications/test ─────────────────────────────────────────────
// Отправляет тестовый push на все устройства пользователя

router.post('/test', async (req, res) => {
  try {
    if (!config.vapidPublicKey) {
      return res.status(503).json({ error: 'Push не настроен' });
    }

    const sent = await notifyUser(req.user.id, {
      title: '✅ LogiCRM — тест уведомлений',
      body:  'Уведомления работают! Вы будете получать напоминания о задачах.',
      url:   '/index.html',
      tag:   'test',
    });

    res.json({ ok: true, sent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
