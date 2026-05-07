/**
 * middleware/auth.js
 * JWT из httpOnly cookie → req.user = { id, email, role, first_name, last_name }
 *
 * Экспортирует:
 *   authenticate  — обязательная авторизация (401 если нет токена)
 *   requireRole   — проверка роли после authenticate
 *   optionalAuth  — подставляет req.user если токен есть, иначе null
 */

import jwt from 'jsonwebtoken';
import { config } from '../config.js';

/**
 * Подписать токен для пользователя.
 */
export function signToken(user) {
  return jwt.sign(
    {
      id:         user.id,
      email:      user.email,
      role:       user.role,
      first_name: user.first_name,
      last_name:  user.last_name,
    },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );
}

/**
 * Поставить httpOnly cookie с JWT.
 */
export function setCookie(res, token) {
  res.cookie(config.jwt.cookieName, token, {
    httpOnly:  true,
    secure:    config.isProd,       // только HTTPS в production
    sameSite:  'strict',
    maxAge:    8 * 60 * 60 * 1000, // 8 часов
  });
}

/**
 * Удалить cookie (logout).
 */
export function clearCookie(res) {
  res.clearCookie(config.jwt.cookieName, {
    httpOnly: true,
    secure:   config.isProd,
    sameSite: 'strict',
  });
}

/**
 * Middleware: проверяет JWT из cookie или Authorization: Bearer.
 * При ошибке → 401 JSON.
 */
export function authenticate(req, res, next) {
  // Сначала cookie, потом Bearer
  const token =
    req.cookies?.[config.jwt.cookieName] ||
    req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'Не авторизован' });
  }

  try {
    req.user = jwt.verify(token, config.jwt.secret);
    next();
  } catch (err) {
    clearCookie(res);
    const msg = err.name === 'TokenExpiredError'
      ? 'Сессия истекла, войдите снова'
      : 'Некорректный токен';
    return res.status(401).json({ error: msg });
  }
}

/**
 * Middleware: проверяет, что req.user.role входит в список разрешённых.
 * Использовать ПОСЛЕ authenticate.
 * Пример: router.delete('/:id', authenticate, requireRole('admin','head'), handler)
 */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ error: 'Недостаточно прав' });
    }
    next();
  };
}

/**
 * Middleware: подставляет req.user если токен есть, иначе req.user = null.
 * Не возвращает ошибку при отсутствии токена.
 */
export function optionalAuth(req, res, next) {
  const token =
    req.cookies?.[config.jwt.cookieName] ||
    req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    req.user = null;
    return next();
  }
  try {
    req.user = jwt.verify(token, config.jwt.secret);
  } catch {
    req.user = null;
  }
  next();
}
