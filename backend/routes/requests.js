/**
 * routes/requests.js — Логистические заявки
 *
 * GET    /api/requests              — список (manager видит только свои)
 * GET    /api/requests/:id          — одна заявка с именами компании и перевозчика
 * POST   /api/requests              — создать
 * PUT    /api/requests/:id          — обновить (owner_id защищён от смены)
 * PATCH  /api/requests/:id/status   — сменить статус
 * DELETE /api/requests/:id          — удалить (admin/head)
 *
 * Изменения относительно оригинала:
 *   • Все SQL-запросы переведены на Knex (db/knex.js)
 *   • POST и PUT защищены Zod-валидацией (middleware/validate.js)
 *   • buildInsertParams (массив позиционных параметров) заменён на
 *     buildInsertPayload (объект для Knex .insert() / .update())
 *   • Вся бизнес-логика (RBAC, статусы, маржа, JOIN-имена) не изменена
 */

import { Router } from 'express';
import { z }      from 'zod';
import knex       from '../db/knex.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validate }                  from '../middleware/validate.js';

const router = Router();
router.use(authenticate);

// ── Справочник статусов (именованный экспорт — используется фронтендом) ───────

export const STATUSES = ['new', 'calculating', 'quoted', 'won', 'lost', 'cancelled'];

export const STATUS_LABELS = {
  new:         'Новый',
  calculating: 'Расчёт',
  quoted:      'КП отправлено',
  won:         'Выиграли',
  lost:        'Проиграли',
  cancelled:   'Отменён',
};

// ── Zod-схемы ─────────────────────────────────────────────────────────────────

/**
 * RequestFieldsSchema — базовые типы всех полей без дефолтов.
 *
 * Используется как основа для двух схем:
 *   • CreateRequestSchema — добавляет .default() для POST
 *   • UpdateRequestSchema — делает .partial() для PUT
 *
 * Почему два варианта, а не один с .partial():
 *   PUT сначала загружает existing из БД, затем делает
 *   const d = { ...ex[0], ...req.body } (мерж, как в оригинале).
 *   Если бы UpdateRequestSchema имела .default() — Zod вернул бы поля
 *   с дефолтными значениями даже когда их нет в req.body, и мерж
 *   перетёр бы существующие данные из БД дефолтами.
 *   Без дефолтов отсутствующие поля не попадают в объект Zod-вывода,
 *   и мерж корректно использует ex[0] как фолбэк.
 */
const RequestFieldsSchema = z.object({
  // ── Связи с другими сущностями ──────────────────────────────────────────
  company_id: z.string().uuid('company_id должен быть UUID').nullable().optional(),
  contact_id: z.string().uuid('contact_id должен быть UUID').nullable().optional(),
  deal_id:    z.string().uuid('deal_id должен быть UUID').nullable().optional(),

  // ── Маршрут ─────────────────────────────────────────────────────────────
  // route_from и route_to намеренно без .min(1) здесь:
  // обязательность проверяется в обработчике с точным сообщением «Маршрут обязателен»,
  // чтобы не менять формат ошибки (db.js читает data.error для отображения в тосте).
  route_from:  z.string().max(500).optional(),
  route_to:    z.string().max(500).optional(),
  route_via:   z.string().max(500).optional(),
  // distance_km — INTEGER в схеме БД
  distance_km: z.number().int().positive().nullable().optional(),

  // ── Груз ────────────────────────────────────────────────────────────────
  cargo_type:        z.string().max(50).optional(),
  cargo_description: z.string().max(2000).optional(),
  // weight_kg, volume_m3, cargo_value — NUMERIC в схеме БД (дробные числа)
  weight_kg:    z.number().positive().nullable().optional(),
  volume_m3:    z.number().positive().nullable().optional(),
  // places_count — INTEGER
  places_count: z.number().int().positive().nullable().optional(),
  cargo_value:  z.number().min(0).nullable().optional(),
  // Булевые поля — фронтенд шлёт настоящий JSON boolean
  is_adr:      z.boolean().optional(),
  is_oversized:z.boolean().optional(),
  temperature_regime: z.string().max(100).optional(),

  // ── Условия перевозки ────────────────────────────────────────────────────
  transport_type: z.string().max(50).optional(),
  loading_type:   z.string().max(100).optional(),
  incoterms:      z.string().max(50).optional(),
  // Даты — DATE в PostgreSQL; передаются строкой 'YYYY-MM-DD' или null
  loading_date:  z.string().nullable().optional(),
  delivery_date: z.string().nullable().optional(),
  is_regular: z.boolean().optional(),
  frequency:  z.string().max(100).optional(),

  // ── Финансы ─────────────────────────────────────────────────────────────
  // Все суммы — NUMERIC(15,2) в БД
  budget:       z.number().min(0).nullable().optional(),
  our_rate:     z.number().min(0).nullable().optional(),
  carrier_rate: z.number().min(0).nullable().optional(),
  // margin может быть отрицательной (убыточная перевозка) → без .min()
  margin:         z.number().nullable().optional(),
  margin_percent: z.number().nullable().optional(),
  currency: z.enum(['RUB', 'USD', 'EUR']).optional(),

  // ── Статус и причина проигрыша ───────────────────────────────────────────
  status:      z.enum(STATUSES).optional(),
  loss_reason: z.string().max(500).optional(),

  // ── Перевозчик и ответственный ───────────────────────────────────────────
  carrier_id: z.string().uuid('carrier_id должен быть UUID').nullable().optional(),
  // owner_id принимается при POST; при PUT — ВСЕГДА из ex[0].owner_id (см. PUT-обработчик)
  owner_id: z.string().uuid('owner_id должен быть UUID').optional(),

  // ── Заметки ──────────────────────────────────────────────────────────────
  notes: z.string().max(10000).optional(),
});

