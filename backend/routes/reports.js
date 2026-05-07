/**
 * routes/reports.js — Аналитика и отчёты
 *
 * GET /api/reports/summary?from=&to=&owner_id=
 * GET /api/reports/funnel?from=&to=&owner_id=
 * GET /api/reports/team?from=&to=
 * GET /api/reports/activity?from=&to=&owner_id=
 * GET /api/reports/loss-reasons?from=&to=&owner_id=
 * GET /api/reports/timeline?from=&to=&owner_id=&group=day|week
 *
 * Изменения относительно оригинала:
 *   • Все SQL-запросы переведены на Knex (db/knex.js)
 *   • Zod-валидация query-параметров через validateQuery()
 *   • ownerFilter (мутабельные массивы) → ownerScope (функция для .modify())
 *   • pool.query возвращала { rows }, Knex возвращает массив — убраны все .rows
 *   • Вся математика (SUM/COUNT/AVG/FILTER, DATE_TRUNC) — через knex.raw() без изменений
 *   • Формат JSON-ответов и имена ключей не изменены
 */

import { Router } from 'express';
import { z }      from 'zod';
import knex       from '../db/knex.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

// ── Zod-схемы для query-параметров ────────────────────────────────────────────

/**
 * Общая дата-схема: принимает строку 'YYYY-MM-DD' или отсутствие поля.
 * Используется для from/to, чтобы не передавать мусор в new Date().
 */
const DateParam = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Формат даты: YYYY-MM-DD')
  .optional();

/**
 * DateRangeSchema — общая схема для большинства отчётов.
 * owner_id используется head/admin для фильтрации по конкретному менеджеру.
 */
const DateRangeSchema = z.object({
  from:     DateParam,
  to:       DateParam,
  owner_id: z.string().uuid('owner_id должен быть UUID').optional(),
});

/**
 * TimelineSchema — добавляет group к стандартному диапазону.
 * Валидация group защищает от SQL-интерполяции trunc-значения.
 */
const TimelineSchema = DateRangeSchema.extend({
  group: z.enum(['day', 'week']).optional().default('day'),
});

// ── validateQuery — аналог validate() но для req.query ────────────────────────

/**
 * Middleware-фабрика: валидирует req.query через Zod-схему.
 * При успехе заменяет req.query провалидированными данными
 * (Zod делает strip неизвестных полей и применяет .default()).
 * При ошибке — 400 с массивом проблем.
 */
function validateQuery(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      const errors = result.error.errors.map(e => ({
        field:   e.path.join('.') || 'query',
        message: e.message,
      }));
      return res.status(400).json({ error: 'Некорректные параметры запроса', errors });
    }
    // Заменяем req.query — getPeriod и ownerScope читают его ниже
    req.query = result.data;
    next();
  };
}

// ── Утилиты ───────────────────────────────────────────────────────────────────

/**
 * getPeriod — вычисляет границы периода из query-параметров.
 * Логика полностью совпадает с оригиналом:
 *   • to:   конец дня переданной даты или текущий момент
 *   • from: начало дня переданной даты или первый день текущего месяца
 * Возвращает ISO-строки для использования в BETWEEN.
 */
function getPeriod(req) {
  const { from, to } = req.query;
  const now     = new Date();
  const toDate  = to   ? new Date(to   + 'T23:59:59Z') : now;
  const fromDate = from ? new Date(from + 'T00:00:00Z')
                        : new Date(now.getFullYear(), now.getMonth(), 1);
  return { from: fromDate.toISOString(), to: toDate.toISOString() };
}

/**
 * ownerScope — заменяет оригинальный ownerFilter(req, params, conds).
 *
 * Оригинал мутировал params[] и conds[] для ручной сборки SQL.
 * Новая версия возвращает функцию, совместимую с Knex .modify():
 *
 *   qb.modify(ownerScope(req))         — без алиаса: owner_id
 *   qb.modify(ownerScope(req, 'd'))    — с алиасом: d.owner_id
 *
 * RBAC-логика не изменена:
 *   manager → всегда только свои записи
 *   head/admin + owner_id → только записи конкретного менеджера
 *   head/admin без owner_id → все записи (фильтр не применяется)
 */
function ownerScope(req, alias = '') {
  return function (qb) {
    const { id: userId, role } = req.user;
    const { owner_id } = req.query;
    const col = alias ? `${alias}.owner_id` : 'owner_id';

    if (role === 'manager') {
      qb.where(col, userId);
    } else if (owner_id) {
      qb.where(col, owner_id);
    }
  };
}

// ── GET /api/reports/summary ──────────────────────────────────────────────────

