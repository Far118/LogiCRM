/**
 * js/pages/activities.js
 *
 * Alpine-компонент страницы активностей.
 * Вся бизнес-логика берётся из существующих модулей — они не изменены:
 *   activities.js, companies.js, ui.js, auth.js, db.js
 *
 * Этот файл только:
 *   1. Запускает Alpine.js
 *   2. Регистрирует компонент `activitiesPage` через Alpine.data()
 *   3. Инициализирует страницу через существующий initUI()
 */

import Alpine from 'alpinejs';

import { initUI, toast, fmtDate, fmtDateTime, todayStr } from '../ui.js';
import {
  getMyActivities, deleteActivity, markDone,
  ACTIVITY_TYPE_LABELS, ACTIVITY_TYPE_COLORS,
} from '../activities.js';
import { getCompanies } from '../companies.js';

// ── SVG-иконки типов активностей ─────────────────────────────────────────────

const ACT_SVG = {
  call_out:  '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.19 12 19.79 19.79 0 0 1 1.12 3.38 2 2 0 0 1 3.11 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.09 8.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 21 16.92z"/>',
  email_out: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>',
  meeting:   '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  task:      '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  proposal:  '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>',
  note:      '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
};
ACT_SVG.call_in  = ACT_SVG.call_out;
ACT_SVG.email_in = ACT_SVG.email_out;

// ── Alpine-компонент ──────────────────────────────────────────────────────────

Alpine.data('activitiesPage', () => ({
  // ─── Состояние ───────────────────────────────────────────────────────────

  all:       [],   // все активности с сервера
  companies: [],   // для резолва имён компаний
  loading:   true,

  filters: {
    q:        '',
    type:     '',
    done:     '',
    dateFrom: '',
    dateTo:   '',
  },

  // ─── Инициализация ────────────────────────────────────────────────────────

  async init() {
    // initUI проверяет сессию, рисует сайдбар — всё как в оригинале
    const session = await initUI({ active: 'activities' });
    if (!session) return;

    await this.load();

    // Debounced-вотчер на текстовый поиск
    this.$watch('filters.q', () => {});
  },

  // ─── Загрузка данных ──────────────────────────────────────────────────────

  async load() {
    this.loading = true;
    try {
      [this.all, this.companies] = await Promise.all([
        getMyActivities(),
        getCompanies(),
      ]);
    } finally {
      this.loading = false;
    }
  },

  // ─── Вычисляемые свойства (геттеры) ──────────────────────────────────────

  get today() {
    return todayStr();
  },

  get compById() {
    return Object.fromEntries(this.companies.map(c => [c.id, c]));
  },

  /** Отфильтрованный список — вычисляется реактивно при изменении filters */
  get filtered() {
    const { q, type, done, dateFrom, dateTo } = this.filters;
    const today = this.today;

    return this.all.filter(a => {
      if (q) {
        const hay = `${a.description} ${a.next_step} ${a.outcome}`.toLowerCase();
        if (!hay.includes(q.toLowerCase())) return false;
      }
      if (type && a.type !== type) return false;
      if (done === 'open'    && !(a.next_step && !a.is_done))                          return false;
      if (done === 'done'    && !a.is_done)                                            return false;
      if (done === 'overdue' && !(a.next_step_due && a.next_step_due < today && !a.is_done)) return false;
      if (dateFrom && (a.occurred_at || '') < dateFrom)                               return false;
      if (dateTo   && (a.occurred_at || '') > dateTo + 'T23:59:59')                   return false;
      return true;
    });
  },

  /** Сгруппированный по дням список для x-for в шаблоне */
  get groups() {
    const map = {};
    this.filtered.forEach(a => {
      const day = (a.occurred_at || '').split('T')[0] || 'unknown';
      (map[day] = map[day] || []).push(a);
    });
    return Object.keys(map)
      .sort((a, b) => b.localeCompare(a))
      .map(day => ({
        day,
        isToday: day === this.today,
        label: day === this.today
          ? 'Сегодня'
          : new Date(day + 'T00:00:00').toLocaleDateString('ru-RU', {
              weekday: 'long', day: '2-digit', month: 'long',
            }),
        items: map[day],
      }));
  },

  // ─── Вспомогательные методы для шаблона ──────────────────────────────────

  iconColor(type) {
    return ACTIVITY_TYPE_COLORS[type] || 'gray';
  },

  iconSvg(type) {
    const path = ACT_SVG[type] || ACT_SVG.note;
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${path}</svg>`;
  },

  typeLabel(type) {
    return ACTIVITY_TYPE_LABELS[type] || type;
  },

  compName(id) {
    return this.compById[id]?.name || '';
  },

  compLink(id) {
    return `/company.html?id=${id}`;
  },

  fmtDate(s)     { return fmtDate(s); },
  fmtDateTime(s) { return fmtDateTime(s); },

  isOverdue(a) {
    return !!(a.next_step_due && a.next_step_due < this.today && !a.is_done);
  },

  // ─── Действия ────────────────────────────────────────────────────────────

  async toggleDone(activity) {
    try {
      await markDone(activity.id, !activity.is_done);
      await this.load();
    } catch (err) {
      toast(err.message, 'error');
    }
  },

  async remove(id) {
    if (!confirm('Удалить активность?')) return;
    try {
      await deleteActivity(id);
      await this.load();
      toast('Удалено');
    } catch (err) {
      toast(err.message, 'error');
    }
  },
}));

// Запускаем Alpine после регистрации всех компонентов
window.Alpine = Alpine;
Alpine.start();
