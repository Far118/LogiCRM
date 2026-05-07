/**
 * routes/carriers.js — Перевозчики
 *
 * GET    /api/carriers              — список с фильтрами
 * GET    /api/carriers/:id
 * POST   /api/carriers
 * PUT    /api/carriers/:id
 * DELETE /api/carriers/:id          (admin/head)
 *
 * Изменения относительно оригинала:
 *   • Все SQL-запросы переведены на Knex (db/knex.js)
 *   • POST и PUT защищены Zod-валидацией (middleware/validate.js)
 *   • JSONB-поля, паттерны !==undefined и Boolean() в PUT сохранены точно
 */

import { Router } from 'express';
import { z }      from 'zod';
import knex       from '../db/knex.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validate }                  from '../middleware/validate.js';

const router = Router();
router.use(authenticate);

// ── JsonbArray — препроцессор для JSONB-полей массивов ────────────────────────
//
// Принимает JS-массив, JSON-строку или undefined/null → всегда возвращает массив.
// Тот же паттерн, что в companies.js и requests.js.

const JsonbArray = z.preprocess(
  (v) => {
    if (Array.isArray(v))              return v;
    if (v === undefined || v === null)  return [];
    if (typeof v === 'string') {
      try { return JSON.parse(v); } catch { return []; }
    }
    return [];
  },
  z.array(z.string()).default([])
);

// ── Zod-схемы ─────────────────────────────────────────────────────────────────

/**
 * CarrierFieldsSchema — базовые типы без дефолтов.
 *
 * name намеренно без .min(1): обязательность проверяется в обработчике
 * с оригинальным сообщением 'Название обязательно'.
 */
const CarrierFieldsSchema = z.object({
  // Реквизиты
  name:           z.string().max(255).optional(),
  inn:            z.string().max(12).optional(),
  ogrn:           z.string().max(15).optional(),
  contact_person: z.string().max(255).optional(),
  phone:          z.string().max(50).optional(),
  email:          z.string().max(255).optional(),
  telegram:       z.string().max(255).optional(),

  // JSONB-массивы
  transport_types: JsonbArray,
  directions:      JsonbArray,
  routes:          JsonbArray,

  // Рейтинг и статистика
  // rating: INTEGER CHECK 1-5
  rating:           z.number().int().min(1).max(5).optional(),
  // on_time_percent: INTEGER nullable, CHECK 0-100
  on_time_percent:  z.number().int().min(0).max(100).nullable().optional(),
  total_shipments:  z.number().int().min(0).optional(),

  // Ставки (NUMERIC, nullable — 0 может стать null через || null в обработчике,
  // это поведение оригинала которое мы сохраняем)
  rate_per_km:  z.number().min(0).nullable().optional(),
  rate_per_ton: z.number().min(0).nullable().optional(),
  min_rate:     z.number().min(0).nullable().optional(),
  currency:     z.enum(['RUB', 'USD', 'EUR']).optional(),

  // Документы и статус
  has_license:     z.boolean().optional(),
  license_expires: z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Формат даты: YYYY-MM-DD')
    .nullable()
    .optional(),
  is_vat:   z.boolean().optional(),
  // is_active: дефолт true (не false) — специфика перевозчиков
  is_active: z.boolean().optional(),

  notes: z.string().max(5000).optional(),
});

/**
 * CreateCarrierSchema — для POST /api/carriers.
 * Дефолты выставлены в соответствии с оригинальным INSERT.
 *
 * Особенность is_active: в оригинале `d.is_active !== false` — дефолт true.
 * Zod-дефолт .default(true) воспроизводит это точно:
 *   undefined → true, true → true, false → false.
 */
