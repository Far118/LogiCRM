/**
 * middleware/auth.js
 * JWT из httpOnly cookie → req.user = { id, email, role, first_name, last_name }
 *
 * Изменения относительно оригинала:
 *   • jwt.verify теперь явно указывает algorithms: ['HS256']
 *     (фиксация алгоритма — защита от algorithm-confusion атак)
 */

import jwt from 'jsonwebtoken';
import { config } from '../config.js';

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
    {
      expiresIn:  config.jwt.expiresIn,
      algorithm: 'HS256',   // явно фиксируем алгоритм при подписи
    }
  );
}

export function setCookie(res, token) {
  res.cookie(config.jwt.cookieName, token, {
    httpOnly: true,
    secure:   config.isProd,
    sameSite: 'strict',
    maxAge:   8 * 60 * 60 * 1000,
  });
}

export function clearCookie(res) {
  res.clearCookie(config.jwt.cookieName, {
    httpOnly: true,
    secure:   config.isProd,
    sameSite: 'strict',
  });
}

export function authenticate(req, res, next) {
  const token =
    req.cookies?.[config.jwt.cookieName] ||
    req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'Не авторизован' });
  }

  try {
    // algorithms: ['HS256'] — фиксируем явно, защита от none/RS256 подмены
    req.user = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] });
    next();
  } catch (err) {
    clearCookie(res);
    const msg = err.name === 'TokenExpiredError'
      ? 'Сессия истекла, войдите снова'
      : 'Некорректный токен';
    return res.status(401).json({ error: msg });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ error: 'Недостаточно прав' });
    }
    next();
  };
}

export function optionalAuth(req, res, next) {
  const token =
    req.cookies?.[config.jwt.cookieName] ||
    req.headers.authorization?.replace('Bearer ', '');

  if (!token) { req.user = null; return next(); }
  try {
    req.user = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] });
  } catch {
    req.user = null;
  }
  next();
}
