/**
 * auth.js — авторизация через JWT (httpOnly cookie)
 *
 * Отличия от IndexedDB-версии:
 *   • Сессия живёт в httpOnly cookie (управляет сервер).
 *   • _session хранится in-memory; восстанавливается через GET /api/auth/me.
 *   • requireAuth() — async; вызывать как `await requireAuth()`.
 *   • login/logout — делают fetch к API.
 *   • Управление пользователями (createUser, changePassword) → API-эндпоинты.
 */

const API = '/api/auth';

let _session = null;

export function getSession() { return _session; }
export function isAuthenticated() { return _session !== null; }

export const ROLES = {
  ADMIN:   'admin',
  HEAD:    'head',
  MANAGER: 'manager',
  OPS:     'ops',
};

const ROLE_LABELS = {
  admin:   'Администратор',
  head:    'Руководитель отдела',
  manager: 'Менеджер по продажам',
  ops:     'Операционный менеджер',
};

export function getRoleLabel(role) { return ROLE_LABELS[role] ?? role; }

export function can(allowedRoles) {
  if (!_session) return false;
  return allowedRoles.includes(_session.role);
}

// ── Восстановление сессии ─────────────────────────────────────────────────────

/**
 * Загружает текущего пользователя с сервера.
 * Вызывается автоматически из requireAuth().
 * Возвращает объект пользователя или null.
 */
export async function initSession() {
  try {
    const res = await fetch(`${API}/me`, { credentials: 'include' });
    if (!res.ok) { _session = null; return null; }
    _session = await res.json();
    return _session;
  } catch {
    _session = null;
    return null;
  }
}

// ── Вход ─────────────────────────────────────────────────────────────────────

export async function login(email, password) {
  if (!email || !password) return { ok: false, error: 'Введите email и пароль' };
  try {
    const res = await fetch(`${API}/login`, {
      method:      'POST',
      credentials: 'include',
      headers:     { 'Content-Type': 'application/json' },
      body:        JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({ error: 'Ошибка сервера' }));
    if (!res.ok) return { ok: false, error: data.error ?? 'Ошибка входа' };
    _session = data.user;
    return { ok: true, user: _session };
  } catch {
    return { ok: false, error: 'Нет соединения с сервером' };
  }
}

// ── Выход ─────────────────────────────────────────────────────────────────────

export async function logout() {
  try {
    await fetch(`${API}/logout`, { method: 'POST', credentials: 'include' });
  } catch { /* cookie всё равно истечёт */ }
  _session = null;
  window.location.href = '/login.html';
}

// ── Защита страниц ────────────────────────────────────────────────────────────

/**
 * Вызывать на каждой защищённой странице:
 *   if (!await requireAuth()) return;
 *
 * Если сессии нет — редиректит на /login.html.
 * Если роль не разрешена — на /403.html.
 */
export async function requireAuth(allowedRoles = null) {
  if (!_session) await initSession();
  if (!_session) {
    window.location.href = '/login.html';
    return false;
  }
  if (allowedRoles && !allowedRoles.includes(_session.role)) {
    window.location.href = '/403.html';
    return false;
  }
  return true;
}

// ── Смена пароля ──────────────────────────────────────────────────────────────

export async function changePassword(oldPassword, newPassword) {
  const res = await fetch(`${API}/password`, {
    method:      'POST',
    credentials: 'include',
    headers:     { 'Content-Type': 'application/json' },
    body:        JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
  });
  const data = await res.json().catch(() => ({ error: 'Ошибка сервера' }));
  if (!res.ok) throw new Error(data.error ?? 'Ошибка смены пароля');
}

// ── Инициалы ──────────────────────────────────────────────────────────────────

export function getUserInitials(user = _session) {
  if (!user) return '?';
  const f = user.first_name?.[0] ?? '';
  const l = user.last_name?.[0]  ?? '';
  return (f + l).toUpperCase() || user.email?.[0]?.toUpperCase() || '?';
}
