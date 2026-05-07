/**
 * routes/deals.js
 *
 * GET    /api/deals?company_id=&owner_id=&stage=&outcome=
 * GET    /api/deals/:id
 * POST   /api/deals
 * PUT    /api/deals/:id
 * PATCH  /api/deals/:id/stage    — сменить стадию (пишет stage_history)
 * PATCH  /api/deals/:id/close    — закрыть (won/lost/postponed)
 * PATCH  /api/deals/:id/reopen   — возобновить
 * DELETE /api/deals/:id          — admin/head
 *
 * Изменения относительно оригинала:
 *   • Все SQL-запросы переведены на Knex (db/knex.js)
 *   • POST и PUT защищены Zod-валидацией (middleware/validate.js)
 *   • Вся бизнес-логика (stage_history, canModify, logActivity,
 *     STAGE_PROBABILITY, LOSS_REASONS) сохранена без изменений
 */

import { Router } from 'express';
import { z }      from 'zod';
import knex       from '../db/knex.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validate }                  from '../middleware/validate.js';

const router = Router();
router.use(authenticate);

// ── Справочники (неизменны) ───────────────────────────────────────────────────

const STAGES = [
  'new_lead', 'qualification', 'dm_found', 'request_received',
  'pricing', 'proposal_sent', 'negotiation', 'contract',
  'first_shipment', 'repeat_sales',
];
const STAGE_LABELS = {
  new_lead: 'Новый лид', qualification: 'Квалификация', dm_found: 'Выявлен ЛПР',
  request_received: 'Получен запрос', pricing: 'Расчёт / ставка',
  proposal_sent: 'КП отправлено', negotiation: 'Согласование',
  contract: 'Договор', first_shipment: 'Первая отгрузка', repeat_sales: 'Повторные продажи',
};
const STAGE_PROBABILITY = {
  new_lead: 5, qualification: 10, dm_found: 20, request_received: 30,
  pricing: 40, proposal_sent: 55, negotiation: 70, contract: 85,
  first_shipment: 95, repeat_sales: 100,
};
const LOSS_REASONS = ['price', 'timing', 'service', 'no_need', 'carrier', 'no_lpr', 'other_loss'];

// ── Zod-схемы ─────────────────────────────────────────────────────────────────

const CreateDealSchema = z.object({
  company_id:             z.string().uuid({ message: 'company_id должен быть UUID' }),
  title:                  z.string().min(1, 'Название обязательно').max(255).transform(s => s.trim()),
  description:            z.string().max(2000).optional().default('').transform(s => s.trim()),
  service:                z.string().max(100).optional().default('transport'),
  stage:                  z.enum(STAGES).optional().default('new_lead'),
  probability:            z.number().int().min(0).max(100).optional(),
  planned_revenue:        z.number().min(0).optional().default(0),
  planned_margin:         z.number().optional().default(0),
  planned_margin_percent: z.number().optional().default(0),
  currency:               z.enum(['RUB', 'USD', 'EUR']).optional().default('RUB'),
  planned_close_at:       z.string().nullable().optional().default(null),
  source:                 z.string().max(200).optional().default(''),
  owner_id:               z.string().uuid().optional(),
});

// PUT — то же самое, но company_id нельзя менять
const UpdateDealSchema = CreateDealSchema.omit({ company_id: true }).partial().extend({
  title: z.string().min(1, 'Название обязательно').max(255).transform(s => s.trim()),
});

const StageSchema = z.object({
  stage: z.enum(STAGES, { errorMap: () => ({ message: 'Неизвестная стадия' }) }),
});

const CloseSchema = z.object({
  outcome:     z.enum(['won', 'lost', 'postponed'], { errorMap: () => ({ message: 'Некорректный итог' }) }),
  loss_reason: z.string().optional().default(''),
}).superRefine((val, ctx) => {
  if (val.outcome === 'lost' && !LOSS_REASONS.includes(val.loss_reason)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['loss_reason'], message: 'Укажите причину проигрыша' });
  }
});

// ── Вспомогательные функции (неизменны) ──────────────────────────────────────

