/**
 * js/pages/company.js — Alpine-компонент карточки компании
 *
 * Регистрирует Alpine.data('companyPage') и запускает Alpine.
 * Вся бизнес-логика (CRUD, поиск по ИНН, черновик) перенесена
 * из inline-скрипта company.html в методы этого компонента.
 *
 * Следует паттерну из js/pages/activities.js (Блок 2).
 */

import Alpine from 'alpinejs';

import { initUI, esc, fmtDate, fmtDateTime, toast, todayStr } from '../ui.js';
import {
  getCompany, createCompany, updateCompany, deleteCompany,
  SEGMENT_LABELS, SEGMENT_COLORS, PRIORITY_LABELS,
} from '../companies.js';
import {
  getContacts, createContact, updateContact, deleteContact,
  CONTACT_ROLE_LABELS, getContactFullName,
} from '../contacts.js';
import {
  getActivitiesByCompany, createActivity, deleteActivity, markDone,
  ACTIVITY_TYPE_LABELS, ACTIVITY_TYPE_COLORS, isOverdue,
} from '../activities.js';
import { getDealsByCompany } from '../deals.js';
import { dbGetAll }           from '../db.js';
import { can, ROLES, getSession } from '../auth.js';

// ── Справочники (только для этой страницы) ────────────────────────────────────

const REGIONS = [
  'Москва','СПб','Центр','Юг','Урал',
  'Сибирь','Дальний Восток','Беларусь','Казахстан','Китай','ЕС','Турция',
];
const CARGO_T = [
  {v:'general',l:'Генеральный'},{v:'bulk',l:'Насыпной'},{v:'oversize',l:'Негабарит'},
  {v:'adr',l:'Опасные ADR'},{v:'reefer',l:'Рефрижератор'},
  {v:'valuable',l:'Ценный груз'},{v:'docs',l:'Документы'},{v:'other_cargo',l:'Другое'},
];
const DIRS = [
  {v:'road',l:'Авто'},{v:'sea',l:'Море'},{v:'air',l:'Авиа'},{v:'rail',l:'ЖД'},
  {v:'multimodal',l:'Мультимодал'},{v:'customs',l:'Таможня'},{v:'warehouse',l:'Склад'},
];
const SOURCES = [
  {v:'cold_call',l:'Холодный звонок'},{v:'inbound',l:'Входящий'},
  {v:'referral',l:'Реферал'},{v:'exhibition',l:'Выставка'},
  {v:'tender',l:'Тендер'},{v:'other_src',l:'Другое'},
];
const FREQS = [
  {v:'one_time_f',l:'Разовые'},{v:'few_per_year',l:'Несколько раз в год'},
  {v:'monthly',l:'Ежемесячные'},{v:'weekly',l:'Еженедельные'},
];
const POTENTIALS = [
  {v:'one_time',l:'Разовый'},{v:'regular',l:'Регулярный'},
  {v:'tender_p',l:'Тендерный'},{v:'strategic',l:'Стратегический'},
];
const REGION_MAP = {
  'Москва':'Москва','Московская':'Москва',
  'Санкт-Петербург':'СПб','Ленинградская':'СПб',
  'Краснодарский':'Юг','Ростовская':'Юг','Крым':'Юг','Астраханская':'Юг',
  'Свердловская':'Урал','Челябинская':'Урал','Тюменская':'Урал','Пермский':'Урал',
  'Новосибирская':'Сибирь','Красноярский':'Сибирь','Омская':'Сибирь','Иркутская':'Сибирь',
  'Приморский':'Дальний Восток','Хабаровский':'Дальний Восток','Амурская':'Дальний Восток',
};

// SVG-иконки активностей
const ACT_SVG = {
  call_out:  '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.19 12 19.79 19.79 0 0 1 1.12 3.38 2 2 0 0 1 3.11 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.09 8.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 21 16.92z"/>',
  email_out: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>',
  meeting:   '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  task:      '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  proposal:  '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>',
  note:      '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
};
ACT_SVG.call_in = ACT_SVG.call_out;
ACT_SVG.email_in = ACT_SVG.email_out;

// ── Alpine-компонент ──────────────────────────────────────────────────────────