/**
 * CreateRequestSchema — для POST /api/requests.
 * Все поля получают дефолты — гарантирует чистый INSERT без undefined.
 */
const CreateRequestSchema = RequestFieldsSchema.extend({
  company_id:    RequestFieldsSchema.shape.company_id.default(null),
  contact_id:    RequestFieldsSchema.shape.contact_id.default(null),
  deal_id:       RequestFieldsSchema.shape.deal_id.default(null),
  route_from:    RequestFieldsSchema.shape.route_from.default(''),
  route_to:      RequestFieldsSchema.shape.route_to.default(''),
  route_via:     RequestFieldsSchema.shape.route_via.default(''),
  distance_km:   RequestFieldsSchema.shape.distance_km.default(null),
  cargo_type:         RequestFieldsSchema.shape.cargo_type.default('general'),
  cargo_description:  RequestFieldsSchema.shape.cargo_description.default(''),
  weight_kg:          RequestFieldsSchema.shape.weight_kg.default(null),
  volume_m3:          RequestFieldsSchema.shape.volume_m3.default(null),
  places_count:       RequestFieldsSchema.shape.places_count.default(null),
  cargo_value:        RequestFieldsSchema.shape.cargo_value.default(null),
  is_adr:             RequestFieldsSchema.shape.is_adr.default(false),
  is_oversized:       RequestFieldsSchema.shape.is_oversized.default(false),
  temperature_regime: RequestFieldsSchema.shape.temperature_regime.default(''),
  transport_type: RequestFieldsSchema.shape.transport_type.default('auto'),
  loading_type:   RequestFieldsSchema.shape.loading_type.default(''),
  incoterms:      RequestFieldsSchema.shape.incoterms.default(''),
  loading_date:   RequestFieldsSchema.shape.loading_date.default(null),
  delivery_date:  RequestFieldsSchema.shape.delivery_date.default(null),
  is_regular: RequestFieldsSchema.shape.is_regular.default(false),
  frequency:  RequestFieldsSchema.shape.frequency.default(''),
  budget:       RequestFieldsSchema.shape.budget.default(null),
  our_rate:     RequestFieldsSchema.shape.our_rate.default(null),
  carrier_rate: RequestFieldsSchema.shape.carrier_rate.default(null),
  margin:         RequestFieldsSchema.shape.margin.default(null),
  margin_percent: RequestFieldsSchema.shape.margin_percent.default(null),
  currency:    RequestFieldsSchema.shape.currency.default('RUB'),
  status:      RequestFieldsSchema.shape.status.default('new'),
  loss_reason: RequestFieldsSchema.shape.loss_reason.default(''),
  carrier_id: RequestFieldsSchema.shape.carrier_id.default(null),
  notes: RequestFieldsSchema.shape.notes.default(''),
});

