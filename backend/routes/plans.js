/**
 * routes/plans.js
 *
 * GET  /api/plans?year=&month=&user_id=   — список планов (head/admin видят всех)
 * GET  /api/plans/my?year=&month=          — мой план + факт (любой авторизованный)
 * POST /api/plans                          — создать / обновить план (head/admin)
 * DELETE /api/plans/:id                   — удалить (head/admin)
 */

import { Router } from 'express';
import { query } from '../db/pool.js';
import { authenticate, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

// ── Вычислить факт за период ───────────────────────────────────────────────

async function getFact(userId, year, month) {
  const from = `${year}-${String(month).padStart(2,'0')}-01`;
  const to   = new Date(year, month, 0).toISOString().split('T')[0]; // последний день месяца

  const [deals, activities, companies] = await Promise.all([
    query(`
      SELECT
        COUNT(*) FILTER (WHERE outcome = 'won') AS deals_won,
        COALESCE(SUM(planned_revenue) FILTER (WHERE outcome = 'won'), 0) AS revenue
      FROM deals
      WHERE owner_id = $1
        AND DATE_TRUNC('day', COALESCE(closed_at, updated_at)) BETWEEN $2 AND $3`,
      [userId, from, to]
    ),
    query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE type IN ('call_out','call_in')) AS calls,
        COUNT(*) FILTER (WHERE type = 'meeting')              AS meetings,
        COUNT(*) FILTER (WHERE type = 'proposal')             AS proposals
      FROM activities
      WHERE owner_id = $1
        AND DATE_TRUNC('day', occurred_at) BETWEEN $2 AND $3`,
      [userId, from, to]
    ),
    query(`
      SELECT COUNT(*) AS cnt FROM companies
      WHERE owner_id = $1
        AND DATE_TRUNC('day', created_at) BETWEEN $2 AND $3`,
      [userId, from, to]
    ),
  ]);

  const d = deals.rows[0];
  const a = activities.rows[0];
  const c = companies.rows[0];

  return {
    revenue:       Number(d.revenue),
    deals_won:     Number(d.deals_won),
    activities:    Number(a.total),
    calls:         Number(a.calls),
    meetings:      Number(a.meetings),
    proposals:     Number(a.proposals),
    new_companies: Number(c.cnt),
  };
}

// ── GET /api/plans/my ─────────────────────────────────────────────────────────

router.get('/my', async (req, res) => {
  try {
    const now   = new Date();
    const year  = parseInt(req.query.year)  || now.getFullYear();
    const month = parseInt(req.query.month) || now.getMonth() + 1;

    const { rows } = await query(
      'SELECT * FROM plans WHERE user_id=$1 AND year=$2 AND month=$3',
      [req.user.id, year, month]
    );

    const plan = rows[0] || null;
    const fact = await getFact(req.user.id, year, month);

    // Прогресс в процентах
    const pct = (fact, target) =>
      target > 0 ? Math.min(Math.round(fact / target * 100), 999) : null;

    res.json({
      year, month, plan,
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

router.get('/', requireRole('admin','head'), async (req, res) => {
  try {
    const now   = new Date();
    const year  = parseInt(req.query.year)  || now.getFullYear();
    const month = parseInt(req.query.month) || now.getMonth() + 1;

    const { rows } = await query(`
      SELECT p.*,
        u.first_name, u.last_name, u.email
      FROM plans p
      JOIN users u ON u.id = p.user_id
      WHERE p.year=$1 AND p.month=$2
      ORDER BY u.first_name, u.last_name`,
      [year, month]
    );

    // Добавляем факт к каждому
    const result = await Promise.all(rows.map(async (p) => {
      const fact = await getFact(p.user_id, year, month);
      return {
        ...p,
        name: [p.first_name, p.last_name].filter(Boolean).join(' ') || p.email,
        fact,
      };
    }));

    res.json(result);
  } catch (err) {
    console.error('[plans/list]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/plans ───────────────────────────────────────────────────────────

router.post('/', requireRole('admin','head'), async (req, res) => {
  try {
    const {
      user_id, year, month,
      target_revenue = 0, target_deals_won = 0,
      target_activities = 0, target_calls = 0,
      target_meetings = 0, target_proposals = 0,
      target_new_companies = 0, notes = '',
    } = req.body;

    if (!user_id) return res.status(400).json({ error: 'user_id обязателен' });
    if (!year || !month) return res.status(400).json({ error: 'year и month обязательны' });

    const { rows } = await query(`
      INSERT INTO plans (
        user_id, year, month,
        target_revenue, target_deals_won, target_activities,
        target_calls, target_meetings, target_proposals,
        target_new_companies, notes, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (user_id, year, month) DO UPDATE SET
        target_revenue = EXCLUDED.target_revenue,
        target_deals_won = EXCLUDED.target_deals_won,
        target_activities = EXCLUDED.target_activities,
        target_calls = EXCLUDED.target_calls,
        target_meetings = EXCLUDED.target_meetings,
        target_proposals = EXCLUDED.target_proposals,
        target_new_companies = EXCLUDED.target_new_companies,
        notes = EXCLUDED.notes,
        updated_at = now()
      RETURNING *`,
      [
        user_id, year, month,
        target_revenue, target_deals_won, target_activities,
        target_calls, target_meetings, target_proposals,
        target_new_companies, notes, req.user.id,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[plans/create]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/plans/:id ─────────────────────────────────────────────────────

router.delete('/:id', requireRole('admin','head'), async (req, res) => {
  try {
    const { rowCount } = await query('DELETE FROM plans WHERE id=$1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'План не найден' });
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
