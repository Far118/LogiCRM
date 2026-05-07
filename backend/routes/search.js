/**
 * routes/search.js
 *
 * GET /api/search?q=текст&limit=20
 *
 * Ищет по:
 *   - companies (name, inn, industry, description)
 *   - contacts  (first_name, last_name, phone, email, position)
 *   - deals     (title, description)
 *   - requests  (route_from, route_to, cargo_description)
 *
 * RBAC: manager видит только свои записи.
 */

import { Router } from 'express';
import { query } from '../db/pool.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const { q = '', limit = 20 } = req.query;
    const term = q.trim();

    if (term.length < 2) return res.json([]);

    const { id: userId, role } = req.user;
    const isManager = role === 'manager';
    const lim = Math.min(parseInt(limit) || 20, 50);
    const pattern = `%${term.toLowerCase()}%`;

    const ownerWhere = isManager ? `AND owner_id = '${userId}'` : '';

    const [companies, contacts, deals, requests] = await Promise.all([

      // ── Компании ────────────────────────────────────────────────────────────
      query(`
        SELECT
          'company' AS type,
          id, name AS title,
          inn AS subtitle,
          segment AS meta,
          '/company.html?id=' || id AS url
        FROM companies
        WHERE (
          LOWER(name) LIKE $1 OR
          inn LIKE $2 OR
          LOWER(industry) LIKE $1 OR
          LOWER(description) LIKE $1
        ) ${ownerWhere}
        ORDER BY
          CASE WHEN LOWER(name) LIKE $2 THEN 0
               WHEN LOWER(name) LIKE $1 THEN 1
               ELSE 2 END,
          updated_at DESC
        LIMIT $3`,
        [pattern, `${term.toLowerCase()}%`, Math.ceil(lim * 0.5)]
      ),

      // ── Контакты ────────────────────────────────────────────────────────────
      query(`
        SELECT
          'contact' AS type,
          ct.id,
          ct.first_name || ' ' || ct.last_name AS title,
          ct.position AS subtitle,
          co.name AS meta,
          '/company.html?id=' || ct.company_id || '&tab=contacts' AS url
        FROM contacts ct
        LEFT JOIN companies co ON co.id = ct.company_id
        WHERE (
          LOWER(ct.first_name || ' ' || ct.last_name) LIKE $1 OR
          ct.phone_main LIKE $2 OR
          ct.phone_alt  LIKE $2 OR
          LOWER(ct.email) LIKE $1 OR
          LOWER(ct.position) LIKE $1
        ) ${isManager ? "AND co.owner_id = '" + userId + "'" : ''}
        ORDER BY ct.first_name
        LIMIT $3`,
        [pattern, `%${term}%`, Math.ceil(lim * 0.3)]
      ),

      // ── Сделки ──────────────────────────────────────────────────────────────
      query(`
        SELECT
          'deal' AS type,
          d.id,
          d.title,
          d.stage AS subtitle,
          co.name AS meta,
          '/deals.html?id=' || d.id AS url
        FROM deals d
        LEFT JOIN companies co ON co.id = d.company_id
        WHERE (
          LOWER(d.title) LIKE $1 OR
          LOWER(d.description) LIKE $1
        ) ${ownerWhere.replace('owner_id', 'd.owner_id')}
        ORDER BY d.updated_at DESC
        LIMIT $2`,
        [pattern, Math.ceil(lim * 0.3)]
      ),

      // ── Запросы на перевозку ─────────────────────────────────────────────────
      query(`
        SELECT
          'request' AS type,
          r.id,
          r.route_from || ' → ' || r.route_to AS title,
          r.cargo_description AS subtitle,
          co.name AS meta,
          '/requests.html?id=' || r.id AS url
        FROM requests r
        LEFT JOIN companies co ON co.id = r.company_id
        WHERE (
          LOWER(r.route_from) LIKE $1 OR
          LOWER(r.route_to) LIKE $1 OR
          LOWER(r.cargo_description) LIKE $1
        ) ${ownerWhere.replace('owner_id', 'r.owner_id')}
        ORDER BY r.created_at DESC
        LIMIT $2`,
        [pattern, Math.ceil(lim * 0.2)]
      ),
    ]);

    // Объединяем и маркируем тип
    const TYPE_LABELS = {
      company: 'Компания',
      contact: 'Контакт',
      deal:    'Сделка',
      request: 'Запрос',
    };
    const TYPE_ORDER = { company: 0, contact: 1, deal: 2, request: 3 };

    const results = [
      ...companies.rows,
      ...contacts.rows,
      ...deals.rows,
      ...requests.rows,
    ]
      .map(r => ({
        ...r,
        type_label: TYPE_LABELS[r.type] || r.type,
        title:    (r.title || '').trim(),
        subtitle: (r.subtitle || '').trim(),
        meta:     (r.meta || '').trim(),
      }))
      .filter(r => r.title)
      .sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type]);

    res.json(results);
  } catch (err) {
    console.error('[search]', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
