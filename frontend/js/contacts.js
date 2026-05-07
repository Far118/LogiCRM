/**
 * LogiCRM — contacts.js
 * CRUD контактов внутри компании
 * Спринт 1
 */

import { dbAdd, dbPut, dbGet, dbGetByIndex, dbDelete, uuid, now } from './db.js';
import { can, ROLES } from './auth.js';

function normalizeString(value) {
  return String(value ?? '').trim();
}

function normalizeDate(value) {
  return value ? String(value) : '';
}

function ensureContactAccess() {
  if (!can([ROLES.ADMIN, ROLES.HEAD, ROLES.MANAGER])) {
    throw new Error('Недостаточно прав');
  }
}

function buildFullName(contact) {
  return [contact.first_name, contact.last_name].filter(Boolean).join(' ').trim();
}

export async function getContacts(company_id) {
  if (!company_id) throw new Error('company_id обязателен');
  ensureContactAccess();

  const list = await dbGetByIndex('contacts', 'company_id', company_id);

  return list.sort((a, b) => {
    const aName = buildFullName(a).toLowerCase();
    const bName = buildFullName(b).toLowerCase();
    if (aName < bName) return -1;
    if (aName > bName) return 1;
    return 0;
  });
}

export async function getContact(id) {
  if (!id) throw new Error('id обязателен');
  ensureContactAccess();

  const contact = await dbGet('contacts', id);
  if (!contact) throw new Error('Контакт не найден');
  return contact;
}

export async function createContact(data) {
  ensureContactAccess();

  if (!data.company_id) throw new Error('company_id обязателен');
  if (!normalizeString(data.first_name)) throw new Error('Имя контакта обязательно');

  const contact = {
    id: uuid(),
    company_id: data.company_id,
    first_name: normalizeString(data.first_name),
    last_name: normalizeString(data.last_name),
    position: normalizeString(data.position),
    role: data.role || 'unknown',
    phone_main: normalizeString(data.phone_main),
    phone_alt: normalizeString(data.phone_alt),
    email: normalizeString(data.email),
    telegram: normalizeString(data.telegram),
    whatsapp: normalizeString(data.whatsapp),
    preferred_channel: data.preferred_channel || '',
    notes: normalizeString(data.notes),
    last_contact_at: normalizeDate(data.last_contact_at),
    created_at: now(),
    updated_at: now(),
  };

  await dbAdd('contacts', contact);
  return contact;
}

export async function updateContact(id, data) {
  ensureContactAccess();

  const existing = await dbGet('contacts', id);
  if (!existing) throw new Error('Контакт не найден');

  const firstName = normalizeString(data.first_name ?? existing.first_name);
  if (!firstName) throw new Error('Имя контакта обязательно');

  const updated = {
    ...existing,
    ...data,
    id,
    first_name: firstName,
    last_name: normalizeString(data.last_name ?? existing.last_name),
    position: normalizeString(data.position ?? existing.position),
    role: data.role ?? existing.role ?? 'unknown',
    phone_main: normalizeString(data.phone_main ?? existing.phone_main),
    phone_alt: normalizeString(data.phone_alt ?? existing.phone_alt),
    email: normalizeString(data.email ?? existing.email),
    telegram: normalizeString(data.telegram ?? existing.telegram),
    whatsapp: normalizeString(data.whatsapp ?? existing.whatsapp),
    preferred_channel: data.preferred_channel ?? existing.preferred_channel ?? '',
    notes: normalizeString(data.notes ?? existing.notes),
    last_contact_at: normalizeDate(data.last_contact_at ?? existing.last_contact_at),
    created_at: existing.created_at,
    updated_at: now(),
  };

  await dbPut('contacts', updated);
  return updated;
}

export async function deleteContact(id) {
  ensureContactAccess();

  const existing = await dbGet('contacts', id);
  if (!existing) throw new Error('Контакт не найден');

  await dbDelete('contacts', id);
  return true;
}

export const CONTACT_ROLE_LABELS = {
  lpr: 'ЛПР',
  influencer: 'Влияет на решение',
  executor: 'Исполнитель',
  blocker: 'Блокер',
  unknown: 'Неизвестно',
};

export const CHANNEL_LABELS = {
  phone: 'Телефон',
  email: 'Email',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
};

export function getContactFullName(contact) {
  return buildFullName(contact) || 'Без имени';
}