const CreateCarrierSchema = CarrierFieldsSchema.extend({
  name:            CarrierFieldsSchema.shape.name.default(''),
  inn:             CarrierFieldsSchema.shape.inn.default(''),
  ogrn:            CarrierFieldsSchema.shape.ogrn.default(''),
  contact_person:  CarrierFieldsSchema.shape.contact_person.default(''),
  phone:           CarrierFieldsSchema.shape.phone.default(''),
  email:           CarrierFieldsSchema.shape.email.default(''),
  telegram:        CarrierFieldsSchema.shape.telegram.default(''),
  rating:          CarrierFieldsSchema.shape.rating.default(3),
  on_time_percent: CarrierFieldsSchema.shape.on_time_percent.default(null),
  total_shipments: CarrierFieldsSchema.shape.total_shipments.default(0),
  rate_per_km:     CarrierFieldsSchema.shape.rate_per_km.default(null),
  rate_per_ton:    CarrierFieldsSchema.shape.rate_per_ton.default(null),
  min_rate:        CarrierFieldsSchema.shape.min_rate.default(null),
  currency:        CarrierFieldsSchema.shape.currency.default('RUB'),
  has_license:     CarrierFieldsSchema.shape.has_license.default(false),
  license_expires: CarrierFieldsSchema.shape.license_expires.default(null),
  is_vat:          CarrierFieldsSchema.shape.is_vat.default(false),
  is_active:       CarrierFieldsSchema.shape.is_active.default(true),
  notes:           CarrierFieldsSchema.shape.notes.default(''),
});

/**
 * UpdateCarrierSchema — для PUT /api/carriers/:id.
 * Все поля опциональны, дефолтов нет.
 * Обработчик использует `d.field ?? e.field` или `d.field !== undefined` паттерны
 * (точно как в оригинале) для корректного мержа с существующей записью.
 */
const UpdateCarrierSchema = CarrierFieldsSchema.partial();

