/**
 * routes/plans.js
 *
 * GET    /api/plans?year=&month=        — список планов команды (head/admin)
 * GET    /api/plans/my?year=&month=     — мой план + факт
 * POST   /api/plans                     — создать / обновить план (head/admin)
 * POST   /api/plans/copy-month          — скопировать планы с предыдущего месяца
 * DELETE /api/plans/:id                 — удалить (head/admin)
 */

import { Router } from 'express';
import knex       from '../db/knex.js';
import { authenticate, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

// ── Поля плана ────────────────────────────────────────────────────────────────

const PLAN_FIELDS = [
  'target_revenue', 'target_deals_won', 'target_activities',
  'target_calls', 'target_meetings', 'target_proposals', 'target_new_companies',
];

// ── Вычислить факт за период ──────────────────────────────────────────────────

async function getFact(userId, year, month) {
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const to   = new Date(year, month, 0).toISOString().split('T')[0];

  const [deals, activities, companies] = await Promise.all([
    knex('deals')
      .select(
        knex.raw("COUNT(*) FILTER (WHERE outcome = 'won') AS deals_won"),
        knex.raw("COALESCE(SUM(planned_revenue) FILTER (WHERE outcome = 'won'), 0) AS revenue")
      )
      .where({ owner_id: userId })
      .whereRaw("DATE_TRUNC('day', COALESCE(closed_at, updated_at)) BETWEEN ? AND ?", [from, to])
      .first(),

    knex('activities')
      .select(
        knex.raw('COUNT(*) AS total'),
        knex.raw("COUNT(*) FILTER (WHERE type IN ('call_out','call_in')) AS calls"),
        knex.raw("COUNT(*) FILTER (WHERE type = 'meeting') AS meetings"),
        knex.raw("COUNT(*) FILTER (WHERE type = 'proposal') AS proposals")
      )
      .where({ owner_id: userId })
      .whereRaw("DATE_TRUNC('day', occurred_at) BETWEEN ? AND ?", [from, to])
      .first(),

    knex('companies')
      .count('* as cnt')
      .where({ owner_id: userId })
      .whereRaw("DATE_TRUNC('day', created_at) BETWEEN ? AND ?", [from, to])
      .first(),
  ]);

  return {
    revenue:       Number(deals.revenue),
    deals_won:     Number(deals.deals_won),
    activities:    Number(activities.total),
    calls:         Number(activities.calls),
    meetings:      Number(activities.meetings),
    proposals:     Number(activities.proposals),
    new_companies: Number(companies.cnt),
  };
}

// ── GET /api/plans/my ─────────────────────────────────────────────────────────

router.get('/my', async (req, res) => {
  try {
    const now   = new Date();
    const year  = parseInt(req.query.year)  || now.getFullYear();
    const month = parseInt(req.query.month) || now.getMonth() + 1;

    const plan = await knex('plans')
      .where({ user_id: req.user.id, year, month })
      .first();

    const fact = await getFact(req.user.id, year, month);

    const pct = (f, t) => t > 0 ? Math.min(Math.round(f / t * 100), 999) : null;

    res.json({
      year, month, plan: plan || null,
      fact,
      progress: plan ? {
        revenue:       pct(fact.revenue,       plan.target_revenue),
        deals_won:     pct(fact.deals_won,     plan.target_deals_won),
        activities:    pct(fact.activities,    plan.target_activities),
        calls:         pct(fact.calls,         plan.target_calls),
        meetings:      pct(fact.meetings,      plan.target_meetings),
        proposals:     pct(fact.proposals,     plan.target_proposals),
        new_companies: pct(fact.new_companies, plan.target_new_companies),
      } : null,
    });
  } catch (err) {
    console.error('[plans/my]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/plans ────────────────────────────────────────────────────────────

router.get('/', requireRole('admin', 'head'), async (req, res) => {
  try {
    const now   = new Date();
    const year  = parseInt(req.query.year)  || now.getFullYear();
    const month = parseInt(req.query.month) || now.getMonth() + 1;

    const rows = await knex('plans as p')
      .select('p.*', 'u.first_name', 'u.last_name', 'u.email')
      .join('users as u', 'u.id', 'p.user_id')
      .where({ 'p.year': year, 'p.month': month })
      .orderBy('u.first_name')
      .orderBy('u.last_name');

    const result = await Promise.all(rows.map(async p => ({
      ...p,
      name: [p.first_name, p.last_name].filter(Boolean).join(' ') || p.email,
      fact: await getFact(p.user_id, year, month),
    })));

    res.json(result);
  } catch (err) {
    console.error('[plans/list]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/plans ───────────────────────────────────────────────────────────

router.post('/', requireRole('admin', 'head'), async (req, res) => {
  try {
    const {
      user_id, year, month,
      target_revenue = 0, target_deals_won = 0,
      target_activities = 0, target_calls = 0,
      target_meetings = 0, target_proposals = 0,
      target_new_companies = 0, notes = '',
    } = req.body;

    if (!user_id)      return res.status(400).json({ error: 'user_id обязателен' });
    if (!year || !month) return res.status(400).json({ error: 'year и month обязательны' });

    const [plan] = await knex('plans')
      .insert({
        user_id, year, month,
        target_revenue, target_deals_won, target_activities,
        target_calls, target_meetings, target_proposals,
        target_new_companies, notes,
        created_by: req.user.id,
      })
      .onConflict(['user_id', 'year', 'month'])
      .merge({
        target_revenue, target_deals_won, target_activities,
        target_calls, target_meetings, target_proposals,
        target_new_companies, notes,
        updated_at: knex.fn.now(),
      })
      .returning('*');

    res.status(201).json(plan);
  } catch (err) {
    console.error('[plans/create]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/plans/copy-month ────────────────────────────────────────────────
//
// Копирует планы всех пользователей из одного месяца в другой.
// Если в целевом месяце план уже есть — перезаписывает (upsert).
//
// Тело запроса:
//   from_year, from_month  — источник (откуда копируем)
//   to_year, to_month      — цель (куда копируем)
//
// Пример: копировать апрель 2026 → май 2026
//   { from_year: 2026, from_month: 4, to_year: 2026, to_month: 5 }

router.post('/copy-month', requireRole('admin', 'head'), async (req, res) => {
  try {
    const { from_year, from_month, to_year, to_month } = req.body;

    if (!from_year || !from_month || !to_year || !to_month) {
      return res.status(400).json({ error: 'from_year, from_month, to_year, to_month обязательны' });
    }
    if (from_year === to_year && from_month === to_month) {
      return res.status(400).json({ error: 'Источник и цель совпадают' });
    }

    // Загружаем планы из исходного месяца
    const sourcePlans = await knex('plans')
      .where({ year: from_year, month: from_month });

    if (!sourcePlans.length) {
      return res.status(404).json({
        error: `В ${from_month}/${from_year} планов нет — нечего копировать`,
      });
    }

    // Upsert каждого плана в целевой месяц
    const copied = await knex.transaction(async trx => {
      const results = [];
      for (const src of sourcePlans) {
        const [plan] = await trx('plans')
          .insert({
            user_id:              src.user_id,
            year:                 to_year,
            month:                to_month,
            target_revenue:       src.target_revenue,
            target_deals_won:     src.target_deals_won,
            target_activities:    src.target_activities,
            target_calls:         src.target_calls,
            target_meetings:      src.target_meetings,
            target_proposals:     src.target_proposals,
            target_new_companies: src.target_new_companies,
            notes:                src.notes,
            created_by:           req.user.id,
          })
          .onConflict(['user_id', 'year', 'month'])
          .merge({
            target_revenue:       src.target_revenue,
            target_deals_won:     src.target_deals_won,
            target_activities:    src.target_activities,
            target_calls:         src.target_calls,
            target_meetings:      src.target_meetings,
            target_proposals:     src.target_proposals,
            target_new_companies: src.target_new_companies,
            notes:                src.notes,
            updated_at:           knex.fn.now(),
          })
          .returning('*');
        results.push(plan);
      }
      return results;
    });

    res.json({
      ok: true,
      copied: copied.length,
      message: `Скопировано ${copied.length} планов из ${from_month}/${from_year} в ${to_month}/${to_year}`,
    });
  } catch (err) {
    console.error('[plans/copy-month]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/plans/:id ─────────────────────────────────────────────────────

router.delete('/:id', requireRole('admin', 'head'), async (req, res) => {
  try {
    const deleted = await knex('plans').where({ id: req.params.id }).del();
    if (!deleted) return res.status(404).json({ error: 'План не найден' });
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
