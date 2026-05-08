/**
 * routes/users.js
 *
 * Исправления (аудит):
 *   2.7  GET / для manager возвращает только id/first_name/last_name/role — без email и last_login
 *   2.8  Временный пароль генерируется через crypto.randomInt (не Math.random)
 */

import { Router }     from 'express';
import bcrypt         from 'bcryptjs';
import { randomInt }  from 'node:crypto';   // 2.8: криптостойкая генерация
import { query }      from '../db/pool.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { config }     from '../config.js';
import { validatePasswordStrength } from './auth.js';

const router = Router();
router.use(authenticate);

// Полный набор колонок — для admin/head
const SAFE_COLS = 'id, email, first_name, last_name, role, is_active, force_password_change, created_at, last_login';
// Урезанный набор — для manager (нет email/last_login — аудит 2.7)
const SAFE_COLS_MANAGER = 'id, first_name, last_name, role';

// ── GET /api/users ────────────────────────────────────────────────────────────

router.get('/', requireRole('admin', 'head', 'manager'), async (req, res) => {
  try {
    // Менеджеру нужны только имена коллег для поля «Ответственный» —
    // email и last_login раскрывать не нужно (риск внутреннего фишинга)
    const cols = ['admin', 'head'].includes(req.user.role)
      ? SAFE_COLS
      : SAFE_COLS_MANAGER;

    const { rows } = await query(`SELECT ${cols} FROM users WHERE is_active = true ORDER BY first_name, last_name`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/users/:id ────────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  try {
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

    if (!email?.trim())      return res.status(400).json({ error: 'Email обязателен' });
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

    // Аудит 2.8: crypto.randomInt вместо Math.random — криптостойкая генерация
    const chars = 'abcdefghijkmnpqrstuvwxyz23456789!@#$%';
    let tempPassword = '';
    for (let i = 0; i < 14; i++) tempPassword += chars[randomInt(chars.length)];

    const hash = await bcrypt.hash(tempPassword, config.bcryptRounds);
    const { rows } = await query(`
      INSERT INTO users (email, password_hash, first_name, last_name, role,
                         is_active, force_password_change)
      VALUES ($1,$2,$3,$4,$5,true,true)
      RETURNING ${SAFE_COLS}`,
      [email.trim(), hash, first_name.trim(), (last_name ?? '').trim(), role]
    );

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