/**
 * UpdateRequestSchema — для PUT /api/requests/:id.
 * Все поля опциональны, дефолтов НЕТ — чтобы мерж с existing работал корректно.
 * owner_id исключён: его нельзя менять через PUT (см. комментарий в обработчике).
 */
const UpdateRequestSchema = RequestFieldsSchema
  .omit({ owner_id: true })
  .partial();

// ── Вспомогательная функция: объект для INSERT / UPDATE ───────────────────────

/**
 * buildInsertPayload — собирает объект полей для Knex .insert() / .update().
 *
 * Заменяет оригинальный buildInsertParams (массив позиционных параметров).
 * Логика каждого поля сохранена побайтово с оригиналом:
 *   • Строки: .trim() там где был trim
 *   • Числа:  || null (сохраняет поведение: 0 → null, совпадает с оригиналом)
 *   • Булевые: Boolean() — ОБЯЗАТЕЛЕН, иначе false || null = null
 *   • owner_id: всегда принимается снаружи — при PUT передаём ex[0].owner_id
 */
function buildInsertPayload(d, ownerId) {
  return {
    // Связи
    company_id: d.company_id || null,
    contact_id: d.contact_id || null,
    deal_id:    d.deal_id    || null,

    // Маршрут
    route_from:  (d.route_from  || '').trim(),
    route_to:    (d.route_to    || '').trim(),
    route_via:   (d.route_via   || '').trim(),
    distance_km: d.distance_km  || null,

    // Груз
    cargo_type:        d.cargo_type        || 'general',
    cargo_description: (d.cargo_description || '').trim(),
    weight_kg:    d.weight_kg    || null,
    volume_m3:    d.volume_m3    || null,
    places_count: d.places_count || null,
    cargo_value:  d.cargo_value  || null,
    // Boolean() обязателен — false || null = null без него
    is_adr:       Boolean(d.is_adr),
    is_oversized: Boolean(d.is_oversized),
    temperature_regime: d.temperature_regime || '',

    // Условия
    transport_type: d.transport_type || 'auto',
    loading_type:   d.loading_type   || '',
    incoterms:      d.incoterms      || '',
    loading_date:   d.loading_date   || null,
    delivery_date:  d.delivery_date  || null,
    is_regular: Boolean(d.is_regular),
    frequency:  d.frequency || '',

    // Финансы (margin может быть отрицательной — || null оставляет 0 как null,
    // что совпадает с поведением оригинала)
    budget:         d.budget       || null,
    our_rate:       d.our_rate     || null,
    carrier_rate:   d.carrier_rate || null,
    margin:         d.margin       || null,
    margin_percent: d.margin_percent || null,
    currency: d.currency || 'RUB',

    // Статус
    status:      d.status      || 'new',
    loss_reason: d.loss_reason || '',

    // Перевозчик и ответственный
    carrier_id: d.carrier_id || null,
    owner_id:   ownerId,          // намеренно из аргумента, не из d

    // Заметки
    notes: (d.notes || '').trim(),
  };
}

