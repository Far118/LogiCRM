/**
 * routes/auth.js — авторизация и управление сессией
 *
 * POST /api/auth/login    — вход, устанавливает httpOnly cookie
 * POST /api/auth/logout   — выход, очищает cookie
 * GET  /api/auth/me       — текущий пользователь (для восстановления сессии)
 * POST /api/auth/password — смена пароля текущим пользователем
 */

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../db/pool.js';
import { authenticate, signToken, setCookie, clearCookie } from '../middleware/auth.js';
import { config } from '../config.js';

const router = Router();

// ── POST /api/auth/login ──────────────────────────────────────────────────────

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Введите email и пароль' });
    }

    const { rows } = await query(
      'SELECT * FROM users WHERE LOWER(email) = LOWER($1)',
      [email.trim()]
    );

    const user = rows[0];
    if (!user) {
      // Намеренно одинаковое сообщение — не раскрываем, есть ли email
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: 'Аккаунт заблокирован. Обратитесь к администратору.' });
    }

    const passwordOk = await bcrypt.compare(password, user.password_hash);
    if (!passwordOk) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    // Обновляем last_login
    await query('UPDATE users SET last_login = now() WHERE id = $1', [user.id]);

    const sessionUser = {
      id:         user.id,
      email:      user.email,
      first_name: user.first_name,
      last_name:  user.last_name,
      role:       user.role,
      force_password_change: user.force_password_change,
    };

    const token = signToken(sessionUser);
    setCookie(res, token);

    return res.json({ ok: true, user: sessionUser });
  } catch (err) {
    console.error('[auth/login]', err.message);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// ── POST /api/auth/logout ─────────────────────────────────────────────────────

router.post('/logout', (req, res) => {
  clearCookie(res);
  res.json({ ok: true });
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────

router.get('/me', authenticate, async (req, res) => {
  try {
    // Перечитываем из БД — вдруг роль или is_active изменились
    const { rows } = await query(
      'SELECT id, email, first_name, last_name, role, is_active, force_password_change FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!rows[0] || !rows[0].is_active) {
      clearCookie(res);
      return res.status(401).json({ error: 'Пользователь не найден или заблокирован' });
    }
    const u = rows[0];
    res.json({
      id:         u.id,
      email:      u.email,
      first_name: u.first_name,
      last_name:  u.last_name,
      role:       u.role,
      force_password_change: u.force_password_change,
    });
  } catch (err) {
    console.error('[auth/me]', err.message);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// ── POST /api/auth/password ───────────────────────────────────────────────────

router.post('/password', authenticate, async (req, res) => {
  try {
    const { old_password, new_password } = req.body;

    if (!old_password || !new_password) {
      return res.status(400).json({ error: 'Укажите старый и новый пароль' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'Пароль должен быть не менее 8 символов' });
    }
    if (!/\d/.test(new_password) || !/[a-zA-Zа-яА-Я]/.test(new_password)) {
      return res.status(400).json({ error: 'Пароль должен содержать буквы и цифры' });
    }

    const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Пользователь не найден' });

    const ok = await bcrypt.compare(old_password, rows[0].password_hash);
    if (!ok) return res.status(400).json({ error: 'Неверный текущий пароль' });

    const newHash = await bcrypt.hash(new_password, config.bcryptRounds);
    await query(
      'UPDATE users SET password_hash = $1, force_password_change = false WHERE id = $2',
      [newHash, req.user.id]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('[auth/password]', err.message);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

export default router;
