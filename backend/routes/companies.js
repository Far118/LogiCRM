/**
 * routes/companies.js
 *
 * GET    /api/companies        — список (manager видит только свои)
 * GET    /api/companies/:id    — одна компания
 * POST   /api/companies        — создать
 * PUT    /api/companies/:id    — обновить
 * DELETE /api/companies/:id    — удалить (admin/head)
 * POST   /api/companies/bulk   — массовые действия
 *
 * Изменения относительно оригинала:
 *   • Все SQL-запросы переведены на Knex (db/knex.js)
 *   • POST и PUT защищены Zod-валидацией (middleware/validate.js)
 *   • Исправлен баг оригинала: export default стоит после всех роутов
 *   • Вся бизнес-логика (RBAC, INN-дедупликация, bulk-действия) не изменена
 */

import { Router } from 'express';
import { z }      from 'zod';
import knex       from '../db/knex.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validate }                  from '../middleware/validate.js';

const router = Router();
router.use(authenticate);

// ── Zod-вспомогательные типы ──────────────────────────────────────────────────

/**
 * JsonbArray — безопасный препроцессор для JSONB-полей массивов.
 *
 * Принимает:
 *   • JS-массив строк  → оставляет как есть
 *   • JSON-строка      → пробует JSON.parse, при ошибке → []
 *   • undefined/null   → []
 *
 * Это важно: PostgreSQL хранит regions/cargo_types/directions/routes/tags
 * как JSONB, а фронтенд всегда шлёт их как массивы. Zod делает strip
 * неизвестных элементов через z.array(z.string()).
 */
const JsonbArray = z.preprocess(
  (v) => {
    if (Array.isArray(v))           return v;
    if (v === undefined || v === null) return [];
    if (typeof v === 'string') {
      try { return JSON.parse(v); } catch { return []; }
    }
    return [];
  },
  z.array(z.string()).default([])
);

// Допустимые значения для enum-полей (совпадают со schema.sql)
const SEGMENTS  = ['cold_lead','warm_lead','hot_lead','active_client','vip','inactive','lost'];
const PRIORITIES = ['high', 'medium', 'low'];

// ── Zod-схемы ─────────────────────────────────────────────────────────────────

/**
 * CreateCompanySchema — валидация тела POST /api/companies.
 *
 * INN намеренно описан как z.string() без refine на длину:
 * специфичные сообщения об ИНН («ИНН обязателен», «10 или 12 цифр»)
 * должны возвращаться точно в таком же виде, как в оригинале,
 * потому что фронтенд читает data.error напрямую для отображения в тосте.
 * Если перенести эту валидацию в Zod, validate() вернёт
 * { error: 'Ошибка валидации' } вместо конкретного сообщения,
 * что сломает UX. Поэтому INN проверяется в обработчике роута.
 */
const CreateCompanySchema = z.object({
  // ИНН — обязателен; дальнейшая проверка (10/12 цифр) — в обработчике
  inn: z.string({ required_error: 'ИНН обязателен' }).min(1, 'ИНН обязателен'),

  // Основные поля
  name:            z.string().max(255).optional().default('').transform(s => s.trim()),
  ogrn:            z.string().max(20).optional().default(''),
  website:         z.string().max(500).optional().default(''),
  address_legal:   z.string().max(500).optional().default(''),
  address_actual:  z.string().max(500).optional().default(''),
  industry:        z.string().max(100).optional().default(''),
  description:     z.string().max(2000).optional().default(''),
  segment:         z.enum(SEGMENTS).optional().default('cold_lead'),
  priority:        z.enum(PRIORITIES).optional().default('medium'),
  source:          z.string().max(200).optional().default(''),

  // JSONB-поля — массивы строк
  regions:      JsonbArray,
  cargo_types:  JsonbArray,
  directions:   JsonbArray,
  routes:       JsonbArray,
  tags:         JsonbArray,

  // Логистические характеристики
  shipment_freq:    z.string().max(100).optional().default(''),
  volume_monthly:   z.string().max(100).optional().default(''),
  potential:        z.string().max(100).optional().default(''),
  current_carrier:  z.string().max(255).optional().default(''),
  switch_reason:    z.string().max(500).optional().default(''),

  // Ответственный (если не передан — берётся req.user.id в обработчике)
  owner_id: z.string().uuid().optional(),

  // Даты следующего касания и первого контакта
  next_action_at:   z.string().nullable().optional().default(null),
  next_action_type: z.string().max(50).optional().default(''),
  first_contact_at: z.string().nullable().optional().default(null),
});