// ── GET /api/carriers ─────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    // ПРИМЕЧАНИЕ: `direction` присутствует в оригинальной деструктуризации,
    // но никогда не используется в условиях запроса (мёртвый код).
    // Поведение сохранено: параметр принимается, но на запрос не влияет.
    const { q, transport_type, active } = req.query;

    const qb = knex('carriers').orderBy('rating', 'desc').orderBy('name', 'asc');

    // Фильтр по активности: по умолчанию показываем только активных (is_active = true).
    // Явное `active=all` отключает фильтр, `active=false` — только неактивные.
    if (active !== 'all') {
      qb.where({ is_active: active === 'false' ? false : true });
    }

    // Полнотекстовый поиск по названию и ИНН
    if (q?.trim()) {
      const s = `%${q.toLowerCase().trim()}%`;
      qb.where(function () {
        this
          .whereRaw('LOWER(name) LIKE ?', [s])
          .orWhereRaw('inn LIKE ?', [s]);
      });
    }

    // Фильтр по типу транспорта — JSONB contains (@>)
    // Ищем перевозчиков, у которых transport_types содержит переданное значение
    if (transport_type) {
      qb.whereRaw('transport_types @> ?::jsonb', [JSON.stringify([transport_type])]);
    }

    const rows = await qb;
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/carriers/:id ─────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  try {
    const carrier = await knex('carriers').where({ id: req.params.id }).first();
    if (!carrier) return res.status(404).json({ error: 'Перевозчик не найден' });
    res.json(carrier);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/carriers ────────────────────────────────────────────────────────

router.post('/', validate(CreateCarrierSchema), async (req, res) => {
  try {
    const d = req.body; // провалидированы Zod-ом

    // Проверка обязательного имени — в обработчике с оригинальным сообщением
    if (!d.name?.trim()) {
      return res.status(400).json({ error: 'Название обязательно' });
    }

    const [carrier] = await knex('carriers')
      .insert({
        name:            d.name.trim(),
        inn:             d.inn            || '',
        ogrn:            d.ogrn           || '',
        contact_person:  d.contact_person || '',
        phone:           d.phone          || '',
        email:           d.email          || '',
        telegram:        d.telegram       || '',

        // JSONB-поля — JSON.stringify, как в оригинале
        transport_types: JSON.stringify(d.transport_types || []),
        directions:      JSON.stringify(d.directions      || []),
        routes:          JSON.stringify(d.routes          || []),

        rating:           d.rating           || 3,
        on_time_percent:  d.on_time_percent   || null,
        total_shipments:  d.total_shipments   || 0,

        // Числовые ставки: 0 → null (поведение оригинала через ||)
        rate_per_km:  d.rate_per_km  || null,
        rate_per_ton: d.rate_per_ton || null,
        min_rate:     d.min_rate     || null,
        currency:     d.currency     || 'RUB',

        // Булевые — Boolean() для безопасного приведения
        has_license:     Boolean(d.has_license),
        license_expires: d.license_expires || null,
        is_vat:          Boolean(d.is_vat),
        // is_active: Zod-дефолт true уже учтён; Boolean() — страховка
        is_active:       Boolean(d.is_active),
        notes:           d.notes || '',
      })
      .returning('*');

    res.status(201).json(carrier);
  } catch (err) {
    console.error('[carriers/create]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/carriers/:id ─────────────────────────────────────────────────────

router.put('/:id', validate(UpdateCarrierSchema), async (req, res) => {
  try {
    const existing = await knex('carriers').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Перевозчик не найден' });

    const d = req.body; // UpdateCarrierSchema.partial() — только отправленные поля
    const e = existing;

    // Проверка имени с оригинальным сообщением
    if (d.name !== undefined && !d.name?.trim()) {
      return res.status(400).json({ error: 'Название обязательно' });
    }

    // PUT использует смешанный паттерн из оригинала:
    //   • d.field ?? e.field — для полей, где null = "нет значения" (строки, рейтинг)
    //   • d.field !== undefined — для nullable-числовых и булевых,
    //     чтобы явный null / false / 0 сохранялся (сброс значения)

    const [updated] = await knex('carriers')
      .where({ id: req.params.id })
      .update({
        name:            d.name?.trim()     ?? e.name,
        inn:             d.inn              ?? e.inn,
        ogrn:            d.ogrn             ?? e.ogrn,
        contact_person:  d.contact_person   ?? e.contact_person,
        phone:           d.phone            ?? e.phone,
        email:           d.email            ?? e.email,
        telegram:        d.telegram         ?? e.telegram,

        // JSONB: если поле пришло — берём его (Zod вернул массив или []),
        // если не пришло (undefined) — сохраняем existing (уже объект из БД)
        transport_types: JSON.stringify(d.transport_types ?? e.transport_types),
        directions:      JSON.stringify(d.directions      ?? e.directions),
        routes:          JSON.stringify(d.routes          ?? e.routes),

        rating:          d.rating           ?? e.rating,
        total_shipments: d.total_shipments  ?? e.total_shipments,
        currency:        d.currency         ?? e.currency,
        notes:           d.notes            ?? e.notes,

        // Поля, где нужно различать "не передано" (undefined) и "передан null" (сброс):
        on_time_percent: d.on_time_percent !== undefined ? d.on_time_percent : e.on_time_percent,
        rate_per_km:     d.rate_per_km     !== undefined ? d.rate_per_km     : e.rate_per_km,
        rate_per_ton:    d.rate_per_ton    !== undefined ? d.rate_per_ton    : e.rate_per_ton,
        min_rate:        d.min_rate        !== undefined ? d.min_rate        : e.min_rate,

        // Булевые — Boolean() обязателен; !== undefined чтобы false не стал e.field
        has_license:     d.has_license    !== undefined ? Boolean(d.has_license)  : e.has_license,
        is_vat:          d.is_vat         !== undefined ? Boolean(d.is_vat)       : e.is_vat,
        is_active:       d.is_active      !== undefined ? Boolean(d.is_active)    : e.is_active,

        // license_expires: || null убирает пустую строку, !== undefined сохраняет сброс
        license_expires: d.license_expires !== undefined
          ? (d.license_expires || null)
          : e.license_expires,
      })
      .returning('*');

    res.json(updated);
  } catch (err) {
    console.error('[carriers/update]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/carriers/:id ──────────────────────────────────────────────────

router.delete('/:id', requireRole('admin', 'head'), async (req, res) => {
  try {
    const deleted = await knex('carriers').where({ id: req.params.id }).del();
    if (!deleted) return res.status(404).json({ error: 'Перевозчик не найден' });
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
