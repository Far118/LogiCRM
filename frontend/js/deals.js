/**
 * deals.js — CRUD сделок + воронка продаж
 * changeStage / closeDeal / reopenDeal вызывают PATCH-эндпоинты API.
 */

import { dbAdd, dbPut, dbGet, dbGetAll, dbGetByIndex, dbDelete } from './db.js';
import { getSession, can, ROLES } from './auth.js';

// ── Константы воронки ─────────────────────────────────────────────────────────

export const STAGES = [
  'new_lead','qualification','dm_found','request_received',
  'pricing','proposal_sent','negotiation','contract',
  'first_shipment','repeat_sales',
];

export const STAGE_LABELS = {
  new_lead:         'Новый лид',
  qualification:    'Квалификация',
  dm_found:         'Выявлен ЛПР',
  request_received: 'Получен запрос',
  pricing:          'Расчёт / ставка',
  proposal_sent:    'КП отправлено',
  negotiation:      'Согласование',
  contract:         'Договор',
  first_shipment:   'Первая отгрузка',
  repeat_sales:     'Повторные продажи',
};

export const STAGE_PROBABILITY = {
  new_lead:5,qualification:10,dm_found:20,request_received:30,
  pricing:40,proposal_sent:55,negotiation:70,contract:85,
  first_shipment:95,repeat_sales:100,
};

export const STAGE_COLORS = {
  new_lead:'gray',qualification:'blue',dm_found:'blue',request_received:'orange',
  pricing:'orange',proposal_sent:'teal',negotiation:'teal',contract:'teal',
  first_shipment:'green',repeat_sales:'green',
};

export const OUTCOME_LABELS  = { in_progress:'В работе',won:'Выиграна',lost:'Проиграна',postponed:'Отложена' };
export const OUTCOME_COLORS  = { in_progress:'gray',won:'green',lost:'red',postponed:'orange' };
export const SERVICE_LABELS  = { transport:'Перевозка',customs:'Таможня',warehouse:'Склад',multimodal:'Мультимодал',other:'Другое' };
export const LOSS_REASON_LABELS = {
  price:'Цена',timing:'Сроки',service:'Сервис',
  no_need:'Нет потребности',carrier:'Другой перевозчик',
  no_lpr:'Не вышли на ЛПР',other_loss:'Другое',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function ensureSession() {
  const s = getSession();
  if (!s) throw new Error('Не авторизован');
  return s;
}

/** Прямой fetch к API (для PATCH-эндпоинтов, которых нет в db.js). */
async function apiFetch(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export async function getDeals() {
  ensureSession();
  return dbGetAll('deals');
}

export async function getDealsByCompany(company_id) {
  if (!company_id) throw new Error('company_id обязателен');
  ensureSession();
  return dbGetByIndex('deals', 'company_id', company_id);
}

export async function searchDeals({ query='',stage='',outcome='',service='',owner_id='' }={}) {
  ensureSession();
  let list = await getDeals();
  if (stage)    list = list.filter(d => d.stage === stage);
  if (outcome)  list = list.filter(d => d.outcome === outcome);
  if (service)  list = list.filter(d => d.service === service);
  if (owner_id) list = list.filter(d => d.owner_id === owner_id);
  if (query.trim()) {
    const q = query.toLowerCase();
    list = list.filter(d => d.title?.toLowerCase().includes(q) || d.description?.toLowerCase().includes(q));
  }
  return list;
}

export async function getDeal(id) {
  ensureSession();
  return dbGet('deals', id);
}

export async function createDeal(data) {
  ensureSession();
  const session = getSession();
  return dbAdd('deals', {
    title:           (data.title || '').trim(),
    company_id:      data.company_id,
    description:     data.description || '',
    service:         data.service || 'transport',
    stage:           data.stage || 'new_lead',
    probability:     data.probability ?? STAGE_PROBABILITY[data.stage || 'new_lead'],
    planned_revenue: Number(data.planned_revenue || 0),
    planned_margin:  Number(data.planned_margin  || 0),
    planned_margin_percent: Number(data.planned_margin_percent || 0),
    currency:        data.currency || 'RUB',
    planned_close_at: data.planned_close_at || null,
    source:          data.source || '',
    owner_id:        data.owner_id || session.id,
  });
}

export async function updateDeal(id, data) {
  ensureSession();
  return dbPut('deals', { ...data, id });
}

/** Сменить стадию через PATCH /api/deals/:id/stage */
export async function changeStage(id, newStage) {
  ensureSession();
  return apiFetch('PATCH', `/deals/${id}/stage`, { stage: newStage });
}

/** Закрыть сделку через PATCH /api/deals/:id/close */
export async function closeDeal(id, outcome, loss_reason = '') {
  ensureSession();
  return apiFetch('PATCH', `/deals/${id}/close`, { outcome, loss_reason });
}

/** Возобновить через PATCH /api/deals/:id/reopen */
export async function reopenDeal(id) {
  ensureSession();
  return apiFetch('PATCH', `/deals/${id}/reopen`, {});
}

export async function deleteDeal(id) {
  ensureSession();
  return dbDelete('deals', id);
}

// ── Аналитика ─────────────────────────────────────────────────────────────────

export function summarizeFunnel(deals) {
  const active = deals.filter(d => d.outcome === 'in_progress');
  return {
    total:   deals.length,
    active:  active.length,
    won:     deals.filter(d => d.outcome === 'won').length,
    lost:    deals.filter(d => d.outcome === 'lost').length,
    revenue: deals.filter(d => d.outcome === 'won').reduce((s,d) => s + Number(d.planned_revenue||0), 0),
    pipeline:active.reduce((s,d) => s + Number(d.planned_revenue||0), 0),
    byStage: Object.fromEntries(STAGES.map(s => [s, active.filter(d => d.stage === s).length])),
  };
}

export function conversionByStage(deals) {
  return STAGES.map((s, i) => ({
    stage: s, label: STAGE_LABELS[s],
    count: deals.filter(d => d.stage === s || (i > 0 && deals.find(x => (x.stage_history||[]).some(h => h.stage === s)))).length,
  }));
}

export function topLossReasons(deals, limit = 5) {
  const lost = deals.filter(d => d.outcome === 'lost');
  const cnt  = {};
  lost.forEach(d => { const r = d.loss_reason||'other_loss'; cnt[r] = (cnt[r]||0)+1; });
  return Object.entries(cnt).sort((a,b)=>b[1]-a[1]).slice(0,limit)
    .map(([r,n]) => ({ reason:r, label: LOSS_REASON_LABELS[r]||r, count:n }));
}

export function formatMoney(amount, currency = 'RUB') {
  const n = Number(amount || 0);
  if (currency === 'RUB') return n.toLocaleString('ru-RU') + ' ₽';
  if (currency === 'USD') return '$' + n.toLocaleString('en-US');
  if (currency === 'EUR') return '€' + n.toLocaleString('de-DE');
  return n.toString() + ' ' + currency;
}