// ── GET /api/requests ─────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const { id: userId, role } = req.user;
    const { company_id, status, transport_type, owner_id, q } = req.query;

    // Строим запрос с тремя LEFT JOIN:
    //   companies → company_name
    //   carriers  → carrier_name
    //   users     → owner_name (конкатенация first_name + ' ' + last_name)
    // Имена alias-колонок совпадают с оригиналом — фронтенд их читает.
    const qb = knex('requests as r')
      .select(
        'r.*',
        'co.name as company_name',
        'ca.name as carrier_name',
        // knex.raw для конкатенации — синтаксис PostgreSQL, аналог оригинального SQL
        knex.raw("(u.first_name || ' ' || u.last_name) as owner_name")
      )
      .leftJoin('companies as co', 'co.id', 'r.company_id')
      .leftJoin('carriers  as ca', 'ca.id', 'r.carrier_id')
      .leftJoin('users     as u',  'u.id',  'r.owner_id')
      .orderBy('r.created_at', 'desc');

    // RBAC: менеджер видит только свои заявки — критичная проверка
    if (role === 'manager') {
      qb.where('r.owner_id', userId);
    } else if (owner_id) {
      qb.where('r.owner_id', owner_id);
    }

    // Фильтры
    if (company_id)     qb.where('r.company_id',     company_id);
    if (status)         qb.where('r.status',          status);
    if (transport_type) qb.where('r.transport_type',  transport_type);

    // Полнотекстовый поиск по маршруту и описанию груза
    if (q?.trim()) {
      const s = `%${q.toLowerCase().trim()}%`;
      qb.where(function () {
        this
          .whereRaw('LOWER(r.route_from)         LIKE ?', [s])
          .orWhereRaw('LOWER(r.route_to)           LIKE ?', [s])
          .orWhereRaw('LOWER(r.cargo_description)  LIKE ?', [s]);
      });
    }

    const rows = await qb;
    res.json(rows);
  } catch (err) {
    console.error('[requests/list]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/requests/:id ─────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  try {
    // JOIN с companies и carriers — те же alias-имена, что в оригинале
    const row = await knex('requests as r')
      .select(
        'r.*',
        'co.name as company_name',
        'ca.name as carrier_name'
      )
      .leftJoin('companies as co', 'co.id', 'r.company_id')
      .leftJoin('carriers  as ca', 'ca.id', 'r.carrier_id')
      .where('r.id', req.params.id)
      .first();

    if (!row) return res.status(404).json({ error: 'Запрос не найден' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/requests ────────────────────────────────────────────────────────

router.post('/', validate(CreateRequestSchema), async (req, res) => {
  try {
    const d = req.body; // провалидированы и очищены Zod-ом

    // Проверка обязательности маршрута — сообщение вне Zod (см. companies.js).
    // Фронтенд читает data.error напрямую: изменение формата сломало бы тост.
    if (!d.route_from?.trim() || !d.route_to?.trim()) {
      return res.status(400).json({ error: 'Маршрут (откуда и куда) обязателен' });
    }

    const [request] = await knex('requests')
      .insert(buildInsertPayload(d, d.owner_id ?? req.user.id))
      .returning('*');

    res.status(201).json(request);
  } catch (err) {
    console.error('[requests/create]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/requests/:id ─────────────────────────────────────────────────────

router.put('/:id', validate(UpdateRequestSchema), async (req, res) => {
  try {
    // Загружаем существующую запись для мержа
    const existing = await knex('requests').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Запрос не найден' });

    // Мерж: поля из req.body перекрывают existing, но только те что пришли.
    // UpdateRequestSchema без дефолтов гарантирует, что отсутствующие поля
    // не попадут в req.body → spread не затрёт существующие значения.
    const d = { ...existing, ...req.body };

    if (!d.route_from?.trim() || !d.route_to?.trim()) {
      return res.status(400).json({ error: 'Маршрут обязателен' });
    }

    // RBAC: owner_id заявки нельзя сменить через PUT — защита от угона заявок.
    // Всегда передаём existing.owner_id, даже если req.body содержит другой.
    const [updated] = await knex('requests')
      .where({ id: req.params.id })
      .update(buildInsertPayload(d, existing.owner_id))
      .returning('*');

    res.json(updated);
  } catch (err) {
    console.error('[requests/update]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/requests/:id/status ───────────────────────────────────────────

router.patch('/:id/status', async (req, res) => {
  try {
    const { status, loss_reason } = req.body;

    // Проверка статуса в обработчике — сохраняем точное сообщение оригинала
    if (!STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Некорректный статус' });
    }

    const [updated] = await knex('requests')
      .where({ id: req.params.id })
      .update({
        status,
        loss_reason: loss_reason || '',
      })
      .returning('*');

    // .first() не используем — если запись не найдена, Knex вернёт []
    if (!updated) return res.status(404).json({ error: 'Запрос не найден' });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/requests/:id ──────────────────────────────────────────────────

router.delete('/:id', requireRole('admin', 'head'), async (req, res) => {
  try {
    // .del() возвращает число удалённых строк (0 = не найдено)
    const deleted = await knex('requests').where({ id: req.params.id }).del();
    if (!deleted) return res.status(404).json({ error: 'Запрос не найден' });
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