/**
 * UpdateCompanySchema — валидация тела PUT /api/companies/:id.
 *
 * Намеренно описана отдельно от CreateCompanySchema, а не через .extend().partial().
 *
 * Причина: в БД могут лежать ЛЕГАСИ-значения, созданные до смены справочников.
 * Пример: старые компании имеют segment='client', а не 'active_client'.
 * Если наследовать строгий z.enum(SEGMENTS) из CreateCompanySchema — Zod отклонит
 * PUT с легаси-данными и пользователь не сможет отредактировать старую компанию.
 *
 * Правило: Create-схема строгая (не даём создавать мусор),
 *          Update-схема мягкая по enum/max (не ломаем существующие данные).
 *
 * .max() ограничения тоже убраны — старые записи могут содержать длинные строки.
 * PostgreSQL-ограничения на уровне БД остаются последним рубежом защиты.
 */
const UpdateCompanySchema = z.object({
  inn:             z.string().optional(),
  name:            z.string().optional().transform(s => s?.trim() ?? s),
  ogrn:            z.string().optional(),
  website:         z.string().optional(),
  address_legal:   z.string().optional(),
  address_actual:  z.string().optional(),
  industry:        z.string().optional(),
  description:     z.string().optional(),
  // z.string() вместо z.enum() — принимает любое значение из БД (в т.ч. легаси)
  segment:         z.string().optional(),
  priority:        z.string().optional(),
  source:          z.string().optional(),

  // JSONB-поля — тот же препроцессор JsonbArray
  regions:      JsonbArray,
  cargo_types:  JsonbArray,
  directions:   JsonbArray,
  routes:       JsonbArray,
  tags:         JsonbArray,

  shipment_freq:    z.string().optional(),
  volume_monthly:   z.string().optional(),
  potential:        z.string().optional(),
  current_carrier:  z.string().optional(),
  switch_reason:    z.string().optional(),

  owner_id: z.string().uuid().optional(),

  next_action_at:   z.string().nullable().optional(),
  next_action_type: z.string().optional(),
  first_contact_at: z.string().nullable().optional(),
}).partial();

// ── Вспомогательная функция доступа ──────────────────────────────────────────

/**
 * Загружает компанию по ID и проверяет права менеджера.
 *
 * Логика не изменена по сравнению с оригиналом:
 *   • admin/head — могут читать любую компанию
 *   • manager    — только свои (owner_id === userId)
 *
 * Возвращает объект компании или null (если не найдена).
 * Бросает ошибку со статусом 403 при попытке менеджера открыть чужую.
 */
async function getOwnedCompany(companyId, userId, role) {
  // Один запрос вместо сырого SQL с $1
  const company = await knex('companies').where({ id: companyId }).first();
  if (!company) return null;

  // Менеджер не имеет доступа к чужой компании
  if (role === 'manager' && company.owner_id !== userId) {
    throw Object.assign(new Error('Нет доступа к этой компании'), { status: 403 });
  }
  return company;
}

