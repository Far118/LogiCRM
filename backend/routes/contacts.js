/**
 * routes/contacts.js — Контакты
 *
 * GET    /api/contacts?company_id=  — контакты компании (company_id обязателен)
 * GET    /api/contacts/:id
 * POST   /api/contacts
 * PUT    /api/contacts/:id          — company_id не меняется
 * DELETE /api/contacts/:id
 *
 * Изменения относительно оригинала:
 *   • Все SQL-запросы переведены на Knex (db/knex.js)
 *   • POST и PUT защищены Zod-валидацией (middleware/validate.js)
 *   • checkRole(), бизнес-проверки и паттерн d ?? e в PUT не изменены
 */

import { Router } from 'express';
import { z }      from 'zod';
import knex       from '../db/knex.js';
import { authenticate } from '../middleware/auth.js';
import { validate }     from '../middleware/validate.js';

const router = Router();
router.use(authenticate);

// ── RBAC: ops не имеет доступа к контактам ────────────────────────────────────
//
// Используется кастомная checkRole(), а не requireRole() из middleware/auth.js —
// сохраняем поведение оригинала: выбрасывает ошибку со статусом 403.

const ALLOWED_ROLES = ['admin', 'head', 'manager'];

function checkRole(role) {
  if (!ALLOWED_ROLES.includes(role)) {
    throw Object.assign(new Error('Недостаточно прав'), { status: 403 });
  }
}

// ── Zod-схемы ─────────────────────────────────────────────────────────────────

/**
 * ContactFieldsSchema — базовые типы без дефолтов.
 *
 * company_id не входит — при PUT он не обновляется (нет в SET-клаузе оригинала).
 * first_name намеренно без .min(1): обязательность проверяется в обработчике
 * с оригинальным сообщением 'Имя обязательно'.
 */
const ContactFieldsSchema = z.object({
  first_name:        z.string().max(255).optional(),
  last_name:         z.string().max(255).optional(),
  position:          z.string().max(255).optional(),
  role:              z.string().max(100).optional(),
  phone_main:        z.string().max(50).optional(),
  phone_alt:         z.string().max(50).optional(),
  email:             z.string().max(255).optional(),
  telegram:          z.string().max(255).optional(),
  whatsapp:          z.string().max(255).optional(),
  preferred_channel: z.string().max(50).optional(),
  notes:             z.string().max(5000).optional(),
  // last_contact_at — DATE ('YYYY-MM-DD') или null; в PUT: `|| null` без !== undefined
  last_contact_at:   z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Формат даты: YYYY-MM-DD')
    .nullable()
    .optional(),
});

/**
 * CreateContactSchema — для POST /api/contacts.
 * Включает company_id (обязателен в POST, проверяется в обработчике).
 */
const CreateContactSchema = ContactFieldsSchema.extend({
  company_id:        z.string().uuid('company_id должен быть UUID').optional(),
  first_name:        ContactFieldsSchema.shape.first_name.default(''),
  last_name:         ContactFieldsSchema.shape.last_name.default(''),
  position:          ContactFieldsSchema.shape.position.default(''),
  role:              ContactFieldsSchema.shape.role.default('unknown'),
  phone_main:        ContactFieldsSchema.shape.phone_main.default(''),
  phone_alt:         ContactFieldsSchema.shape.phone_alt.default(''),
  email:             ContactFieldsSchema.shape.email.default(''),
  telegram:          ContactFieldsSchema.shape.telegram.default(''),
  whatsapp:          ContactFieldsSchema.shape.whatsapp.default(''),
  preferred_channel: ContactFieldsSchema.shape.preferred_channel.default(''),
  notes:             ContactFieldsSchema.shape.notes.default(''),
  last_contact_at:   ContactFieldsSchema.shape.last_contact_at.default(null),
});

/**
 * UpdateContactSchema — для PUT /api/contacts/:id.
 * company_id исключён — PUT его не трогает.
 * Дефолтов нет: отсутствующее поле = undefined → d.field ?? e.field вернёт existing.
 */
const UpdateContactSchema = ContactFieldsSchema.partial();

