/**
 * js/pages/plans.js — Alpine-компонент страницы планов продаж
 *
 * Для admin/head:
 *   • Таблица планов команды с inline-редактированием
 *   • Кнопка «Скопировать с предыдущего месяца»
 *   • Навигация по месяцам
 *
 * Для manager/ops — редирект (initUI с roles: ['admin','head'] закроет доступ).
 */

import Alpine from 'alpinejs';
import { initUI, toast } from '../ui.js';

const MONTHS = [
  'Январь','Февраль','Март','Апрель','Май','Июнь',
  'Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь',
];

const FIELDS = [
  { key: 'target_revenue',       label: 'Выручка, ₽', isRevenue: true },
  { key: 'target_deals_won',     label: 'Сделок' },
  { key: 'target_activities',    label: 'Активностей' },
  { key: 'target_calls',         label: 'Звонков' },
  { key: 'target_meetings',      label: 'Встреч' },
  { key: 'target_proposals',     label: 'КП' },
  { key: 'target_new_companies', label: 'Компаний' },
];

const FACT_KEYS = {
  target_revenue: 'revenue', target_deals_won: 'deals_won',
  target_activities: 'activities', target_calls: 'calls',
  target_meetings: 'meetings', target_proposals: 'proposals',
  target_new_companies: 'new_companies',
};