Alpine.data('companyPage', () => ({

  // ── Состояние страницы ────────────────────────────────────────────────────
  loading:   true,
  isNew:     false,
  isEditing: false,
  activeTab: 'overview',

  // ── Данные ───────────────────────────────────────────────────────────────
  company:   null,
  users:     [],
  contacts:  [],
  deals:     [],
  activities:[],

  // ── Справочники (доступны в шаблоне через x-bind / x-text) ───────────────
  REGIONS, CARGO_T, DIRS, SOURCES, FREQS, POTENTIALS,
  SEGMENT_LABELS, SEGMENT_COLORS, PRIORITY_LABELS,
  CONTACT_ROLE_LABELS,
  ACTIVITY_TYPE_LABELS,

  // ── INN lookup ────────────────────────────────────────────────────────────
  innStatus:  '',
  innStatusOk: false,
  innLoading:  false,
  innDupError: null,

  // ── Черновик (автосохранение в sessionStorage) ────────────────────────────
  _saveTimer:  null,
  draftState:  '',  // '' | 'saving' | 'saved'

  // ── Ввод тегов ────────────────────────────────────────────────────────────
  tagInput: '',

  // ── Форма новой активности ────────────────────────────────────────────────
  newAct: {
    type: 'call_out', occurred_at: '',
    contact_id: '', description: '', next_step: '', next_step_due: '',
  },

  // ── Модальное окно контакта ───────────────────────────────────────────────
  ctModal: {
    open: false, isEdit: false, id: '',
    first_name: '', last_name: '', position: '', role: 'unknown',
    phone_main: '', email: '', telegram: '', whatsapp: '',
    preferred_channel: '', notes: '',
  },

  // ── Вычисляемые свойства ──────────────────────────────────────────────────

  get companyTitle() {
    if (!this.company) return '…';
    return (this.isNew && !this.company.name) ? 'Новая компания' : (this.company.name || '—');
  },
  get segColor() {
    return SEGMENT_COLORS[this.company?.segment] || 'gray';
  },
  get owner() {
    return this.users.find(u => u.id === this.company?.owner_id);
  },
  get ownerName() {
    const o = this.owner;
    if (!o) return '—';
    return [o.first_name, o.last_name].filter(Boolean).join(' ') || o.email;
  },
  get isNextActionOverdue() {
    const d = this.company?.next_action_at;
    return d && d < todayStr();
  },
  get canDelete() {
    return can([ROLES.ADMIN, ROLES.HEAD]);
  },

  // Словари для режима просмотра
  get srcDict()  { return Object.fromEntries(SOURCES.map(o => [o.v, o.l])); },
  get freqDict() { return Object.fromEntries(FREQS.map(o => [o.v, o.l])); },
  get potDict()  { return Object.fromEntries(POTENTIALS.map(o => [o.v, o.l])); },
  get cargoDict(){ return Object.fromEntries(CARGO_T.map(o => [o.v, o.l])); },
  get dirDict()  { return Object.fromEntries(DIRS.map(o => [o.v, o.l])); },

  // ── Инициализация ─────────────────────────────────────────────────────────

  async init() {
    const params    = new URLSearchParams(location.search);
    this.isNew      = params.has('new');
    const wantEdit  = params.has('edit');
    const companyId = params.get('id');

    const session = await initUI({ active: 'companies' });
    if (!session) return;

    this.users = await dbGetAll('users').catch(() => []);

    if (this.isNew) {
      this.company   = this._freshCompany(session, params);
      this.isEditing = true;
      this.loading   = false;
      this._resetActForm();
      setTimeout(() => document.querySelector('[data-fld-name]')?.focus(), 80);
      return;
    }

    if (!companyId) { location.href = '/companies.html'; return; }

    try {
      this.company = await getCompany(companyId);
      if (!this.company) {
        toast('Компания не найдена', 'error');
        setTimeout(() => location.href = '/companies.html', 1500);
        return;
      }
      this.isEditing = wantEdit;
      this.loading   = false;
      this._resetActForm();

      // Параллельно загружаем контакты и активности
      await Promise.all([this._loadContacts(), this._loadActivities()]);

      // Восстановить черновик
      if (this.isEditing) this._restoreDraft();
    } catch(err) {
      toast(err.message, 'error');
      setTimeout(() => location.href = '/companies.html', 1500);
    }
  },

  _freshCompany(session, params) {
    return {
      id: null, name: '', inn: '', ogrn: '', website: '',
      address_legal: '', address_actual: '',
      regions: [], industry: '', description: '',
      segment: params.get('segment') || 'cold_lead',
      cargo_types: [], directions: [], routes: [],
      shipment_freq: '', volume_monthly: '', potential: '',
      current_carrier: '', switch_reason: '',
      owner_id: session.id, source: '', priority: 'medium',
      tags: [], next_action_at: '', next_action_type: '',
      first_contact_at: new Date().toISOString().split('T')[0],
    };
  },

  // ── Режим редактирования ──────────────────────────────────────────────────

  startEdit() {
    this.isEditing   = true;
    this.innDupError = null;
  },

  async cancelEdit() {
    if (this.isNew) {
      if (confirm('Отменить создание?')) location.href = '/companies.html';
      return;
    }
    this._clearDraft();
    this.isEditing   = false;
    this.innDupError = null;
    // Перечитываем из API — сбрасываем несохранённые изменения
    this.company = await getCompany(this.company.id).catch(() => this.company);
  },

  // ── Сохранение ───────────────────────────────────────────────────────────

  async save() {
    // Валидация ИНН на фронтенде — точные сообщения как в оригинале
    const inn = (this.company.inn || '').replace(/\D/g, '');
    if (!inn) {
      toast('Введите ИНН', 'error');
      return;
    }
    if (inn.length !== 10 && inn.length !== 12) {
      toast('ИНН должен содержать 10 или 12 цифр', 'error');
      return;
    }

    try {
      if (this.isNew) {
        const c = await createCompany(this.company);
        this._clearDraft();
        toast('Компания создана', 'success');
        location.href = `/company.html?id=${c.id}`;
      } else {
        this.company = await updateCompany(this.company.id, this.company);
        this._clearDraft();
        this.isEditing   = false;
        this.innDupError = null;
        toast('Сохранено', 'success');
      }
    } catch(err) {
      if (err.existing_id) {
        // Дубль ИНН — Alpine показывает баннер через innDupError
        this.innDupError = err;
      } else {
        toast(err.message, 'error');
      }
    }
  },

  // ── Удаление ─────────────────────────────────────────────────────────────

  async deleteComp() {
    if (!confirm(`Удалить компанию «${this.company.name}»?`)) return;
    try {
      await deleteCompany(this.company.id);
      toast('Удалено');
      setTimeout(() => location.href = '/companies.html', 600);
    } catch(err) { toast(err.message, 'error'); }
  },

  // ── Чипы (JSONB-массивы) ─────────────────────────────────────────────────

  toggleChip(field, value) {
    const arr = [...(this.company[field] || [])];
    const i   = arr.indexOf(value);
    if (i === -1) arr.push(value); else arr.splice(i, 1);
    this.company[field] = arr;
    this._scheduleSave();
  },
  isChip(field, value) {
    return (this.company[field] || []).includes(value);
  },

  // ── Маршруты ─────────────────────────────────────────────────────────────

  addRoute() {
    this.company.routes = [...(this.company.routes || []), { from: '', to: '' }];
    this._scheduleSave();
  },
  removeRoute(i) {
    const r = [...(this.company.routes || [])];
    r.splice(i, 1);
    this.company.routes = r;
    this._scheduleSave();
  },

  // ── Теги ─────────────────────────────────────────────────────────────────

  addTag() {
    const v = this.tagInput.trim().replace(/^#/, '');
    if (v && !(this.company.tags || []).includes(v)) {
      this.company.tags = [...(this.company.tags || []), v];
      this._scheduleSave();
    }
    this.tagInput = '';
  },
  removeTag(tag) {
    this.company.tags = (this.company.tags || []).filter(t => t !== tag);
    this._scheduleSave();
  },

  // ── Поиск по ИНН (DaData) ────────────────────────────────────────────────

  async lookupInn() {
    const inn = (this.company.inn || '').replace(/\D/g, '');
    if (!inn) {
      this.innStatus   = 'Введите ИНН';
      this.innStatusOk = false;
      return;
    }
    if (!/^\d{10}$|^\d{12}$/.test(inn)) {
      this.innStatus   = 'ИНН — 10 или 12 цифр';
      this.innStatusOk = false;
      return;
    }
    this.innLoading  = true;
    this.innStatus   = '⏳ Ищем…';
    this.innStatusOk = false;
    try {
      const res  = await fetch(`/api/lookup/inn/${inn}`, { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка');
      this._applyLookupResult(data);
      const warn = data.status === 'LIQUIDATED'    ? ' ⚠️ ЛИКВИДИРОВАНА'
                 : data.status === 'LIQUIDATING'   ? ' ⚠️ В процессе ликвидации'
                 : '';
      this.innStatus   = `✓ Найдено: ${data.name}${warn}`;
      this.innStatusOk = true;
      toast('Данные загружены из реестра', 'success');
    } catch(err) {
      this.innStatus   = '✗ ' + err.message;
      this.innStatusOk = false;
    } finally {
      this.innLoading = false;
    }
  },

  _applyLookupResult(data) {
    if (!this.company.name || this.company.name === 'Новая компания')
      this.company.name = data.name;
    if (data.ogrn)           this.company.ogrn = data.ogrn;
    if (data.address_legal)  { this.company.address_legal = data.address_legal; this.company.address_actual = data.address_legal; }
    if (data.industry)       this.company.industry = data.industry;

    // Регион → чип
    if (data.region) {
      const key  = Object.keys(REGION_MAP).find(k => data.region.includes(k));
      const chip = key ? REGION_MAP[key] : null;
      if (chip) {
        const regions = [...(this.company.regions || [])];
        if (!regions.includes(chip)) this.company.regions = [...regions, chip];
      }
    }
    // Теги: директор и ОКВЭД
    const tags = [...(this.company.tags || [])];
    if (data.director_name && !tags.includes(data.director_name)) tags.push(data.director_name);
    if (data.okved) { const t = 'ОКВЭД ' + data.okved; if (!tags.includes(t)) tags.push(t); }
    this.company.tags = tags;
    this._scheduleSave();
  },

  // ── Вкладки ───────────────────────────────────────────────────────────────

  async switchTab(tab) {
    this.activeTab = tab;
    // Сделки грузим при первом открытии вкладки
    if (tab === 'deals' && !this.deals.length && this.company?.id) {
      await this._loadDeals();
    }
  },

  // ── Контакты ─────────────────────────────────────────────────────────────

  async _loadContacts() {
    if (!this.company?.id) return;
    this.contacts = await getContacts(this.company.id).catch(() => []);
  },

  contactFullName(c) {
    return [c.first_name, c.last_name].filter(Boolean).join(' ') || '—';
  },
  contactInitials(c) {
    return ((c.first_name?.[0] || '') + (c.last_name?.[0] || '')).toUpperCase() || '?';
  },
  contactRoleColor(role) {
    return role === 'lpr' ? 'red' : role === 'blocker' ? 'orange' : 'gray';
  },

  openContactModal(c = null) {
    this.ctModal = {
      open: true, isEdit: !!c, id: c?.id || '',
      first_name: c?.first_name || '', last_name: c?.last_name || '',
      position:   c?.position || '',   role:       c?.role || 'unknown',
      phone_main: c?.phone_main || '',  email:      c?.email || '',
      telegram:   c?.telegram || '',    whatsapp:   c?.whatsapp || '',
      preferred_channel: c?.preferred_channel || '',
      notes: c?.notes || '',
    };
    // Фокус на первое поле
    setTimeout(() => this.$el.querySelector('#ctFirst')?.focus(), 60);
  },
  closeContactModal() { this.ctModal.open = false; },

  async saveContact() {
    if (!this.ctModal.first_name.trim()) { toast('Введите имя', 'error'); return; }
    const d = {
      company_id:        this.company.id,
      first_name:        this.ctModal.first_name,
      last_name:         this.ctModal.last_name,
      position:          this.ctModal.position,
      role:              this.ctModal.role,
      phone_main:        this.ctModal.phone_main,
      email:             this.ctModal.email,
      telegram:          this.ctModal.telegram,
      whatsapp:          this.ctModal.whatsapp,
      preferred_channel: this.ctModal.preferred_channel,
      notes:             this.ctModal.notes,
    };
    try {
      if (this.ctModal.id) await updateContact(this.ctModal.id, d);
      else                 await createContact(d);
      this.closeContactModal();
      await this._loadContacts();
      toast(this.ctModal.id ? 'Обновлён' : 'Добавлен', 'success');
    } catch(err) { toast(err.message, 'error'); }
  },

  async removeContact(id) {
    if (!confirm('Удалить контакт?')) return;
    try {
      await deleteContact(id);
      await this._loadContacts();
      toast('Удалён');
    } catch(err) { toast(err.message, 'error'); }
  },

  // ── Сделки ────────────────────────────────────────────────────────────────

  async _loadDeals() {
    if (!this.company?.id) return;
    this.deals = await getDealsByCompany(this.company.id).catch(() => []);
  },

  dealOutcomeColor(o) {
    return o === 'won' ? 'green' : o === 'lost' ? 'red' : o === 'postponed' ? 'orange' : 'gray';
  },
  dealOutcomeLabel(o) {
    return { in_progress:'В работе', won:'Выиграна', lost:'Проиграна', postponed:'Отложена' }[o] || o;
  },

  // ── Активности ────────────────────────────────────────────────────────────

  _resetActForm() {
    const n  = new Date();
    const tz = n.getTime() - n.getTimezoneOffset() * 60000;
    this.newAct = {
      type: 'call_out',
      occurred_at: new Date(tz).toISOString().slice(0, 16),
      contact_id: '', description: '', next_step: '', next_step_due: '',
    };
  },

  async _loadActivities() {
    if (!this.company?.id) return;
    this.activities = await getActivitiesByCompany(this.company.id).catch(() => []);
  },

  async submitActivity() {
    if (!this.company?.id) { toast('Сначала сохраните компанию', 'error'); return; }
    try {
      await createActivity({
        company_id:   this.company.id,
        type:         this.newAct.type,
        occurred_at:  this.newAct.occurred_at
          ? new Date(this.newAct.occurred_at).toISOString()
          : new Date().toISOString(),
        contact_id:   this.newAct.contact_id || null,
        description:  this.newAct.description,
        next_step:    this.newAct.next_step,
        next_step_due:this.newAct.next_step_due || null,
      });
      this._resetActForm();
      await this._loadActivities();
      toast('Добавлено', 'success');
    } catch(err) { toast(err.message, 'error'); }
  },

  async removeActivity(id) {
    if (!confirm('Удалить активность?')) return;
    try {
      await deleteActivity(id);
      await this._loadActivities();
      toast('Удалено');
    } catch(err) { toast(err.message, 'error'); }
  },

  async toggleDone(id) {
    try {
      const a = this.activities.find(x => x.id === id);
      if (!a) return;
      await markDone(id, !a.is_done);
      await this._loadActivities();
    } catch(err) { toast(err.message, 'error'); }
  },

  actColor(type) {
    return ACTIVITY_TYPE_COLORS?.[type] ||
      { call_out:'teal', call_in:'teal', email_out:'blue', email_in:'blue',
        meeting:'orange', task:'red', proposal:'green', note:'gray' }[type] || 'gray';
  },
  actIconSvg(type) {
    const p = ACT_SVG[type] || ACT_SVG.note;
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${p}</svg>`;
  },
  actContactName(contact_id) {
    const c = this.contacts.find(x => x.id === contact_id);
    return c ? this.contactFullName(c) : '';
  },
  actIsOverdue(a) {
    return !!(a.next_step_due && a.next_step_due < todayStr() && !a.is_done);
  },

  // ── Черновик ─────────────────────────────────────────────────────────────

  _draftKey() { return `lcrm:draft:${this.isNew ? 'new' : this.company?.id}`; },

  _scheduleSave() {
    if (!this.isEditing) return;
    this.draftState = 'saving';
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try { sessionStorage.setItem(this._draftKey(), JSON.stringify(this.company)); } catch {}
      this.draftState = 'saved';
    }, 600);
  },

  _clearDraft() {
    try { sessionStorage.removeItem(this._draftKey()); } catch {}
    this.draftState = '';
  },

  _restoreDraft() {
    try {
      const raw = sessionStorage.getItem(this._draftKey());
      if (raw && confirm('Найден черновик. Восстановить?')) {
        this.company = { ...this.company, ...JSON.parse(raw) };
      } else {
        this._clearDraft();
      }
    } catch {}
  },

  // ── Утилиты шаблона ───────────────────────────────────────────────────────

  fmtDate(s)     { return fmtDate(s); },
  fmtDateTime(s) { return fmtDateTime(s); },
  escVal(s)      { return s || ''; }, // Alpine x-text автоматически экранирует
}));

window.Alpine = Alpine;
Alpine.start();