// ── GET /api/contacts ─────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    checkRole(req.user.role);

    const { company_id } = req.query;
    // company_id обязателен — без него запрос бессмысленен
    if (!company_id) return res.status(400).json({ error: 'company_id обязателен' });

    const rows = await knex('contacts')
      .where({ company_id })
      .orderBy('first_name')
      .orderBy('last_name');

    res.json(rows);
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// ── GET /api/contacts/:id ─────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  try {
    checkRole(req.user.role);

    const contact = await knex('contacts').where({ id: req.params.id }).first();
    if (!contact) return res.status(404).json({ error: 'Контакт не найден' });
    res.json(contact);
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// ── POST /api/contacts ────────────────────────────────────────────────────────

router.post('/', validate(CreateContactSchema), async (req, res) => {
  try {
    checkRole(req.user.role);

    const d = req.body; // провалидированы Zod-ом

    // Бизнес-проверки с оригинальными сообщениями — вне Zod (db.js читает data.error)
    if (!d.company_id) {
      return res.status(400).json({ error: 'company_id обязателен' });
    }
    if (!d.first_name?.trim()) {
      return res.status(400).json({ error: 'Имя обязательно' });
    }

    const [contact] = await knex('contacts')
      .insert({
        company_id:        d.company_id,
        first_name:        d.first_name.trim(),
        last_name:         (d.last_name         ?? '').trim(),
        position:          (d.position          ?? '').trim(),
        role:              d.role               ?? 'unknown',
        phone_main:        (d.phone_main        ?? '').trim(),
        phone_alt:         (d.phone_alt         ?? '').trim(),
        email:             (d.email             ?? '').trim(),
        telegram:          (d.telegram          ?? '').trim(),
        whatsapp:          (d.whatsapp          ?? '').trim(),
        preferred_channel: d.preferred_channel  ?? '',
        notes:             (d.notes             ?? '').trim(),
        last_contact_at:   d.last_contact_at    || null,
      })
      .returning('*');

    res.status(201).json(contact);
  } catch (err) {
    console.error('[contacts/create]', err.message);
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// ── PUT /api/contacts/:id ─────────────────────────────────────────────────────

router.put('/:id', validate(UpdateContactSchema), async (req, res) => {
  try {
    checkRole(req.user.role);

    const existing = await knex('contacts').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Контакт не найден' });

    const d = req.body; // UpdateContactSchema.partial() — только отправленные поля
    const e = existing;

    // Валидация имени с оригинальным сообщением
    // UpdateContactSchema без дефолтов → d.first_name === undefined если не прислали
    const firstName = (d.first_name ?? e.first_name)?.trim();
    if (!firstName) {
      return res.status(400).json({ error: 'Имя обязательно' });
    }

    // Паттерн d.field ?? e.field — повторяет оригинал дословно.
    // last_contact_at: оригинал использует || (не !== undefined),
    // поэтому явный null использует existing-значение — сохраняем точно.
    const [updated] = await knex('contacts')
      .where({ id: req.params.id })
      .update({
        first_name:        firstName,
        last_name:         (d.last_name         ?? e.last_name         ?? '').trim(),
        position:          (d.position          ?? e.position          ?? '').trim(),
        role:              d.role               ?? e.role               ?? 'unknown',
        phone_main:        (d.phone_main        ?? e.phone_main        ?? '').trim(),
        phone_alt:         (d.phone_alt         ?? e.phone_alt         ?? '').trim(),
        email:             (d.email             ?? e.email             ?? '').trim(),
        telegram:          (d.telegram          ?? e.telegram          ?? '').trim(),
        whatsapp:          (d.whatsapp          ?? e.whatsapp          ?? '').trim(),
        preferred_channel: d.preferred_channel  ?? e.preferred_channel ?? '',
        notes:             (d.notes             ?? e.notes             ?? '').trim(),
        last_contact_at:   d.last_contact_at    || e.last_contact_at   || null,
      })
      .returning('*');

    res.json(updated);
  } catch (err) {
    console.error('[contacts/update]', err.message);
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// ── DELETE /api/contacts/:id ──────────────────────────────────────────────────

router.delete('/:id', async (req, res) => {
  try {
    checkRole(req.user.role);

    const deleted = await knex('contacts').where({ id: req.params.id }).del();
    if (!deleted) return res.status(404).json({ error: 'Контакт не найден' });
    res.status(204).end();
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

export default router;
