/**
 * LogiCRM — companies.js
 * CRUD компаний: создание, редактирование, поиск, фильтрация
 * Версия: 1.0 | Спринт 1
 */

import {
  dbAdd, dbPut, dbGet, dbGetAll, dbGetByIndex,
  dbDelete, dbFilter, uuid, now
} from './db.js';
import { getSession, can, ROLES } from './auth.js';

// ─── Список компаний ──────────────────────────────────────────────────────────

/**
 * Получить все компании с учётом прав.
 * manager — только свои, head/admin — все.
 */
export async function getCompanies() {
  const session = getSession();
  if (!session) return [];
  if (can([ROLES.MANAGER])) return dbGetByIndex('companies', 'owner_id', session.id);
  return dbGetAll('companies');
}

/**
 * Поиск + фильтрация + сортировка компаний.
 */
export async function searchCompanies({
  query    = '',
  segment  = '',
  priority = '',
  owner_id = '',
  sort     = 'created_at',
  order    = 'desc',
} = {}) {
  let list = await getCompanies();

  if (query.trim()) {
    const q = query.toLowerCase().trim();
    list = list.filter(c =>
      (c.name        ?? '').toLowerCase().includes(q) ||
      (c.inn         ?? '').toLowerCase().includes(q) ||
      (c.description ?? '').toLowerCase().includes(q) ||
      (c.industry    ?? '').toLowerCase().includes(q)
    );
  }
  if (segment)  list = list.filter(c => c.segment  === segment);
  if (priority) list = list.filter(c => c.priority === priority);
  if (owner_id) list = list.filter(c => c.owner_id === owner_id);

  const PRI = { high: 0, medium: 1, low: 2 };
  list.sort((a, b) => {
    let va = sort === 'priority' ? (PRI[a.priority] ?? 9) : (a[sort] ?? '');
    let vb = sort === 'priority' ? (PRI[b.priority] ?? 9) : (b[sort] ?? '');
    if (va < vb) return order === 'asc' ? -1 : 1;
    if (va > vb) return order === 'asc' ? 1 : -1;
    return 0;
  });
  return list;
}

// ─── Одна компания ────────────────────────────────────────────────────────────

export async function getCompany(id) {
  const company = await dbGet('companies', id);
  if (!company) return null;
  const session = getSession();
  if (!session) return null;
  if (can([ROLES.MANAGER]) && company.owner_id !== session.id) {
    throw new Error('Нет доступа к этой компании');
  }
  return company;
}

// ─── Создание ─────────────────────────────────────────────────────────────────

export async function createCompany(data) {
  const session = getSession();
  if (!session) throw new Error('Не авторизован');
  if (!can([ROLES.ADMIN, ROLES.HEAD, ROLES.MANAGER])) throw new Error('Недостаточно прав');
  if (!data.name?.trim()) throw new Error('Название компании обязательно');

  const company = {
    id:               uuid(),
    name:             data.name.trim(),
    inn:              data.inn?.trim()             ?? '',
    ogrn:             data.ogrn?.trim()            ?? '',
    website:          data.website?.trim()         ?? '',
    address_legal:    data.address_legal?.trim()   ?? '',
    address_actual:   data.address_actual?.trim()  ?? '',
    regions:          data.regions                ?? [],
    industry:         data.industry?.trim()        ?? '',
    description:      data.description?.trim()     ?? '',
    segment:          data.segment                ?? 'cold_lead',
    cargo_types:      data.cargo_types            ?? [],
    directions:       data.directions             ?? [],
    routes:           data.routes                 ?? [],
    shipment_freq:    data.shipment_freq           ?? '',
    volume_monthly:   data.volume_monthly?.trim()  ?? '',
    potential:        data.potential               ?? '',
    current_carrier:  data.current_carrier?.trim() ?? '',
    switch_reason:    data.switch_reason?.trim()   ?? '',
    owner_id:         data.owner_id               ?? session.id,
    source:           data.source                ?? '',
    priority:         data.priority              ?? 'medium',
    tags:             data.tags                  ?? [],
    next_action_at:   data.next_action_at          ?? '',
    next_action_type: data.next_action_type        ?? '',
    first_contact_at: data.first_contact_at        ?? new Date().toISOString().split('T')[0],
    created_at:       now(),
    updated_at:       now(),
  };
  await dbAdd('companies', company);
  return company;
}

// ─── Редактирование ───────────────────────────────────────────────────────────

export async function updateCompany(id, data) {
  const existing = await getCompany(id);
  if (!existing) throw new Error('Компания не найдена');
  if (can([ROLES.MANAGER]) && existing.owner_id !== getSession()?.id) {
    throw new Error('Нет прав на редактирование');
  }
  if (!data.name?.trim()) throw new Error('Название компании обязательно');
  const updated = { ...existing, ...data, id, created_at: existing.created_at, updated_at: now() };
  await dbPut('companies', updated);
  return updated;
}

// ─── Удаление ─────────────────────────────────────────────────────────────────

export async function deleteCompany(id) {
  if (!can([ROLES.ADMIN, ROLES.HEAD])) throw new Error('Недостаточно прав');
  await dbDelete('companies', id);
}

// ─── Справочники ──────────────────────────────────────────────────────────────

//export const SEGMENT_LABELS = {
  //cold_lead: 'Холодный лид', warm_lead: 'Тёплый лид', client: 'Клиент',
  //partner: 'Партнёр', competitor: 'Конкурент', not_target: 'Не целевой',
//};
//export const SEGMENT_COLORS = {
  //cold_lead: 'blue', warm_lead: 'orange', client: 'green',
  //partner: 'teal', competitor: 'red', not_target: 'gray',
//};
export const SEGMENT_LABELS = {
  cold_lead:     'Холодный лид', 
  warm_lead:     'Тёплый лид', 
  hot_lead:      'Горячий лид',
  active_client: 'Клиент',     // Обязательно active_client для бэкенда
  vip:           'VIP клиент',
  inactive:      'Не активен', 
  lost:          'Потерян',
};

export const SEGMENT_COLORS = {
  cold_lead:     'blue', 
  warm_lead:     'orange', 
  hot_lead:      'red',
  active_client: 'green', 
  vip:           'purple',
  inactive:      'gray', 
  lost:          'black',
};
export const PRIORITY_LABELS = { high: 'Высокий', medium: 'Средний', low: 'Низкий' };
export const PRIORITY_COLORS = { high: 'red', medium: 'orange', low: 'gray' };

// Добавь это в самый конец файла js/companies.js
document.addEventListener('alpine:init', () => {
  Alpine.data('companyPage', () => ({
    company: null,
    isEditing: false,
    activeTab: 'overview',
    isLoading: true,

    // Прокидываем справочники прямо в компонент
    segmentLabels: SEGMENT_LABELS,
    segmentColors: SEGMENT_COLORS,

    async initPage() {
      const urlParams = new URLSearchParams(window.location.search);
      const id = urlParams.get('id');
      if (!id) return (window.location.href = '/companies.html');

      try {
        // Используем твою существующую функцию getCompany из этого же файла
        this.company = await getCompany(id);
        if (!this.company) throw new Error('Компания не найдена');
        this.isLoading = false;
      } catch (err) {
        console.error(err);
        alert(err.message);
      }
    },

    async save() {
      try {
        // Используем твою существующую функцию updateCompany
        await updateCompany(this.company.id, this.company);
        this.isEditing = false;
        alert('Сохранено успешно');
      } catch (err) {
        alert('Ошибка сохранения: ' + err.message);
      }
    }
  }));
});