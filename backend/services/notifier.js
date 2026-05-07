/**
 * services/notifier.js — Сервис отправки Push-уведомлений
 *
 * Используется в двух местах:
 *   1. routes/notifications.js — тестовое уведомление по запросу
 *   2. server.js primary-процесс — cron каждый час
 *
 * Логика планировщика:
 *   • Просроченные задачи (next_step_due < today) — уведомление один раз в день
 *   • Задачи на сегодня (next_step_due = today)   — утреннее уведомление (9:00)
 *   • Следующий шаг компании сегодня              — вместе с задачами
 *
 * Дедупликация: не отправляем одно и то же уведомление дважды.
 * Хранится в памяти (per-process) — при рестарте отправится снова,
 * что приемлемо (лучше дублировать, чем пропустить).
 */

import webpush  from 'web-push';
import knex     from '../db/knex.js';
import { config } from '../config.js';

// ── Инициализация VAPID ───────────────────────────────────────────────────────

if (config.vapidPublicKey && config.vapidPrivateKey) {
  webpush.setVapidDetails(
    `mailto:${config.adminEmail}`,
    config.vapidPublicKey,
    config.vapidPrivateKey
  );
} else {
  console.warn('[notifier] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY не заданы — push отключён');
}

// ── Дедупликация (in-memory, сбрасывается при рестарте) ──────────────────────
// Ключ: `${userId}:${date}:${type}` — не посылаем одно уведомление дважды за день
const _sent = new Set();

function dedupeKey(userId, date, type) {
  return `${userId}:${date}:${type}`;
}

// ── Отправка одного push ──────────────────────────────────────────────────────

export async function sendPush(subscription, payload) {
  try {
    await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: {
          p256dh: subscription.p256dh,
          auth:   subscription.auth,
        },
      },
      JSON.stringify(payload)
    );
    return true;
  } catch (err) {
    // 410 Gone / 404 — подписка устарела, удаляем из БД
    if (err.statusCode === 410 || err.statusCode === 404) {
      await knex('push_subscriptions')
        .where({ endpoint: subscription.endpoint })
        .del()
        .catch(() => {});
    } else {
      console.error('[notifier] push error:', err.message);
    }
    return false;
  }
}

// ── Отправить всем подпискам пользователя ─────────────────────────────────────

export async function notifyUser(userId, payload) {
  const subs = await knex('push_subscriptions').where({ user_id: userId });
  if (!subs.length) return 0;

  const results = await Promise.all(subs.map(s => sendPush(s, payload)));
  return results.filter(Boolean).length;
}

// ── Основной планировщик ─────────────────────────────────────────────────────

export async function runScheduler() {
  if (!config.vapidPublicKey) return; // push не настроен

  const today = new Date().toISOString().split('T')[0];
  const hour  = new Date().getHours();

  console.log(`[notifier] Запуск планировщика · ${today} ${hour}:00`);

  try {
    await checkOverdueTasks(today, hour);
    await checkTodayTasks(today, hour);
    await checkCompanyActions(today, hour);
  } catch (err) {
    console.error('[notifier] Ошибка планировщика:', err.message);
  }
}

// ── Просроченные задачи ───────────────────────────────────────────────────────
// Отправляем один раз утром (в 9:00 ± hour check)

async function checkOverdueTasks(today, hour) {
  if (hour !== 9) return; // только в 9 утра

  const tasks = await knex('activities as a')
    .select('a.id', 'a.next_step', 'a.next_step_due', 'a.owner_id', 'a.company_id', 'c.name as company_name')
    .leftJoin('companies as c', 'c.id', 'a.company_id')
    .where('a.is_done', false)
    .whereNotNull('a.next_step')
    .whereNotNull('a.next_step_due')
    .where('a.next_step_due', '<', today);

  // Группируем по владельцу
  const byOwner = {};
  tasks.forEach(t => {
    (byOwner[t.owner_id] = byOwner[t.owner_id] || []).push(t);
  });

  for (const [userId, list] of Object.entries(byOwner)) {
    const key = dedupeKey(userId, today, 'overdue');
    if (_sent.has(key)) continue;

    const count = list.length;
    const first = list[0];
    const body  = count === 1
      ? `${first.next_step}${first.company_name ? ' · ' + first.company_name : ''}`
      : `${count} просроченных задач`;

    await notifyUser(userId, {
      title:  `⚠️ Просрочено: ${count} ${pluralTasks(count)}`,
      body,
      url:    '/activities.html',
      tag:    'overdue',
      renotify: false,
    });

    _sent.add(key);
  }
}

// ── Задачи на сегодня ─────────────────────────────────────────────────────────
// Отправляем утром в 9:00

async function checkTodayTasks(today, hour) {
  if (hour !== 9) return;

  const tasks = await knex('activities as a')
    .select('a.id', 'a.next_step', 'a.next_step_due', 'a.owner_id', 'a.company_id', 'c.name as company_name')
    .leftJoin('companies as c', 'c.id', 'a.company_id')
    .where('a.is_done', false)
    .whereNotNull('a.next_step')
    .where('a.next_step_due', today);

  const byOwner = {};
  tasks.forEach(t => {
    (byOwner[t.owner_id] = byOwner[t.owner_id] || []).push(t);
  });

  for (const [userId, list] of Object.entries(byOwner)) {
    const key = dedupeKey(userId, today, 'today');
    if (_sent.has(key)) continue;

    const count = list.length;
    const first = list[0];
    const body  = count === 1
      ? `${first.next_step}${first.company_name ? ' · ' + first.company_name : ''}`
      : `${count} ${pluralTasks(count)} запланировано`;

    await notifyUser(userId, {
      title: `📋 На сегодня: ${count} ${pluralTasks(count)}`,
      body,
      url:   '/activities.html',
      tag:   'today-tasks',
    });

    _sent.add(key);
  }
}

// ── Следующий шаг по компании сегодня ────────────────────────────────────────

async function checkCompanyActions(today, hour) {
  if (hour !== 9) return;

  const companies = await knex('companies')
    .select('id', 'name', 'next_action_type', 'owner_id')
    .where('next_action_at', today);

  const byOwner = {};
  companies.forEach(c => {
    (byOwner[c.owner_id] = byOwner[c.owner_id] || []).push(c);
  });

  for (const [userId, list] of Object.entries(byOwner)) {
    const key = dedupeKey(userId, today, 'company-action');
    if (_sent.has(key)) continue;

    const count = list.length;
    const body  = list.slice(0, 3).map(c =>
      `${c.name}${c.next_action_type ? ' (' + c.next_action_type + ')' : ''}`
    ).join(', ');

    await notifyUser(userId, {
      title: `🏢 Касания с ${count} компани${count === 1 ? 'ей' : 'ями'} сегодня`,
      body,
      url:   '/companies.html',
      tag:   'company-actions',
    });

    _sent.add(key);
  }
}

// ── Утилиты ──────────────────────────────────────────────────────────────────

function pluralTasks(n) {
  if (n % 10 === 1 && n % 100 !== 11) return 'задача';
  if ([2,3,4].includes(n % 10) && ![12,13,14].includes(n % 100)) return 'задачи';
  return 'задач';
}
