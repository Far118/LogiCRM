/**
 * routes/activities.js — Активности (звонки, письма, встречи, задачи, заметки, КП)
 *
 * GET    /api/activities?company_id= | ?deal_id= | ?owner_id=
 * GET    /api/activities/:id
 * POST   /api/activities
 * PUT    /api/activities/:id
 * DELETE /api/activities/:id
 *
 * Изменения относительно оригинала:
 *   • Все SQL-запросы переведены на Knex (db/knex.js)
 *   • POST и PUT защищены Zod-валидацией (middleware/validate.js)
 *   • Вся бизнес-логика (canModify, RBAC-фильтрация, ?? e.field в PUT) не изменена
 */

import { Router } from 'express';
import { z }      from 'zod';
import knex       from '../db/knex.js';
import { authenticate } from '../middleware/auth.js';
import { validate }     from '../middleware/validate.js';

const router = Router();
router.use(authenticate);

// ── Справочник типов активности (совпадает с frontend/js/activities.js) ────────

export const ACTIVITY_TYPES = [
  'call_out', 'call_in',
  'email_out', 'email_in',
  'meeting', 'task', 'proposal', 'note',
];

// ── RBAC: кто может редактировать / удалять активность ───────────────────────
//
// admin и head — любые активности.
// manager      — только свои (owner_id === user.id).
// Функция не изменена по сравнению с оригиналом.

function canModify(activity, user) {
  if (['admin', 'head'].includes(user.role)) return true;
  if (user.role === 'manager' && activity.owner_id === user.id) return true;
  return false;
}

// ── Zod-схемы ─────────────────────────────────────────────────────────────────

/**
 * ActivityFieldsSchema — базовые типы полей без дефолтов.
 *
 * Используется как основа:
 *   • CreateActivitySchema — добавляет .default() для POST
 *   • UpdateActivitySchema — делает .partial() для PUT
 *
 * Разделение на две схемы необходимо по той же причине, что в requests.js:
 * в PUT применяется паттерн `d.field ?? e.field` (поле по полю), а не spread.
 * Если бы UpdateActivitySchema имела .default() — Zod вернул бы их даже для
 * отсутствующих полей, и `d.field ?? e.field` всегда давал бы дефолт, а не
 * существующее значение из БД.
 */
const ActivityFieldsSchema = z.object({
  // ── Связи ───────────────────────────────────────────────────────────────
  company_id: z.string().uuid('company_id должен быть UUID').nullable().optional(),
  deal_id:    z.string().uuid('deal_id должен быть UUID').nullable().optional(),
  contact_id: z.string().uuid('contact_id должен быть UUID').nullable().optional(),

  // ── Тип активности ───────────────────────────────────────────────────────
  // Допустимые значения — enum; отсутствие type проверяется в обработчике
  // с точным сообщением 'Тип активности обязателен' (фронтенд его показывает в тосте).
  type: z.enum(ACTIVITY_TYPES, {
    errorMap: () => ({ message: `Тип должен быть одним из: ${ACTIVITY_TYPES.join(', ')}` }),
  }).optional(),

  // ── Даты ────────────────────────────────────────────────────────────────
  // occurred_at — TIMESTAMPTZ; фронтенд шлёт ISO-строку или оставляет пустой
  occurred_at: z.string().optional(),
  // next_step_due — DATE ('YYYY-MM-DD') или null для сброса
  next_step_due: z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Формат даты: YYYY-MM-DD')
    .nullable()
    .optional(),

  // ── Текстовые поля ───────────────────────────────────────────────────────
  description: z.string().max(5000).optional(),
  outcome:     z.string().max(2000).optional(),
  next_step:   z.string().max(1000).optional(),

  // ── Булевое поле ─────────────────────────────────────────────────────────
  // Принимаем только настоящий JSON boolean (не строку 'true').
  // В POST и PUT Boolean() используется явно для безопасного приведения.
  is_done: z.boolean().optional(),

  // ── Ответственный ────────────────────────────────────────────────────────
  // При POST: если не передан — подставляется req.user.id в обработчике.
  // При PUT:  owner_id не меняется (исключён из UpdateActivitySchema).
  owner_id: z.string().uuid('owner_id должен быть UUID').optional(),
});

/**
 * CreateActivitySchema — для POST /api/activities.
 *
 * Поля, которые обязательны по бизнес-логике (type, company_id/deal_id),
 * не делаем required в Zod — их проверяет обработчик с оригинальными
 * сообщениями об ошибках.
 */
const CreateActivitySchema = ActivityFieldsSchema.extend({
  company_id:   ActivityFieldsSchema.shape.company_id.default(null),
  deal_id:      ActivityFieldsSchema.shape.deal_id.default(null),
  contact_id:   ActivityFieldsSchema.shape.contact_id.default(null),
  next_step_due:ActivityFieldsSchema.shape.next_step_due.default(null),
  description:  ActivityFieldsSchema.shape.description.default(''),
  outcome:      ActivityFieldsSchema.shape.outcome.default(''),
  next_step:    ActivityFieldsSchema.shape.next_step.default(''),
  is_done:      ActivityFieldsSchema.shape.is_done.default(false),
  // occurred_at и type без дефолта — обработчик ставит свои значения
});

/**
 * UpdateActivitySchema — для PUT /api/activities/:id.
 *
 * Содержит только поля, которые PUT реально обновляет (см. оригинальный UPDATE SET).
 * company_id, deal_id и owner_id намеренно исключены — PUT их не трогает.
 * Все поля опциональны, дефолтов нет (см. комментарий к ActivityFieldsSchema).
 */