// ── GET /api/companies ────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const { role, id: userId }                   = req.user;
    const { owner_id, segment, priority, q: search } = req.query;

    // Начинаем строить запрос — сортировка по дате создания (свежие сверху)
    const qb = knex('companies').orderBy('created_at', 'desc');

    // RBAC: менеджер видит только свои компании — этот блок критичен
    if (role === 'manager') {
      qb.where({ owner_id: userId });
    } else if (owner_id) {
      // head/admin могут фильтровать по конкретному менеджеру
      qb.where({ owner_id });
    }

    // Фильтры по воронке и приоритету
    if (segment)  qb.where({ segment });
    if (priority) qb.where({ priority });

    // Полнотекстовый поиск по имени, ИНН и отрасли
    // Используем whereRaw для LIKE с LOWER() — аналог оригинального SQL
    if (search?.trim()) {
      const s = `%${search.toLowerCase().trim()}%`;
      qb.where(function () {
        this
          .whereRaw('LOWER(name) LIKE ?',     [s])
          .orWhereRaw('inn LIKE ?',            [s])
          .orWhereRaw('LOWER(industry) LIKE ?', [s]);
      });
    }

    const rows = await qb;
    res.json(rows);
  } catch (err) {
    console.error('[companies/list]', err.message);
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// ── GET /api/companies/:id ────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  try {
    const company = await getOwnedCompany(req.params.id, req.user.id, req.user.role);
    if (!company) return res.status(404).json({ error: 'Компания не найдена' });
    res.json(company);
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// ── POST /api/companies ───────────────────────────────────────────────────────

router.post('/', validate(CreateCompanySchema), async (req, res) => {
  try {
    const d = req.body; // уже провалидированы и очищены Zod-ом

    // ── Валидация ИНН ────────────────────────────────────────────────────────
    // Намеренно вне Zod — см. комментарий к CreateCompanySchema выше.
    // Оставляем точно такие же сообщения, как в оригинале.
    const inn = String(d.inn || '').replace(/\D/g, '');
    if (!inn) {
      return res.status(400).json({ error: 'ИНН обязателен' });
    }
    if (inn.length !== 10 && inn.length !== 12) {
      return res.status(400).json({ error: 'ИНН должен содержать 10 цифр (юрлицо) или 12 (ИП)' });
    }

    // ── Проверка уникальности ИНН ────────────────────────────────────────────
    // JOIN с users для получения имени ответственного в одном запросе.
    // Формат 409-ответа критичен для фронтенда — db.js читает existing_id,
    // existing_name, existing_owner для показа подсказки пользователю.
    const dup = await knex('companies as c')
      .leftJoin('users as u', 'u.id', 'c.owner_id')
      .select('c.id', 'c.name', 'u.first_name', 'u.last_name', 'u.email')
      .where('c.inn', inn)
      .first();

    if (dup) {
      const owner = dup.first_name
        ? `${dup.first_name} ${dup.last_name}`.trim()
        : dup.email || 'другой менеджер';

      return res.status(409).json({
        error:          `ИНН ${inn} уже есть в базе — компания «${dup.name}» (ответственный: ${owner})`,
        existing_id:    dup.id,
        existing_name:  dup.name,
        existing_owner: owner,
      });
    }

    // ── INSERT ───────────────────────────────────────────────────────────────
    // JSONB-поля сериализуем через JSON.stringify — pg-драйвер принимает
    // строки и правильно кастует их в JSONB. Это зеркалит поведение оригинала.
    const [company] = await knex('companies')
      .insert({
        name:            (d.name || '').trim() || `Компания ИНН ${inn}`,
        inn,
        ogrn:            d.ogrn            ?? '',
        website:         d.website         ?? '',
        address_legal:   d.address_legal   ?? '',
        address_actual:  d.address_actual  ?? '',
        regions:         JSON.stringify(d.regions      ?? []),
        industry:        d.industry        ?? '',
        description:     d.description     ?? '',
        segment:         d.segment         ?? 'cold_lead',
        cargo_types:     JSON.stringify(d.cargo_types  ?? []),
        directions:      JSON.stringify(d.directions   ?? []),
        routes:          JSON.stringify(d.routes       ?? []),
        shipment_freq:   d.shipment_freq   ?? '',
        volume_monthly:  d.volume_monthly  ?? '',
        potential:       d.potential       ?? '',
        current_carrier: d.current_carrier ?? '',
        switch_reason:   d.switch_reason   ?? '',
        owner_id:        d.owner_id        ?? req.user.id,
        source:          d.source          ?? '',
        priority:        d.priority        ?? 'medium',
        tags:            JSON.stringify(d.tags         ?? []),
        next_action_at:  d.next_action_at  || null,
        next_action_type:d.next_action_type ?? '',
        first_contact_at:d.first_contact_at || null,
      })
      .returning('*');

    res.status(201).json(company);
  } catch (err) {
    console.error('[companies/create]', err.message);
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// ── PUT /api/companies/:id ────────────────────────────────────────────────────

router.put('/:id', validate(UpdateCompanySchema), async (req, res) => {
  try {
    // Проверяем существование и права доступа
    const existing = await getOwnedCompany(req.params.id, req.user.id, req.user.role);
    if (!existing) return res.status(404).json({ error: 'Компания не найдена' });

    const d = req.body; // провалидированы Zod-ом

    // ── Валидация ИНН ────────────────────────────────────────────────────────
    // При PUT ИНН может не меняться — фолбэк на existing.inn
    const newInn = String(d.inn ?? existing.inn ?? '').replace(/\D/g, '');
    if (!newInn) {
      return res.status(400).json({ error: 'ИНН обязателен' });
    }
    if (newInn.length !== 10 && newInn.length !== 12) {
      return res.status(400).json({ error: 'ИНН должен содержать 10 или 12 цифр' });
    }

    // ── Проверка уникальности ИНН при смене ──────────────────────────────────
    // Только если ИНН реально изменился — не делаем лишний запрос
    if (newInn !== existing.inn) {
      // Исключаем текущую компанию из поиска дубликатов
      const dup2 = await knex('companies as c')
        .leftJoin('users as u', 'u.id', 'c.owner_id')
        .select('c.id', 'c.name', 'u.first_name', 'u.last_name', 'u.email')
        .where('c.inn', newInn)
        .whereNot('c.id', req.params.id)
        .first();

      if (dup2) {
        const owner2 = dup2.first_name
          ? `${dup2.first_name} ${dup2.last_name}`.trim()
          : dup2.email || 'другой менеджер';

        return res.status(409).json({
          error:          `ИНН ${newInn} уже есть в базе — компания «${dup2.name}» (ответственный: ${owner2})`,
          existing_id:    dup2.id,
          existing_name:  dup2.name,
          existing_owner: owner2,
        });
      }
    }

    // ── UPDATE ───────────────────────────────────────────────────────────────
    // При отсутствии поля в req.body используем значение из existing —
    // это полный PUT (замена всех полей), поведение совпадает с оригиналом.
    // JSONB-поля: если d.X не передано — берём existing.X (уже объект из БД).
    const [updated] = await knex('companies')
      .where({ id: req.params.id })
      .update({
        name:            ((d.name ?? '') || '').trim() || existing.name,
        inn:             newInn,
        ogrn:            d.ogrn            ?? existing.ogrn,
        website:         d.website         ?? existing.website,
        address_legal:   d.address_legal   ?? existing.address_legal,
        address_actual:  d.address_actual  ?? existing.address_actual,
        // JSONB: Zod вернул массив (или [] по умолчанию), если поле не
        // передавалось — updateSchema.partial() вернёт undefined, значит берём existing.*
        regions:         JSON.stringify(d.regions      ?? existing.regions),
        industry:        d.industry        ?? existing.industry,
        description:     d.description     ?? existing.description,
        segment:         d.segment         ?? existing.segment,
        cargo_types:     JSON.stringify(d.cargo_types  ?? existing.cargo_types),
        directions:      JSON.stringify(d.directions   ?? existing.directions),
        routes:          JSON.stringify(d.routes       ?? existing.routes),
        shipment_freq:   d.shipment_freq   ?? existing.shipment_freq,
        volume_monthly:  d.volume_monthly  ?? existing.volume_monthly,
        potential:       d.potential       ?? existing.potential,
        current_carrier: d.current_carrier ?? existing.current_carrier,
        switch_reason:   d.switch_reason   ?? existing.switch_reason,
        owner_id:        d.owner_id        ?? existing.owner_id,
        source:          d.source          ?? existing.source,
        priority:        d.priority        ?? existing.priority,
        tags:            JSON.stringify(d.tags         ?? existing.tags),
        next_action_at:  d.next_action_at  !== undefined ? (d.next_action_at  || null) : existing.next_action_at,
        next_action_type:d.next_action_type ?? existing.next_action_type,
        first_contact_at:d.first_contact_at !== undefined ? (d.first_contact_at || null) : existing.first_contact_at,
      })
      .returning('*');

    res.json(updated);
  } catch (err) {
    console.error('[companies/update]', err.message);
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// ── DELETE /api/companies/:id ─────────────────────────────────────────────────

router.delete('/:id', requireRole('admin', 'head'), async (req, res) => {
  try {
    // .del() возвращает число удалённых строк
    const deleted = await knex('companies').where({ id: req.params.id }).del();
    if (!deleted) return res.status(404).json({ error: 'Компания не найдена' });
    res.status(204).end();
  } catch (err) {
    console.error('[companies/delete]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/companies/bulk ──────────────────────────────────────────────────
// Массовые действия: { ids: [], action: 'segment'|'priority'|'owner'|'tag'|'next_action'|'delete', value }
//
// ВАЖНО: этот роут должен быть объявлен ДО export default router.
// В оригинале он шёл ПОСЛЕ export — технически работало (роутер — объект-ссылка),
// но это был скрытый баг. Здесь исправлено.

router.post('/bulk', async (req, res) => {
  try {
    const { ids, action, value } = req.body;

    // Базовые проверки входных данных
    if (!Array.isArray(ids) || !ids.length) {
      return res.status(400).json({ error: 'Укажите компании' });
    }
    if (ids.length > 500) {
      return res.status(400).json({ error: 'Максимум 500 компаний за раз' });
    }

    const { id: userId, role } = req.user;

    // ── RBAC: менеджер может изменять только свои компании ───────────────────
    // Проверяем наличие чужих компаний в выборке — если есть, блокируем целиком
    if (role === 'manager') {
      const foreignRows = await knex('companies')
        .select('id')
        .whereIn('id', ids)
        .where('owner_id', '!=', userId);

      if (foreignRows.length > 0) {
        return res.status(403).json({
          error: `Нет доступа к ${foreignRows.length} компаниям — они принадлежат другим менеджерам`,
        });
      }
    }

    let affected = 0;

    switch (action) {

      // Сменить сегмент воронки
      case 'segment': {
        if (!SEGMENTS.includes(value)) {
          return res.status(400).json({ error: 'Неверный сегмент' });
        }
        affected = await knex('companies')
          .whereIn('id', ids)
          .update({ segment: value });
        break;
      }

      // Сменить приоритет
      case 'priority': {
        if (!PRIORITIES.includes(value)) {
          return res.status(400).json({ error: 'Неверный приоритет' });
        }
        affected = await knex('companies')
          .whereIn('id', ids)
          .update({ priority: value });
        break;
      }

      // Переназначить ответственного — только head/admin
      case 'owner': {
        if (!value) return res.status(400).json({ error: 'Укажите ответственного' });
        if (role === 'manager') {
          return res.status(403).json({ error: 'Переназначение доступно руководителю' });
        }
        affected = await knex('companies')
          .whereIn('id', ids)
          .update({ owner_id: value });
        break;
      }

      // Добавить тег (если его ещё нет в массиве)
      // Используем knex.raw для JSONB-оператора @> (содержит) и || (concat)
      case 'tag': {
        if (!value?.trim()) {
          return res.status(400).json({ error: 'Введите тег' });
        }
        const tag        = value.trim();
        const tagJson    = JSON.stringify([tag]);

        // CASE: если тег уже есть — не дублируем; иначе — добавляем в конец массива
        affected = await knex('companies')
          .whereIn('id', ids)
          .update({
            tags: knex.raw(
              `CASE WHEN tags @> ?::jsonb THEN tags ELSE tags || ?::jsonb END`,
              [tagJson, tagJson]
            ),
          });
        break;
      }

      // Установить дату/тип следующего касания
      case 'next_action': {
        // value = { date: 'YYYY-MM-DD', type: 'call' | 'email' | ... }
        const { date, type } = value || {};
        if (!date) return res.status(400).json({ error: 'Укажите дату' });

        affected = await knex('companies')
          .whereIn('id', ids)
          .update({
            next_action_at:   date,
            next_action_type: type || '',
          });
        break;
      }

      // Массовое удаление — только admin/head
      case 'delete': {
        if (!['admin', 'head'].includes(role)) {
          return res.status(403).json({ error: 'Удаление — только для руководителя' });
        }
        affected = await knex('companies')
          .whereIn('id', ids)
          .del();
        break;
      }

      default:
        return res.status(400).json({ error: `Неизвестное действие: ${action}` });
    }

    // Формат ответа не изменён — фронтенд читает { ok, affected }
    res.json({ ok: true, affected });
  } catch (err) {
    console.error('[companies/bulk]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Экспорт ───────────────────────────────────────────────────────────────────
// Стоит ПОСЛЕ всех роутов — в оригинале был до /bulk (баг, исправлен выше).

export default router;