function canModify(deal, user) {
  if (['admin', 'head'].includes(user.role)) return true;
  return user.role === 'manager' && deal.owner_id === user.id;
}

// Запись системной активности через Knex-транзакцию
async function logActivity(trx, { deal_id, company_id, message, userId }) {
  try {
    await trx('activities').insert({
      company_id,
      deal_id,
      type:        'note',
      description: message,
      owner_id:    userId,
    });
  } catch { /* не ломаем основной flow */ }
}

// ── GET /api/deals ────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const { id: userId, role } = req.user;
    const { company_id, owner_id, stage, outcome, service } = req.query;

    const q = knex('deals').orderBy('updated_at', 'desc');

    if (company_id) q.where({ company_id });
    if (stage)      q.where({ stage });
    if (outcome)    q.where({ outcome });
    if (service)    q.where({ service });

    if (role === 'manager') {
      q.where({ owner_id: userId });
    } else if (owner_id) {
      q.where({ owner_id });
    }

    const rows = await q;
    res.json(rows);
  } catch (err) {
    console.error('[deals/list]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/deals/:id ────────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  try {
    const deal = await knex('deals').where({ id: req.params.id }).first();
    if (!deal) return res.status(404).json({ error: 'Сделка не найдена' });
    if (!canModify(deal, req.user)) return res.status(403).json({ error: 'Нет доступа' });
    res.json(deal);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/deals ───────────────────────────────────────────────────────────

router.post('/', validate(CreateDealSchema), async (req, res) => {
  try {
    const d     = req.body;
    const stage = d.stage;
    const prob  = d.probability !== undefined ? d.probability : STAGE_PROBABILITY[stage];

    const result = await knex.transaction(async (trx) => {
      const [deal] = await trx('deals')
        .insert({
          company_id:             d.company_id,
          title:                  d.title,
          description:            d.description,
          service:                d.service,
          stage,
          outcome:                'in_progress',
          probability:            prob,
          planned_revenue:        d.planned_revenue,
          planned_margin:         d.planned_margin,
          planned_margin_percent: d.planned_margin_percent,
          currency:               d.currency,
          planned_close_at:       d.planned_close_at,
          source:                 d.source,
          owner_id:               d.owner_id ?? req.user.id,
          stage_history:          JSON.stringify([{
            stage,
            at:         new Date().toISOString(),
            by_user_id: req.user.id,
          }]),
        })
        .returning('*');

      await logActivity(trx, {
        deal_id:    deal.id,
        company_id: deal.company_id,
        userId:     req.user.id,
        message:    `Сделка создана: «${deal.title}» · стадия «${STAGE_LABELS[stage]}»`,
      });

      return deal;
    });

    res.status(201).json(result);
  } catch (err) {
    console.error('[deals/create]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/deals/:id ────────────────────────────────────────────────────────

router.put('/:id', validate(UpdateDealSchema), async (req, res) => {
  try {
    const existing = await knex('deals').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Сделка не найдена' });
    if (!canModify(existing, req.user)) return res.status(403).json({ error: 'Нет прав' });

    const d = req.body;
    const e = existing;

    // Если стадия изменилась — обновляем stage_history и probability
    let stageFields = {};
    if (d.stage && d.stage !== e.stage) {
      const history = [...(e.stage_history ?? []), {
        stage: d.stage, from: e.stage,
        at: new Date().toISOString(), by_user_id: req.user.id,
      }];
      const prob = e.probability === STAGE_PROBABILITY[e.stage]
        ? STAGE_PROBABILITY[d.stage]
        : e.probability;
      stageFields = { stage: d.stage, stage_history: JSON.stringify(history), probability: prob };
    }

    const [updated] = await knex('deals')
      .where({ id: req.params.id })
      .update({
        title:                  d.title,
        description:            d.description   !== undefined ? d.description   : e.description,
        service:                d.service       !== undefined ? d.service       : e.service,
        planned_revenue:        d.planned_revenue        !== undefined ? d.planned_revenue        : e.planned_revenue,
        planned_margin:         d.planned_margin         !== undefined ? d.planned_margin         : e.planned_margin,
        planned_margin_percent: d.planned_margin_percent !== undefined ? d.planned_margin_percent : e.planned_margin_percent,
        probability:            d.probability   !== undefined ? d.probability   : e.probability,
        currency:               d.currency      !== undefined ? d.currency      : e.currency,
        planned_close_at:       d.planned_close_at !== undefined ? d.planned_close_at : e.planned_close_at,
        source:                 d.source        !== undefined ? d.source        : e.source,
        ...stageFields,
      })
      .returning('*');

    res.json(updated);
  } catch (err) {
    console.error('[deals/update]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/deals/:id/stage ────────────────────────────────────────────────

router.patch('/:id/stage', validate(StageSchema), async (req, res) => {
  try {
    const { stage: newStage } = req.body;

    const existing = await knex('deals').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Сделка не найдена' });
    if (!canModify(existing, req.user)) return res.status(403).json({ error: 'Нет прав' });

    const e = existing;
    if (e.stage === newStage) return res.json(e);

    const history = [...(e.stage_history ?? []), {
      stage: newStage, from: e.stage,
      at: new Date().toISOString(), by_user_id: req.user.id,
    }];
    const prob = e.probability === STAGE_PROBABILITY[e.stage]
      ? STAGE_PROBABILITY[newStage]
      : e.probability;

    const result = await knex.transaction(async (trx) => {
      const [deal] = await trx('deals')
        .where({ id: req.params.id })
        .update({
          stage:         newStage,
          stage_history: JSON.stringify(history),
          probability:   prob,
        })
        .returning('*');

      await logActivity(trx, {
        deal_id:    e.id,
        company_id: e.company_id,
        userId:     req.user.id,
        message:    `Стадия: ${STAGE_LABELS[e.stage]} → ${STAGE_LABELS[newStage]}`,
      });

      return deal;
    });

    res.json(result);
  } catch (err) {
    console.error('[deals/stage]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/deals/:id/close ────────────────────────────────────────────────

router.patch('/:id/close', validate(CloseSchema), async (req, res) => {
  try {
    const { outcome, loss_reason } = req.body;

    const existing = await knex('deals').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Сделка не найдена' });
    if (!canModify(existing, req.user)) return res.status(403).json({ error: 'Нет прав' });

    const prob = outcome === 'won' ? 100 : outcome === 'lost' ? 0 : existing.probability;

    const result = await knex.transaction(async (trx) => {
      const [deal] = await trx('deals')
        .where({ id: req.params.id })
        .update({
          outcome,
          loss_reason: outcome === 'lost' ? loss_reason : '',
          closed_at:   knex.fn.now(),
          probability: prob,
        })
        .returning('*');

      const label = { won: 'Выиграна', lost: 'Проиграна', postponed: 'Отложена' }[outcome];
      await logActivity(trx, {
        deal_id:    existing.id,
        company_id: existing.company_id,
        userId:     req.user.id,
        message:    `Сделка закрыта: ${label}${outcome === 'lost' ? ` (причина: ${loss_reason})` : ''}`,
      });

      return deal;
    });

    res.json(result);
  } catch (err) {
    console.error('[deals/close]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/deals/:id/reopen ───────────────────────────────────────────────

router.patch('/:id/reopen', async (req, res) => {
  try {
    const existing = await knex('deals').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Сделка не найдена' });
    if (!canModify(existing, req.user)) return res.status(403).json({ error: 'Нет прав' });

    const result = await knex.transaction(async (trx) => {
      const [deal] = await trx('deals')
        .where({ id: req.params.id })
        .update({
          outcome:     'in_progress',
          loss_reason: '',
          closed_at:   null,
        })
        .returning('*');

      await logActivity(trx, {
        deal_id:    existing.id,
        company_id: existing.company_id,
        userId:     req.user.id,
        message:    `Сделка возобновлена (стадия: ${STAGE_LABELS[existing.stage]})`,
      });

      return deal;
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/deals/:id ─────────────────────────────────────────────────────

router.delete('/:id', requireRole('admin', 'head'), async (req, res) => {
  try {
    const deleted = await knex('deals').where({ id: req.params.id }).del();
    if (!deleted) return res.status(404).json({ error: 'Сделка не найдена' });
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
