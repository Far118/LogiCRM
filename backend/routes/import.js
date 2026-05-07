/**
 * routes/import.js
 *
 * POST /api/import/companies — принимает массив компаний, bulk insert
 * GET  /api/import/template  — скачать шаблон CSV
 */

import { Router } from 'express';
import { query, tx } from '../db/pool.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

// ── Шаблон CSV ────────────────────────────────────────────────────────────────

router.get('/template', (req, res) => {
  const headers = [
    'inn', 'name', 'ogrn', 'website', 'address_legal',
    'industry', 'segment', 'priority', 'source',
    'cargo_types', 'directions', 'regions',
    'shipment_freq', 'volume_monthly', 'current_carrier',
    'contact_name', 'contact_phone', 'contact_email', 'contact_position',
    'description', 'tags',
  ].join(',');

  const example = [
    '7707083893', 'ООО Ромашка', '', 'romashka.ru', 'г. Москва ул. Ленина 1',
    'Производство', 'warm_lead', 'high', 'cold_call',
    'general;bulk', 'road;rail', 'Москва;Урал',
    'monthly', '500 т', 'ПЭК',
    'Иван Иванов', '+7 999 000 0000', 'ivan@romashka.ru', 'Директор по логистике',
    'Крупный производитель', 'ключевой;тендер',
  ].join(',');

  const csv = `${headers}\n${example}\n`;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="logicrm_import_template.csv"');
  res.send('\uFEFF' + csv); // BOM для корректного открытия в Excel
});

// ── Bulk import ───────────────────────────────────────────────────────────────