const UpdateActivitySchema = z.object({
  type:         ActivityFieldsSchema.shape.type,
  occurred_at:  ActivityFieldsSchema.shape.occurred_at,
  contact_id:   ActivityFieldsSchema.shape.contact_id,
  description:  ActivityFieldsSchema.shape.description,
  outcome:      ActivityFieldsSchema.shape.outcome,
  next_step:    ActivityFieldsSchema.shape.next_step,
  next_step_due:ActivityFieldsSchema.shape.next_step_due,
  is_done:      ActivityFieldsSchema.shape.is_done,
}).partial();

// ── GET /api/activities ───────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const { company_id, deal_id, owner_id } = req.query;
    const { id: userId, role } = req.user;

    const qb = knex('activities').orderBy('occurred_at', 'desc');

    // Фильтры по связям
    if (company_id) qb.where({ company_id });
    if (deal_id)    qb.where({ deal_id });

    // RBAC-фильтрация по owner_id — логика из оригинала сохранена дословно:
    //   manager → всегда видит только свои (userId)
    //   head/admin → может фильтровать по переданному owner_id, иначе — все
    const effectiveOwner = role === 'manager' ? userId : (owner_id || null);
    if (effectiveOwner) {
      qb.where({ owner_id: effectiveOwner });
    }

    const rows = await qb;
    res.json(rows);
  } catch (err) {
    console.error('[activities/list]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/activities/:id ───────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  try {
    const activity = await knex('activities').where({ id: req.params.id }).first();
    if (!activity) return res.status(404).json({ error: 'Активность не найдена' });
    res.json(activity);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/activities ──────────────────────────────────────────────────────

router.post('/', validate(CreateActivitySchema), async (req, res) => {
  try {
    const d = req.body; // провалидированы и очищены Zod-ом

    // Бизнес-правила с точными сообщениями — вне Zod, чтобы не менять формат ошибок.
    // db.js на фронтенде читает data.error напрямую для отображения в тосте.
    if (!d.type) {
      return res.status(400).json({ error: 'Тип активности обязателен' });
    }
    if (!d.company_id && !d.deal_id) {
      return res.status(400).json({ error: 'Нужен company_id или deal_id' });
    }

    const [activity] = await knex('activities')
      .insert({
        company_id:   d.company_id   || null,
        deal_id:      d.deal_id      || null,
        contact_id:   d.contact_id   || null,
        type:         d.type,
        // Если occurred_at не передан — ставим текущий момент (как в оригинале)
        occurred_at:  d.occurred_at  || new Date().toISOString(),
        description:  (d.description ?? '').trim(),
        outcome:      (d.outcome     ?? '').trim(),
        next_step:    (d.next_step   ?? '').trim(),
        next_step_due:d.next_step_due || null,
        // Boolean() обязателен: без него false || req.user.id → owner_id некорректен
        is_done:      Boolean(d.is_done),
        owner_id:     d.owner_id     || req.user.id,
      })
      .returning('*');

    res.status(201).json(activity);
  } catch (err) {
    console.error('[activities/create]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/activities/:id ───────────────────────────────────────────────────

router.put('/:id', validate(UpdateActivitySchema), async (req, res) => {
  try {
    const existing = await knex('activities').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Активность не найдена' });

    // RBAC: admin/head — любые; manager — только свои
    if (!canModify(existing, req.user)) {
      return res.status(403).json({ error: 'Нет прав на редактирование' });
    }

    const d = req.body; // UpdateActivitySchema.partial() — только отправленные поля
    const e = existing;

    // PUT использует паттерн `d.field ?? e.field` (не spread),
    // точно как в оригинале — это намеренно:
    //   • company_id, deal_id, owner_id — не в SET-клаузе → не меняются
    //   • contact_id, next_step_due — особая обработка через !== undefined:
    //     явный null (сброс связи) отличается от отсутствия поля в запросе

    const [updated] = await knex('activities')
      .where({ id: req.params.id })
      .update({
        type:        d.type        ?? e.type,
        occurred_at: d.occurred_at ?? e.occurred_at,

        // contact_id: если поле пришло явно (даже null) — используем его;
        // если не пришло вообще (undefined) — сохраняем существующее
        contact_id: d.contact_id !== undefined
          ? (d.contact_id || null)
          : e.contact_id,

        description: (d.description ?? e.description ?? '').trim(),
        outcome:     (d.outcome     ?? e.outcome     ?? '').trim(),
        next_step:   (d.next_step   ?? e.next_step   ?? '').trim(),

        // next_step_due: аналогично contact_id — различаем null и undefined
        next_step_due: d.next_step_due !== undefined
          ? (d.next_step_due || null)
          : e.next_step_due,

        // is_done: Boolean() обязателен — false !== undefined, но false || e.is_done = e.is_done
        is_done: d.is_done !== undefined
          ? Boolean(d.is_done)
          : e.is_done,
      })
      .returning('*');

    res.json(updated);
  } catch (err) {
    console.error('[activities/update]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/activities/:id ────────────────────────────────────────────────

router.delete('/:id', async (req, res) => {
  try {
    const existing = await knex('activities').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Активность не найдена' });

    // RBAC: admin/head — любые; manager — только свои
    if (!canModify(existing, req.user)) {
      return res.status(403).json({ error: 'Нет прав на удаление' });
    }

    await knex('activities').where({ id: req.params.id }).del();
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
