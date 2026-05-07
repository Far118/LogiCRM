/**
 * LogiCRM — activities.js
 * CRUD активностей: звонки, письма, встречи, задачи, заметки, КП
 * Привязка: company_id и/или deal_id
 * Спринт 1
 */

import {
  dbAdd, dbPut, dbGet, dbGetByIndex, dbGetAll,
  dbDelete, uuid, now,
} from './db.js';
import { getSession, can, ROLES } from './auth.js';

// ─── Утилиты ──────────────────────────────────────────────────────────────────

function s(value) {
  return String(value ?? '').trim();
}

function ensureSession() {
  const session = getSession();
  if (!session) throw new Error('Не авторизован');
  return session;
}

function ensureWriteAccess() {
  if (!can([ROLES.ADMIN, ROLES.HEAD, ROLES.MANAGER])) {
    throw new Error('Недостаточно прав');
  }
}

/**
 * Может ли текущий пользователь править/удалять активность.
 * Manager — только свои; head/admin — любые.
 */
function canModifyActivity(activity) {
  const session = ensureSession();
  if (can([ROLES.ADMIN, ROLES.HEAD])) return true;
  if (can([ROLES.MANAGER]) && activity.owner_id === session.id) return true;
  return false;
}

// ─── Чтение ───────────────────────────────────────────────────────────────────

/**
 * Активности компании (отсортированы — свежие сверху).
 */
export async function getActivitiesByCompany(company_id) {
  if (!company_id) throw new Error('company_id обязателен');
  ensureSession();

  const list = await dbGetByIndex('activities', 'company_id', company_id);
  return list.sort((a, b) => (b.occurred_at ?? '').localeCompare(a.occurred_at ?? ''));
}

/**
 * Активности сделки (для будущего Спринта 2).
 */
export async function getActivitiesByDeal(deal_id) {
  if (!deal_id) throw new Error('deal_id обязателен');
  ensureSession();

  const list = await dbGetByIndex('activities', 'deal_id', deal_id);
  return list.sort((a, b) => (b.occurred_at ?? '').localeCompare(a.occurred_at ?? ''));
}

/**
 * Все активности текущего пользователя (для дашборда).
 */
export async function getMyActivities({ onlyOpen = false, onlyOverdue = false } = {}) {
  const session = ensureSession();
  let list = await dbGetByIndex('activities', 'owner_id', session.id);

  if (onlyOpen) {
    list = list.filter(a => a.next_step_due && !a.is_done);
  }
  if (onlyOverdue) {
    const today = new Date().toISOString().split('T')[0];
    list = list.filter(a =>
      a.next_step_due && !a.is_done && a.next_step_due < today
    );
  }
  return list.sort((a, b) => (a.next_step_due ?? '').localeCompare(b.next_step_due ?? ''));
}

export async function getActivity(id) {
  if (!id) throw new Error('id обязателен');
  ensureSession();

  const activity = await dbGet('activities', id);
  if (!activity) throw new Error('Активность не найдена');
  return activity;
}

// ─── Создание ─────────────────────────────────────────────────────────────────

export async function createActivity(data) {
  ensureWriteAccess();
  const session = ensureSession();

  if (!data.type) throw new Error('Тип активности обязателен');
  if (!data.company_id && !data.deal_id) {
    throw new Error('Активность должна быть привязана к компании или сделке');
  }

  const activity = {
    id:             uuid(),
    company_id:     data.company_id ?? null,
    deal_id:        data.deal_id    ?? null,
    contact_id:     data.contact_id ?? null,
    type:           data.type,
    occurred_at:    data.occurred_at ?? new Date().toISOString(),
    description:    s(data.description),
    outcome:        s(data.outcome),
    next_step:      s(data.next_step),
    next_step_due:  data.next_step_due ?? '',
    is_done:        Boolean(data.is_done),
    owner_id:       data.owner_id ?? session.id,
    created_at:     now(),
    updated_at:     now(),
  };

  await dbAdd('activities', activity);
  return activity;
}

// ─── Редактирование ───────────────────────────────────────────────────────────

export async function updateActivity(id, data) {
  ensureWriteAccess();
  const existing = await dbGet('activities', id);
  if (!existing) throw new Error('Активность не найдена');
  if (!canModifyActivity(existing)) throw new Error('Нет прав на редактирование');

  const updated = {
    ...existing,
    ...data,
    id,
    description:   s(data.description   ?? existing.description),
    outcome:       s(data.outcome       ?? existing.outcome),
    next_step:     s(data.next_step     ?? existing.next_step),
    next_step_due: data.next_step_due  ?? existing.next_step_due ?? '',
    is_done:       data.is_done !== undefined ? Boolean(data.is_done) : existing.is_done,
    created_at:    existing.created_at,
    owner_id:      existing.owner_id, // owner не меняем
    updated_at:    now(),
  };

  await dbPut('activities', updated);
  return updated;
}

/**
 * Отметить «следующий шаг» как выполненный.
 */
export async function markDone(id, done = true) {
  ensureWriteAccess();
  const existing = await dbGet('activities', id);
  if (!existing) throw new Error('Активность не найдена');
  if (!canModifyActivity(existing)) throw new Error('Нет прав');

  await dbPut('activities', { ...existing, is_done: done, updated_at: now() });
}

// ─── Удаление ─────────────────────────────────────────────────────────────────

export async function deleteActivity(id) {
  const existing = await dbGet('activities', id);
  if (!existing) throw new Error('Активность не найдена');
  // manager — только свои; head/admin — любые
  if (!canModifyActivity(existing)) throw new Error('Нет прав на удаление');

  await dbDelete('activities', id);
  return true;
}

// ─── Справочники для UI ───────────────────────────────────────────────────────

export const ACTIVITY_TYPE_LABELS = {
  call_out:  'Звонок исходящий',
  call_in:   'Звонок входящий',
  email_out: 'Письмо исходящее',
  email_in:  'Письмо входящее',
  meeting:   'Встреча',
  task:      'Задача',
  proposal:  'Отправка КП',
  note:      'Заметка',
};

/** Цвет бейджа (использует те же CSS-классы, что в companies.html) */
export const ACTIVITY_TYPE_COLORS = {
  call_out:  'teal',
  call_in:   'teal',
  email_out: 'blue',
  email_in:  'blue',
  meeting:   'orange',
  task:      'red',
  proposal:  'green',
  note:      'gray',
};

/** SVG-иконки для ленты (24×24, currentColor) */
export const ACTIVITY_TYPE_ICONS = {
  call_out:  '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
  call_in:   '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
  email_out: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>',
  email_in:  '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>',
  meeting:   '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  task:      '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  proposal:  '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>',
  note:      '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
};

/**
 * Просрочена ли активность (по next_step_due, если не выполнена).
 */
export function isOverdue(activity) {
  if (!activity.next_step_due || activity.is_done) return false;
  const today = new Date().toISOString().split('T')[0];
  return activity.next_step_due < today;
}

/**
 * Краткое название типа для бейджа.
 */
export function getActivityTypeLabel(type) {
  return ACTIVITY_TYPE_LABELS[type] ?? type;
}