router.post('/companies', async (req, res) => {
  try {
    const { rows: data, owner_id, update_existing = false } = req.body;

    if (!Array.isArray(data) || !data.length) {
      return res.status(400).json({ error: 'Нет данных для импорта' });
    }
    if (data.length > 5000) {
      return res.status(400).json({ error: 'Максимум 5000 строк за раз' });
    }

    const ownerId = owner_id || req.user.id;

    // Валидация и нормализация
    const errors   = [];
    const valid    = [];
    const SEGMENTS = ['cold_lead','warm_lead','hot_lead','active_client','vip','inactive','lost'];
    const PRIORITIES = ['high','medium','low'];

    data.forEach((row, i) => {
      const line = i + 2; // +2 потому что строка 1 — заголовки
      const inn = String(row.inn || '').replace(/\D/g, '');
      if (!inn) { errors.push({ line, field: 'inn', msg: 'ИНН обязателен' }); return; }
      if (inn.length !== 10 && inn.length !== 12) {
        errors.push({ line, field: 'inn', msg: `Некорректный ИНН: ${row.inn} (нужно 10 или 12 цифр)` }); return;
      }

      // Название: если не задано — используем ИНН как временное
      const rawName = String(row.name || '').trim();
      const name = rawName || `Компания ИНН ${inn}`;
      if (rawName.length > 500) { errors.push({ line, field: 'name', msg: 'Слишком длинное название' }); return; }

      const segment  = SEGMENTS.includes(row.segment)   ? row.segment  : 'cold_lead';
      const priority = PRIORITIES.includes(row.priority) ? row.priority : 'medium';

      const parseList = (val) => {
        if (!val) return [];
        return String(val).split(/[;,]/).map(s => s.trim()).filter(Boolean);
      };

      valid.push({
        name,
        inn:              inn || '',
        ogrn:             String(row.ogrn || '').replace(/\D/g, ''),
        website:          String(row.website || '').trim(),
        address_legal:    String(row.address_legal || '').trim(),
        address_actual:   String(row.address_actual || row.address_legal || '').trim(),
        industry:         String(row.industry || '').trim(),
        description:      String(row.description || '').trim(),
        segment,
        priority,
        source:           String(row.source || '').trim(),
        cargo_types:      parseList(row.cargo_types),
        directions:       parseList(row.directions),
        regions:          parseList(row.regions),
        routes:           [],
        shipment_freq:    String(row.shipment_freq || '').trim(),
        volume_monthly:   String(row.volume_monthly || '').trim(),
        current_carrier:  String(row.current_carrier || '').trim(),
        switch_reason:    String(row.switch_reason || '').trim(),
        potential:        String(row.potential || '').trim(),
        tags:             parseList(row.tags),
        next_action_type: '',
        owner_id:         ownerId,
        // Контакт из отдельных колонок
        _contact: row.contact_name ? {
          first_name: String(row.contact_name || '').split(' ')[0] || '',
          last_name:  String(row.contact_name || '').split(' ').slice(1).join(' ') || '',
          position:   String(row.contact_position || '').trim(),
          phone_main: String(row.contact_phone || '').trim(),
          email:      String(row.contact_email || '').trim(),
        } : null,
      });
    });

    // Если критических ошибок много — останавливаемся
    if (errors.length > 50) {
      return res.status(422).json({
        error: `Слишком много ошибок (${errors.length}). Проверьте файл.`,
        errors: errors.slice(0, 20),
      });
    }

    // Получаем существующие ИНН для update_existing
    const innList = valid.map(r => r.inn); // ИНН всегда есть — прошёл валидацию
    const existingByInn = {};
    if (update_existing && innList.length) {
      const { rows: existing } = await query(
        `SELECT id, inn FROM companies WHERE inn = ANY($1)`,
        [innList]
      );
      existing.forEach(r => { existingByInn[r.inn] = r.id; });
    }

    const result = await tx(async (client) => {
      let created = 0, updated = 0, skipped = 0;
      const contactsToCreate = [];

      for (const row of valid) {
        const { _contact, ...company } = row;

        const existId = existingByInn[company.inn] || null;

        if (existId && update_existing) {
          // Обновляем существующую
          await client.query(`
            UPDATE companies SET
              name=$1, industry=$2, description=$3, segment=$4, priority=$5,
              source=$6, cargo_types=$7, directions=$8, regions=$9,
              shipment_freq=$10, volume_monthly=$11, current_carrier=$12, tags=$13,
              website=$14, address_legal=$15
            WHERE id=$16`,
            [
              company.name, company.industry, company.description,
              company.segment, company.priority, company.source,
              JSON.stringify(company.cargo_types), JSON.stringify(company.directions),
              JSON.stringify(company.regions), company.shipment_freq,
              company.volume_monthly, company.current_carrier,
              JSON.stringify(company.tags), company.website, company.address_legal,
              existId,
            ]
          );
          updated++;
          if (_contact) contactsToCreate.push({ ..._contact, company_id: existId });
        } else if (existId && !update_existing) {
          skipped++;
        } else {
          // Создаём новую
          const { rows } = await client.query(`
            INSERT INTO companies (
              name, inn, ogrn, website, address_legal, address_actual,
              industry, description, segment, priority, source,
              cargo_types, directions, regions, routes,
              shipment_freq, volume_monthly, current_carrier, switch_reason,
              potential, tags, next_action_type, owner_id
            ) VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
              $12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23
            ) RETURNING id`,
            [
              company.name, company.inn, company.ogrn, company.website,
              company.address_legal, company.address_actual,
              company.industry, company.description, company.segment,
              company.priority, company.source,
              JSON.stringify(company.cargo_types), JSON.stringify(company.directions),
              JSON.stringify(company.regions), JSON.stringify(company.routes),
              company.shipment_freq, company.volume_monthly, company.current_carrier,
              company.switch_reason, company.potential,
              JSON.stringify(company.tags), company.next_action_type, company.owner_id,
            ]
          );
          created++;
          if (_contact) contactsToCreate.push({ ..._contact, company_id: rows[0].id });
        }
      }

      // Создаём контакты пачкой
      for (const c of contactsToCreate) {
        if (!c.first_name) continue;
        await client.query(`
          INSERT INTO contacts (company_id, first_name, last_name, position, phone_main, email)
          VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT DO NOTHING`,
          [c.company_id, c.first_name, c.last_name, c.position, c.phone_main, c.email]
        );
      }

      return { created, updated, skipped, contacts: contactsToCreate.length, errors };
    });

    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[import/companies]', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