router.get('/summary', validateQuery(DateRangeSchema), async (req, res) => {
  try {
    const { from, to } = getPeriod(req);

    // 4 параллельных запроса — точно как в оригинале.
    //
    // КЛЮЧЕВОЕ ИЗМЕНЕНИЕ: pool.query возвращала { rows: [{...}] },
    // Knex возвращает массив [{...}].
    // Используем .first() → получаем единственный объект-агрегат напрямую.
    //
    // Все FILTER-агрегации — PostgreSQL-специфичный синтаксис, не поддерживается
    // Knex нативно. Используем knex.raw() для каждой агрегатной функции.
    const [companies, deals, activities, requests] = await Promise.all([

      // ── Новые компании за период ────────────────────────────────────────────
      knex('companies')
        .select(knex.raw('COUNT(*) AS cnt'))
        .whereBetween('created_at', [from, to])
        .modify(ownerScope(req))
        .first(),

      // ── Сделки за период ────────────────────────────────────────────────────
      // FILTER (WHERE outcome = ...) — считает строки удовлетворяющие условию
      // внутри одного прохода по таблице, без подзапросов.
      // COALESCE(..., 0) — защита от NULL при пустой выборке.
      // EXTRACT(EPOCH FROM ...) / 86400 — продолжительность сделки в днях:
      //   EPOCH даёт секунды с эпохи, делим на 86400 (секунд в сутках).
      knex('deals')
        .select(
          knex.raw("COUNT(*) FILTER (WHERE outcome = 'in_progress')                AS active"),
          knex.raw("COUNT(*) FILTER (WHERE outcome = 'won')                        AS won"),
          knex.raw("COUNT(*) FILTER (WHERE outcome = 'lost')                       AS lost"),
          knex.raw("COALESCE(SUM(planned_revenue)         FILTER (WHERE outcome = 'won'), 0) AS revenue"),
          knex.raw("COALESCE(AVG(planned_margin_percent)  FILTER (WHERE outcome = 'won'), 0) AS avg_margin"),
          knex.raw(`COALESCE(
                      AVG(EXTRACT(EPOCH FROM (closed_at - created_at)) / 86400)
                      FILTER (WHERE outcome = 'won' AND closed_at IS NOT NULL),
                    0) AS avg_days`)
        )
        .whereBetween('created_at', [from, to])
        .modify(ownerScope(req))
        .first(),

      // ── Активности за период ─────────────────────────────────────────────────
      knex('activities')
        .select(
          knex.raw('COUNT(*) AS total'),
          knex.raw("COUNT(*) FILTER (WHERE type IN ('call_out','call_in'))   AS calls"),
          knex.raw("COUNT(*) FILTER (WHERE type IN ('email_out','email_in')) AS emails"),
          knex.raw("COUNT(*) FILTER (WHERE type = 'meeting')                AS meetings"),
          knex.raw("COUNT(*) FILTER (WHERE type = 'proposal')               AS proposals")
        )
        .whereBetween('created_at', [from, to])
        .modify(ownerScope(req))
        .first(),

      // ── Запросы на перевозку за период ──────────────────────────────────────
      // our_rate — наша ставка (выручка при выигрыше).
      // margin_percent — процент маржи, усредняем по выигранным запросам.
      knex('requests')
        .select(
          knex.raw('COUNT(*) AS total'),
          knex.raw("COUNT(*) FILTER (WHERE status = 'won')                           AS won"),
          knex.raw("COALESCE(SUM(our_rate)       FILTER (WHERE status = 'won'), 0)   AS revenue"),
          knex.raw("COALESCE(AVG(margin_percent) FILTER (WHERE status = 'won'), 0)   AS avg_margin")
        )
        .whereBetween('created_at', [from, to])
        .modify(ownerScope(req))
        .first(),
    ]);

    // ── JS-математика: конверсия сделок ─────────────────────────────────────────
    // pg возвращает COUNT значения как строки — Number() приводит их к числу.
    // Конверсия = won / (won + lost) * 100, округлённая до целых.
    // В знаменателе только won и lost (не in_progress) — как в оригинале.
    const d         = deals;
    const wonCount  = Number(d.won);
    const lostCount = Number(d.lost);
    const conversion = wonCount + lostCount > 0
      ? Math.round(wonCount / (wonCount + lostCount) * 100)
      : 0;

    res.json({
      period: { from, to },
      companies:  Number(companies.cnt),
      deals: {
        active:     Number(d.active),
        won:        wonCount,
        lost:       lostCount,
        revenue:    Number(d.revenue),
        avg_margin: Math.round(Number(d.avg_margin) * 10) / 10,
        avg_days:   Math.round(Number(d.avg_days)),
        conversion,
      },
      activities: {
        total:    Number(activities.total),
        calls:    Number(activities.calls),
        emails:   Number(activities.emails),
        meetings: Number(activities.meetings),
        proposals:Number(activities.proposals),
      },
      requests: {
        total:     Number(requests.total),
        won:       Number(requests.won),
        revenue:   Number(requests.revenue),
        avg_margin:Math.round(Number(requests.avg_margin) * 10) / 10,
      },
    });
  } catch (err) {
    console.error('[reports/summary]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/reports/funnel ───────────────────────────────────────────────────

router.get('/funnel', validateQuery(DateRangeSchema), async (req, res) => {
  try {
    const { from, to } = getPeriod(req);

    // Только активные сделки (outcome = 'in_progress') — воронка текущего периода.
    // GROUP BY stage — считаем количество и сумму pipeline по каждой стадии.
    const rows = await knex('deals')
      .select(
        'stage',
        knex.raw('COUNT(*) AS cnt'),
        knex.raw('COALESCE(SUM(planned_revenue), 0) AS pipeline')
      )
      .whereBetween('created_at', [from, to])
      .where({ outcome: 'in_progress' })
      .modify(ownerScope(req))
      .groupBy('stage');

    // Стадии воронки — порядок важен для фронтенда (отрисовка Kanban/фunneling)
    const STAGES = [
      'new_lead', 'qualification', 'dm_found', 'request_received',
      'pricing', 'proposal_sent', 'negotiation', 'contract',
      'first_shipment', 'repeat_sales',
    ];
    const LABELS = {
      new_lead:         'Новый лид',
      qualification:    'Квалификация',
      dm_found:         'ЛПР найден',
      request_received: 'Запрос получен',
      pricing:          'Расчёт',
      proposal_sent:    'КП отправлено',
      negotiation:      'Переговоры',
      contract:         'Договор',
      first_shipment:   'Первая отгрузка',
      repeat_sales:     'Повторные продажи',
    };

    // Индексируем результат по stage для быстрого поиска
    const byStage = Object.fromEntries(rows.map(r => [r.stage, r]));

    // Возвращаем все стадии в фиксированном порядке — стадии без сделок = 0
    res.json(STAGES.map(s => ({
      stage:    s,
      label:    LABELS[s],
      count:    Number(byStage[s]?.cnt      ?? 0),
      pipeline: Number(byStage[s]?.pipeline ?? 0),
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/reports/team ─────────────────────────────────────────────────────

router.get('/team', validateQuery(DateRangeSchema), async (req, res) => {
  try {
    // Командный отчёт только для руководителей
    if (!['admin', 'head'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Недостаточно прав' });
    }
    const { from, to } = getPeriod(req);

    // ── Ключевая особенность: дата МЕЖДУ в условии JOIN, не в WHERE ──────────
    //
    // LEFT JOIN ... ON owner_id = u.id AND created_at BETWEEN $1 AND $2
    //
    // Это принципиально отличается от WHERE created_at BETWEEN ...:
    //   • JOIN-условие: пользователи БЕЗ активности за период всё равно
    //     попадают в результат (строка пользователя + NULL по джойненным столбцам)
    //   • WHERE-условие: пользователи без активности за период ИСЧЕЗЛИ БЫ
    //
    // Используем knex.raw() для LEFT JOIN с составным ON-условием,
    // т.к. Knex не умеет нативно добавлять значения (BETWEEN с params) в ON.
    // Знак ? — позиционный плейсхолдер Knex (pg bindParam).
    //
    // FILTER-агрегации: COUNT(DISTINCT ...) FILTER (WHERE ...) считает
    // уникальные id только удовлетворяющих условию строк — без GROUP BY подзапросов.
    const rows = await knex('users as u')
      .select(
        'u.id',
        'u.first_name',
        'u.last_name',
        'u.email',
        knex.raw('COUNT(DISTINCT c.id)                                              AS companies'),
        knex.raw('COUNT(DISTINCT d.id)                                              AS deals_total'),
        knex.raw("COUNT(DISTINCT d.id)  FILTER (WHERE d.outcome = 'won')            AS deals_won"),
        knex.raw("COALESCE(SUM(d.planned_revenue)        FILTER (WHERE d.outcome = 'won'), 0) AS revenue"),
        knex.raw('COUNT(DISTINCT a.id)                                              AS activities'),
        knex.raw("COUNT(DISTINCT a.id)  FILTER (WHERE a.type IN ('call_out','call_in')) AS calls"),
        knex.raw("COUNT(DISTINCT a.id)  FILTER (WHERE a.type = 'meeting')           AS meetings"),
        knex.raw("COALESCE(AVG(d.planned_margin_percent) FILTER (WHERE d.outcome = 'won'), 0) AS avg_margin")
      )
      .leftJoin(
        knex.raw('companies c ON c.owner_id = u.id AND c.created_at BETWEEN ? AND ?', [from, to])
      )
      .leftJoin(
        knex.raw('deals d ON d.owner_id = u.id AND d.created_at BETWEEN ? AND ?', [from, to])
      )
      .leftJoin(
        knex.raw('activities a ON a.owner_id = u.id AND a.created_at BETWEEN ? AND ?', [from, to])
      )
      .where('u.is_active', true)
      .groupBy('u.id', 'u.first_name', 'u.last_name', 'u.email')
      // ORDER BY по alias-колонкам — PostgreSQL поддерживает это через orderByRaw
      .orderByRaw('revenue DESC, deals_won DESC');

    res.json(rows.map(r => ({
      id:          r.id,
      // Имя: "Имя Фамилия" или email если имя не заполнено
      name:        [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email,
      companies:   Number(r.companies),
      deals_total: Number(r.deals_total),
      deals_won:   Number(r.deals_won),
      revenue:     Number(r.revenue),
      activities:  Number(r.activities),
      calls:       Number(r.calls),
      meetings:    Number(r.meetings),
      avg_margin:  Math.round(Number(r.avg_margin) * 10) / 10,
      // Конверсия по сделкам менеджера: deals_won / deals_total * 100
      // Знаменатель — deals_total (все сделки), не (won + lost) как в summary.
      // Это поведение оригинала — не менять!
      conversion:  r.deals_total > 0
        ? Math.round(r.deals_won / r.deals_total * 100)
        : 0,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/reports/activity ─────────────────────────────────────────────────

router.get('/activity', validateQuery(DateRangeSchema), async (req, res) => {
  try {
    const { from, to } = getPeriod(req);

    // Оригинал фильтрует по occurred_at (не created_at) — дата совершения,
    // не дата записи в БД. Сохраняем точно.
    const rows = await knex('activities')
      .select(
        'type',
        knex.raw('COUNT(*) AS cnt')
      )
      .whereBetween('occurred_at', [from, to])
      .modify(ownerScope(req))
      .groupBy('type')
      .orderByRaw('cnt DESC');

    res.json(rows.map(r => ({
      type:  r.type,
      count: Number(r.cnt),
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/reports/loss-reasons ────────────────────────────────────────────

router.get('/loss-reasons', validateQuery(DateRangeSchema), async (req, res) => {
  try {
    const { from, to } = getPeriod(req);

    // Только проигранные сделки с заполненной причиной проигрыша.
    // .whereNot({ loss_reason: '' }) → WHERE loss_reason != '' (как в оригинале)
    const rows = await knex('deals')
      .select(
        'loss_reason',
        knex.raw('COUNT(*) AS cnt')
      )
      .whereBetween('created_at', [from, to])
      .where({ outcome: 'lost' })
      .whereNot({ loss_reason: '' })
      .modify(ownerScope(req))
      .groupBy('loss_reason')
      .orderByRaw('cnt DESC');

    const LABELS = {
      price:     'Цена',
      timing:    'Сроки',
      service:   'Сервис',
      no_need:   'Нет потребности',
      carrier:   'Другой перевозчик',
      no_lpr:    'Не вышли на ЛПР',
      other_loss:'Другое',
    };

    res.json(rows.map(r => ({
      reason: r.loss_reason,
      label:  LABELS[r.loss_reason] || r.loss_reason,
      count:  Number(r.cnt),
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/reports/timeline ─────────────────────────────────────────────────

router.get('/timeline', validateQuery(TimelineSchema), async (req, res) => {
  try {
    const { from, to }   = getPeriod(req);
    // group прошёл Zod-валидацию (enum: 'day'|'week') — безопасно интерполировать
    const { group = 'day' } = req.query;
    const trunc = group === 'week' ? 'week' : 'day';

    // DATE_TRUNC('day'/'week', occurred_at)::date — усекаем до начала дня/недели
    // и приводим к DATE (убираем временную зону) для удобства фронтенда.
    //
    // GROUP BY period — PostgreSQL позволяет группировать по alias из SELECT.
    // ORDER BY period — хронологический порядок.
    const rows = await knex('activities')
      .select(
        // Интерполяция trunc безопасна: Zod гарантирует 'day' | 'week'
        knex.raw(`DATE_TRUNC('${trunc}', occurred_at)::date AS period`),
        knex.raw('COUNT(*) AS total'),
        knex.raw("COUNT(*) FILTER (WHERE type IN ('call_out','call_in'))   AS calls"),
        knex.raw("COUNT(*) FILTER (WHERE type IN ('email_out','email_in')) AS emails"),
        knex.raw("COUNT(*) FILTER (WHERE type = 'meeting')                AS meetings")
      )
      .whereBetween('occurred_at', [from, to])
      .modify(ownerScope(req))
      // GROUP BY выражение (не alias) — надёжнее в разных движках SQL
      .groupByRaw(`DATE_TRUNC('${trunc}', occurred_at)::date`)
      .orderByRaw('period');

    res.json(rows.map(r => ({
      period:   r.period,
      total:    Number(r.total),
      calls:    Number(r.calls),
      emails:   Number(r.emails),
      meetings: Number(r.meetings),
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