Alpine.data('plansPage', () => ({
  // ── Состояние ─────────────────────────────────────────────────────────────
  loading:   true,
  year:      new Date().getFullYear(),
  month:     new Date().getMonth() + 1,
  users:     [],
  plans:     [],   // [{user_id, target_*, fact: {...}}]

  // Состояние копирования
  copying:   false,
  copyModal: false,
  copyFrom:  { year: 0, month: 0 },

  // Индивидуальные состояния сохранения: { 'userId:field': 'saving'|'saved'|'' }
  saveState: {},

  // Таймеры автосохранения
  _timers: {},

  // ── Инициализация ──────────────────────────────────────────────────────────

  async init() {
    const session = await initUI({ active: 'plans', roles: ['admin', 'head'] });
    if (!session) return;
    await this.load();
  },

  // ── Навигация ─────────────────────────────────────────────────────────────

  get monthTitle() {
    return `${MONTHS[this.month - 1]} ${this.year}`;
  },

  prevMonth() {
    if (--this.month < 1) { this.month = 12; this.year--; }
    this.load();
  },
  nextMonth() {
    if (++this.month > 12) { this.month = 1; this.year++; }
    this.load();
  },

  // ── Загрузка ──────────────────────────────────────────────────────────────

  async load() {
    this.loading = true;
    try {
      const [usersRes, plansRes] = await Promise.all([
        fetch('/api/users', { credentials: 'include' }).then(r => r.json()).catch(() => []),
        fetch(`/api/plans?year=${this.year}&month=${this.month}`, { credentials: 'include' }).then(r => r.json()).catch(() => []),
      ]);

      this.users = (usersRes || []).filter(u => u.is_active && u.role !== 'admin');
      this.plans = plansRes || [];
    } finally {
      this.loading = false;
    }
  },

  // ── Вспомогательные геттеры ────────────────────────────────────────────────

  get fields() { return FIELDS; },

  get now() { return new Date(); },

  // Процент прошедших дней текущего месяца (для окрашивания прогресса)
  get monthPct() {
    const now     = new Date();
    const total   = new Date(this.year, this.month, 0).getDate();
    const isThis  = this.year === now.getFullYear() && this.month === now.getMonth() + 1;
    const passed  = isThis ? now.getDate() : total;
    return Math.round(passed / total * 100);
  },

  // Найти план по user_id
  planFor(userId) {
    return this.plans.find(p => p.user_id === userId) || null;
  },

  // Получить целевое значение поля
  targetVal(userId, field) {
    const p = this.planFor(userId);
    return p ? (Number(p[field]) || 0) : 0;
  },

  // Получить фактическое значение
  factVal(userId, field) {
    const p = this.planFor(userId);
    if (!p?.fact) return null;
    return Number(p.fact[FACT_KEYS[field]] || 0);
  },

  // Процент выполнения
  pct(userId, field) {
    const t = this.targetVal(userId, field);
    const f = this.factVal(userId, field);
    if (f === null || t === 0) return null;
    return Math.min(Math.round(f / t * 100), 999);
  },

  // CSS-класс для цвета прогресса
  pctClass(pct) {
    if (pct === null) return 'f-none';
    const mp = this.monthPct;
    if (pct >= 100)        return 'f-great';
    if (pct >= mp)         return 'f-ok';
    if (pct >= mp * 0.7)   return 'f-warn';
    return 'f-bad';
  },

  // Цвет минибара
  pctColor(pct) {
    if (pct === null) return 'var(--surface-off)';
    const mp = this.monthPct;
    if (pct >= 100)      return 'var(--success)';
    if (pct >= mp)       return 'var(--primary)';
    if (pct >= mp * 0.7) return 'var(--warning)';
    return 'var(--error)';
  },

  // Форматирование числа
  fmtNum(n, field) {
    n = Number(n || 0);
    if (field === 'target_revenue') {
      if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
      if (n >= 1_000)     return (n / 1_000).toFixed(0) + 'K';
    }
    return String(n);
  },

  // Имя пользователя
  userName(u) {
    return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email;
  },

  // Ключ для saveState
  stateKey(userId, field) { return `${userId}:${field}`; },

  // ── Редактирование ────────────────────────────────────────────────────────

  // Вызывается при input в ячейке
  onInput(userId, field) {
    const key = this.stateKey(userId, field);
    this.saveState[key] = 'saving';
    clearTimeout(this._timers[key]);
    this._timers[key] = setTimeout(() => this.savePlan(userId, field), 800);
  },

  // Вызывается при blur
  onBlur(userId, field) {
    const key = this.stateKey(userId, field);
    clearTimeout(this._timers[key]);
    this.savePlan(userId, field);
  },

  // Получить значение из DOM-инпута
  _getInputVal(userId, field) {
    const inp = document.querySelector(`[data-uid="${userId}"][data-field="${field}"]`);
    return inp ? (parseInt(inp.value) || 0) : 0;
  },

  // Сохранить план пользователя (собирает все его поля из DOM)
  async savePlan(userId, changedField) {
    const key  = this.stateKey(userId, changedField);
    const data = { user_id: userId, year: this.year, month: this.month };

    FIELDS.forEach(f => {
      data[f.key] = this._getInputVal(userId, f.key);
    });

    this.saveState[key] = 'saving';
    try {
      const res = await fetch('/api/plans', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error((await res.json()).error);

      const updated = await res.json();
      const idx = this.plans.findIndex(p => p.user_id === userId);
      if (idx >= 0) this.plans[idx] = { ...this.plans[idx], ...updated };
      else          this.plans.push(updated);

      this.saveState[key] = 'saved';
      setTimeout(() => { this.saveState[key] = ''; }, 1500);
    } catch (err) {
      this.saveState[key] = '';
      toast('Ошибка сохранения: ' + err.message, 'error');
    }
  },

  // ── Копирование с предыдущего месяца ──────────────────────────────────────

  openCopyModal() {
    // По умолчанию предлагаем предыдущий месяц
    let y = this.year, m = this.month - 1;
    if (m < 1) { m = 12; y--; }
    this.copyFrom = { year: y, month: m };
    this.copyModal = true;
  },

  get copyFromTitle() {
    return `${MONTHS[this.copyFrom.month - 1]} ${this.copyFrom.year}`;
  },

  async confirmCopy() {
    this.copying = true;
    try {
      const res = await fetch('/api/plans/copy-month', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from_year:  this.copyFrom.year,
          from_month: this.copyFrom.month,
          to_year:    this.year,
          to_month:   this.month,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      this.copyModal = false;
      toast(data.message, 'success');
      await this.load();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      this.copying = false;
    }
  },
}));

window.Alpine = Alpine;
Alpine.start();
