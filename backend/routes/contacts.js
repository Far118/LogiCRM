/**
 * routes/contacts.js
 *
 * Исправление IDOR (аудит 2.1):
 *   • assertCompanyAccess() — проверяет owner_id компании перед любой операцией.
 *   • Менеджер видит/редактирует только контакты своих компаний.
 *   • DELETE проверяет владение (ранее было доступно всем ролям без проверки).
 */

import { Router } from 'express';
import { z }      from 'zod';
import knex       from '../db/knex.js';
import { authenticate } from '../middleware/auth.js';
import { validate }     from '../middleware/validate.js';

const router = Router();
router.use(authenticate);

// ops не имеет доступа к контактам
function checkRole(role) {
  if (!['admin', 'head', 'manager'].includes(role)) {
    throw Object.assign(new Error('Недостаточно прав'), { status: 403 });
  }
}

// IDOR-фикс: менеджер может работать только с контактами своих компаний
async function assertCompanyAccess(companyId, user) {
  const company = await knex('companies').where({ id: companyId }).first();
  if (!company) throw Object.assign(new Error('Компания не найдена'), { status: 404 });
  if (user.role === 'manager' && company.owner_id !== user.id) {
    throw Object.assign(new Error('Нет доступа к этой компании'), { status: 403 });
  }
  return company;
}

// Zod
const ContactFieldsSchema = z.object({
  first_name:        z.string().max(255).optional(),
  last_name:         z.string().max(255).optional(),
  position:          z.string().max(255).optional(),
  role:              z.string().max(100).optional(),
  phone_main:        z.string().max(50).optional(),
  phone_alt:         z.string().max(50).optional(),
  email:             z.string().max(255).optional(),
  telegram:          z.string().max(255).optional(),
  whatsapp:          z.string().max(255).optional(),
  preferred_channel: z.string().max(50).optional(),
  notes:             z.string().max(5000).optional(),
  last_contact_at:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

const CreateContactSchema = ContactFieldsSchema.extend({
  company_id: z.string().uuid().optional(),
  first_name: ContactFieldsSchema.shape.first_name.default(''),
  last_name:  ContactFieldsSchema.shape.last_name.default(''),
  position:   ContactFieldsSchema.shape.position.default(''),
  role:       ContactFieldsSchema.shape.role.default('unknown'),
  phone_main: ContactFieldsSchema.shape.phone_main.default(''),
  phone_alt:  ContactFieldsSchema.shape.phone_alt.default(''),
  email:      ContactFieldsSchema.shape.email.default(''),
  telegram:   ContactFieldsSchema.shape.telegram.default(''),
  whatsapp:   ContactFieldsSchema.shape.whatsapp.default(''),
  preferred_channel: ContactFieldsSchema.shape.preferred_channel.default(''),
  notes:      ContactFieldsSchema.shape.notes.default(''),
  last_contact_at: ContactFieldsSchema.shape.last_contact_at.default(null),
});

const UpdateContactSchema = ContactFieldsSchema.partial();

// GET /api/contacts
router.get('/', async (req, res) => {
  try {
    checkRole(req.user.role);
    const { company_id } = req.query;
    if (!company_id) return res.status(400).json({ error: 'company_id обязателен' });
    await assertCompanyAccess(company_id, req.user);
    const rows = await knex('contacts').where({ company_id }).orderBy('first_name').orderBy('last_name');
    res.json(rows);
  } catch (err) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// GET /api/contacts/:id
router.get('/:id', async (req, res) => {
  try {
    checkRole(req.user.role);
    const contact = await knex('contacts').where({ id: req.params.id }).first();
    if (!contact) return res.status(404).json({ error: 'Контакт не найден' });
    await assertCompanyAccess(contact.company_id, req.user);
    res.json(contact);
  } catch (err) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// POST /api/contacts
router.post('/', validate(CreateContactSchema), async (req, res) => {
  try {
    checkRole(req.user.role);
    const d = req.body;
    if (!d.company_id) return res.status(400).json({ error: 'company_id обязателен' });
    if (!d.first_name?.trim()) return res.status(400).json({ error: 'Имя обязательно' });
    await assertCompanyAccess(d.company_id, req.user);
    const [contact] = await knex('contacts').insert({
      company_id: d.company_id,
      first_name: d.first_name.trim(),
      last_name:  (d.last_name ?? '').trim(),
      position:   (d.position  ?? '').trim(),
      role:        d.role      ?? 'unknown',
      phone_main: (d.phone_main ?? '').trim(),
      phone_alt:  (d.phone_alt  ?? '').trim(),
      email:      (d.email      ?? '').trim(),
      telegram:   (d.telegram   ?? '').trim(),
      whatsapp:   (d.whatsapp   ?? '').trim(),
      preferred_channel: d.preferred_channel ?? '',
      notes:      (d.notes ?? '').trim(),
      last_contact_at: d.last_contact_at || null,
    }).returning('*');
    res.status(201).json(contact);
  } catch (err) {
    console.error('[contacts/create]', err.message);
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// PUT /api/contacts/:id
router.put('/:id', validate(UpdateContactSchema), async (req, res) => {
  try {
    checkRole(req.user.role);
    const existing = await knex('contacts').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Контакт не найден' });
    await assertCompanyAccess(existing.company_id, req.user);
    const d = req.body, e = existing;
    const firstName = (d.first_name ?? e.first_name)?.trim();
    if (!firstName) return res.status(400).json({ error: 'Имя обязательно' });
    const [updated] = await knex('contacts').where({ id: req.params.id }).update({
      first_name:        firstName,
      last_name:         (d.last_name         ?? e.last_name         ?? '').trim(),
      position:          (d.position          ?? e.position          ?? '').trim(),
      role:               d.role              ?? e.role              ?? 'unknown',
      phone_main:        (d.phone_main        ?? e.phone_main        ?? '').trim(),
      phone_alt:         (d.phone_alt         ?? e.phone_alt         ?? '').trim(),
      email:             (d.email             ?? e.email             ?? '').trim(),
      telegram:          (d.telegram          ?? e.telegram          ?? '').trim(),
      whatsapp:          (d.whatsapp          ?? e.whatsapp          ?? '').trim(),
      preferred_channel:  d.preferred_channel ?? e.preferred_channel ?? '',
      notes:             (d.notes             ?? e.notes             ?? '').trim(),
      last_contact_at:    d.last_contact_at   || e.last_contact_at  || null,
    }).returning('*');
    res.json(updated);
  } catch (err) {
    console.error('[contacts/update]', err.message);
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// DELETE /api/contacts/:id
router.delete('/:id', async (req, res) => {
  try {
    checkRole(req.user.role);
    const existing = await knex('contacts').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Контакт не найден' });
    await assertCompanyAccess(existing.company_id, req.user);
    await knex('contacts').where({ id: req.params.id }).del();
    res.status(204).end();
  } catch (err) { res.status(err.status ?? 500).json({ error: err.message }); }
});

export default router;
