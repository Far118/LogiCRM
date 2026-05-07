/**
 * routes/users.js
 *
 * GET    /api/users           — список (admin + head)
 * GET    /api/users/:id
 * POST   /api/users           — создать (admin)
 * PATCH  /api/users/:id/active — заблокировать / разблокировать (admin)
 */

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../db/pool.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { config } from '../config.js';

const router = Router();
router.use(authenticate);

const SAFE_COLS = 'id, email, first_name, last_name, role, is_active, force_password_change, created_at, last_login';

// ── GET /api/users ────────────────────────────────────────────────────────────
// head видит список для выбора ответственного; admin — с блокировками

router.get('/', requireRole('admin', 'head', 'manager'), async (req, res) => {
  try {
    const { rows } = await query(`SELECT ${SAFE_COLS} FROM users ORDER BY first_name, last_name`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    // Обычный пользователь может смотреть только себя
    if (!['admin', 'head'].includes(req.user.role) && req.user.id !== req.params.id) {
      return res.status(403).json({ error: 'Нет прав' });
    }
    const { rows } = await query(`SELECT ${SAFE_COLS} FROM users WHERE id=$1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/users ───────────────────────────────────────────────────────────

router.post('/', requireRole('admin'), async (req, res) => {
  try {
    const { email, first_name, last_name, role } = req.body;

    if (!email?.trim()) return res.status(400).json({ error: 'Email обязателен' });
    if (!first_name?.trim()) return res.status(400).json({ error: 'Имя обязательно' });

    const VALID_ROLES = ['admin', 'head', 'manager', 'ops'];
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: 'Некорректная роль' });
    }

    const { rows: existing } = await query(
      'SELECT id FROM users WHERE LOWER(email)=LOWER($1)',
      [email.trim()]
    );
    if (existing[0]) {
      return res.status(409).json({ error: 'Пользователь с таким email уже существует' });
    }

    // Генерируем временный пароль
    const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
    let tempPassword = '';
    for (let i = 0; i < 10; i++) tempPassword += chars[Math.floor(Math.random() * chars.length)];

    const hash = await bcrypt.hash(tempPassword, config.bcryptRounds);
    const { rows } = await query(`
      INSERT INTO users (email, password_hash, first_name, last_name, role,
                         is_active, force_password_change)
      VALUES ($1,$2,$3,$4,$5,true,true)
      RETURNING ${SAFE_COLS}`,
      [email.trim(), hash, first_name.trim(), (last_name ?? '').trim(), role]
    );

    // Возвращаем пользователя + временный пароль (единственный раз!)
    res.status(201).json({ user: rows[0], tempPassword });
  } catch (err) {
    console.error('[users/create]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/users/:id/active ───────────────────────────────────────────────

router.patch('/:id/active', requireRole('admin'), async (req, res) => {
  try {
    const { is_active } = req.body;
    if (typeof is_active !== 'boolean') {
      return res.status(400).json({ error: 'is_active должен быть boolean' });
    }
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: 'Нельзя заблокировать самого себя' });
    }
    const { rows } = await query(
      `UPDATE users SET is_active=$1 WHERE id=$2 RETURNING ${SAFE_COLS}`,
      [is_active, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
