/**
 * js/pages/dashboard.js
 *
 * Alpine-компонент дашборда: статистика, задачи, мини-календарь,
 * управление push-уведомлениями.
 *
 * Регистрирует Alpine.data('dashboardPage') и запускает Alpine.
 */

import Alpine from 'alpinejs';

import { initUI, fmtDate, todayStr, esc, toast } from '../ui.js';
import { getCompanies, SEGMENT_LABELS, SEGMENT_COLORS } from '../companies.js';
import { getMyActivities } from '../activities.js';
import { dbGetAll } from '../db.js';
import { can, ROLES } from '../auth.js';

const MONTHS_RU = [
  'Январь','Февраль','Март','Апрель','Май','Июнь',
  'Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь',
];
const DOW_RU = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];

// ── Alpine-компонент ──────────────────────────────────────────────────────────

Alpine.data('dashboardPage', () => ({

  // ── Состояние ────────────────────────────────────────────────────────────
  session:    null,
  loading:    true,
  activities: [],
  companies:  [],
  planData:   null,

  // Статистика
  stats: { overdue: 0, today: 0, week: 0, companies: 0 },

  // Приветствие
  greetTitle: '',
  greetSub:   '',

  // Задачи
  overdueTasks: [],
  todayTasks:   [],
  weekTasks:    [],

  // Свежие компании
  freshCompanies: [],

  // Активность за неделю
  weekActivity: {},

  // ── Мини-календарь ───────────────────────────────────────────────────────
  calYear:     new Date().getFullYear(),
  calMonth:    new Date().getMonth(),  // 0-based
  calSelected: null,   // выбранная дата 'YYYY-MM-DD'

  // ── Push-уведомления ─────────────────────────────────────────────────────
  pushSupported:   false,
  pushSubscribed:  false,
  pushLoading:     false,
  pushPermission:  'default', // 'default' | 'granted' | 'denied'
  swRegistration:  null,

  // ── Инициализация ─────────────────────────────────────────────────────────

  async init() {
    this.session = await initUI({ active: 'dashboard' });
    if (!this.session) return;

    // Приветствие
    const h = new Date().getHours();
    const g = h < 6 ? 'Доброй ночи' : h < 12 ? 'Доброе утро' : h < 17 ? 'Добрый день' : 'Добрый вечер';
    this.greetTitle = `${g}, ${this.session.first_name || this.session.email.split('@')[0]}!`;

    // Клавиатурные шорткаты (только вне полей ввода)
    document.addEventListener('keydown', e => {
      if (e.target.matches('input,textarea,select')) return;
      if (e.key === 'n' || e.key === 'т') location.href = '/companies.html?new=1';
      if (e.key === '/') { e.preventDefault(); location.href = '/companies.html'; }
      if (e.key === 'd' || e.key === 'в') location.href = '/deals.html?new=1';
    });

    // Грузим данные параллельно
    const [activities, companies, planData] = await Promise.all([
      getMyActivities(),
      getCompanies(),
      this._loadPlan(),
    ]);
    this.activities = activities;
    this.companies  = companies;
    this.planData   = planData;

    this._computeStats();
    this._computeGreetSub();
    this._computeFresh();
    this._computeWeekActivity();

    this.loading = false;

    // Push — после загрузки основных данных
    this._initPush();
  },

  // ── Загрузка плана ────────────────────────────────────────────────────────

  async _loadPlan() {
    try {
      const now = new Date();
      const res = await fetch(
        `/api/plans/my?year=${now.getFullYear()}&month=${now.getMonth() + 1}`,
        { credentials: 'include' }
      );
      return res.ok ? await res.json() : null;
    } catch { return null; }
  },

  // ── Вычисление статистики ─────────────────────────────────────────────────

  _computeStats() {
    const today   = todayStr();
    const weekEnd = (() => {
      const d = new Date();
      d.setDate(d.getDate() + 7);
      return d.toISOString().split('T')[0];
    })();

    const tasks = this.activities.filter(a => a.next_step && a.next_step_due && !a.is_done);

    this.overdueTasks = tasks
      .filter(a => a.next_step_due < today)
      .sort((a, b) => a.next_step_due.localeCompare(b.next_step_due));
    this.todayTasks   = tasks.filter(a => a.next_step_due === today);
    this.weekTasks    = tasks
      .filter(a => a.next_step_due > today && a.next_step_due <= weekEnd)
      .sort((a, b) => a.next_step_due.localeCompare(b.next_step_due));

    this.stats = {
      overdue:   this.overdueTasks.length,
      today:     this.todayTasks.length,
      week:      this.weekTasks.length,
      companies: this.companies.length,
    };
  },

  _computeGreetSub() {
    const parts = [];
    if (this.stats.overdue) parts.push(`<strong style="color:var(--error)">${this.stats.overdue} просрочено</strong>`);
    if (this.stats.today)   parts.push(`${this.stats.today} на сегодня`);
    if (!parts.length)      parts.push('всё под контролем ✓');
    this.greetSub = parts.join(' · ');
  },

  _computeFresh() {
    this.freshCompanies = [...this.companies]
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
      .slice(0, 5);
  },

  _computeWeekActivity() {
    const weekAgo = (() => {
      const d = new Date();
      d.setDate(d.getDate() - 7);
      return d.toISOString();
    })();
    const myWeek = this.activities.filter(a => a.occurred_at && a.occurred_at >= weekAgo);
    this.weekActivity = {
      calls:     myWeek.filter(a => ['call_out','call_in'].includes(a.type)).length,
      emails:    myWeek.filter(a => ['email_out','email_in'].includes(a.type)).length,
      meetings:  myWeek.filter(a => a.type === 'meeting').length,
      proposals: myWeek.filter(a => a.type === 'proposal').length,
    };
  },

  // ── Вычисляемые свойства ──────────────────────────────────────────────────

  get weekTotal() {
    return Object.values(this.weekActivity).reduce((s, v) => s + v, 0);
  },

  get compByIdMap() {
    return Object.fromEntries(this.companies.map(c => [c.id, c]));
  },

  get compLabel() {
    return can([ROLES.MANAGER]) ? 'Моих компаний' : 'Всего компаний';
  },

  // ── ПЛАН ─────────────────────────────────────────────────────────────────

  get planMonth() {
    const now = new Date();
    return `${MONTHS_RU[now.getMonth()]} ${now.getFullYear()}`;
  },
  get planRows() {
    if (!this.planData?.plan) return [];
    const { plan, fact, progress } = this.planData;
    const now = new Date();
    const daysTotal  = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const monthPct   = Math.round(now.getDate() / daysTotal * 100);
    const fmtRub = n => {
      n = Number(n || 0);
      if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + ' млн';
      if (n >= 1_000)     return (n / 1_000).toFixed(0) + ' тыс';
      return String(n);
    };
    return [
      { label:'💰 Выручка',     pct: progress.revenue,       nums: fmtRub(fact.revenue) + ' / ' + fmtRub(plan.target_revenue) + ' ₽' },
      { label:'🏆 Сделок',      pct: progress.deals_won,      nums: fact.deals_won + ' / ' + plan.target_deals_won },
      { label:'📋 Активностей', pct: progress.activities,     nums: fact.activities + ' / ' + plan.target_activities },
      { label:'📞 Звонков',     pct: progress.calls,          nums: fact.calls + ' / ' + plan.target_calls },
      { label:'🤝 Встреч',      pct: progress.meetings,       nums: fact.meetings + ' / ' + plan.target_meetings },
      { label:'📄 КП',          pct: progress.proposals,      nums: fact.proposals + ' / ' + plan.target_proposals },
      { label:'🏢 Компаний',    pct: progress.new_companies,  nums: fact.new_companies + ' / ' + plan.target_new_companies },
    ]
    .filter(r => r.pct !== null)
    .map(r => {
      const p = r.pct || 0;
      const barClass = p >= 100 ? 'good' : p >= monthPct ? 'ok' : p >= monthPct * 0.7 ? 'warn' : 'behind';
      const color    = p >= 100 ? 'var(--success)' : p >= monthPct ? 'var(--primary)' : p >= monthPct * 0.7 ? 'var(--warning)' : 'var(--error)';
      return { ...r, p: Math.min(p, 100), barClass, color };
    });
  },
  get planDaysInfo() {
    if (!this.planData?.plan) return null;
    const now = new Date();
    const total  = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const passed = now.getDate();
    return { passed, total, pct: Math.round(passed / total * 100) };
  },
  get isHead() { return can([ROLES.ADMIN, ROLES.HEAD]); },

  // ── МИНИ-КАЛЕНДАРЬ ───────────────────────────────────────────────────────

  get calTitle() {
    return `${MONTHS_RU[this.calMonth]} ${this.calYear}`;
  },

  get calDow() { return DOW_RU; },

  // Все задачи сгруппированные по дате next_step_due
  get tasksByDate() {
    const map = {};
    this.activities
      .filter(a => a.next_step && a.next_step_due && !a.is_done)
      .forEach(a => {
        (map[a.next_step_due] = map[a.next_step_due] || []).push(a);
      });
    return map;
  },

  // Касания с компаниями сгруппированные по дате
  get compActionsByDate() {
    const map = {};
    this.companies.forEach(c => {
      if (!c.next_action_at) return;
      const date = c.next_action_at.split('T')[0];
      (map[date] = map[date] || []).push(c);
    });
    return map;
  },

  // Ячейки для отображения в сетке календаря (42 = 6 строк × 7 дней)
  get calDays() {
    const today     = todayStr();
    const year      = this.calYear;
    const month     = this.calMonth;
    const firstDow  = new Date(year, month, 1).getDay();        // 0=вс
    const startOffset = (firstDow + 6) % 7;                      // 0=пн
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrev  = new Date(year, month, 0).getDate();

    const days = [];

    // Дни предыдущего месяца (затемнённые)
    for (let i = startOffset - 1; i >= 0; i--) {
      days.push({ day: daysInPrev - i, current: false, date: null });
    }

    // Дни текущего месяца
    for (let d = 1; d <= daysInMonth; d++) {
      const mm   = String(month + 1).padStart(2, '0');
      const dd   = String(d).padStart(2, '0');
      const date = `${year}-${mm}-${dd}`;
      const tasks    = this.tasksByDate[date]      || [];
      const actions  = this.compActionsByDate[date]|| [];
      const total    = tasks.length + actions.length;
      days.push({
        day:       d,
        current:   true,
        date,
        isToday:   date === today,
        isPast:    date < today,
        isFuture:  date > today,
        isSelected:date === this.calSelected,
        hasOverdue:date < today  && total > 0,
        hasToday:  date === today && total > 0,
        hasFuture: date > today  && total > 0,
        total,
        tasks,
        actions,
      });
    }

    // Дни следующего месяца (до 42 ячеек)
    const rest = 42 - days.length;
    for (let d = 1; d <= rest; d++) {
      days.push({ day: d, current: false, date: null });
    }

    return days;
  },

  // Элементы для выбранного дня
  get calSelectedItems() {
    if (!this.calSelected) return [];
    const tasks   = (this.tasksByDate[this.calSelected]       || []).map(t => ({
      type: 'task', label: t.next_step,
      sub:  this.compByIdMap[t.company_id]?.name || '',
      url:  t.company_id ? `/company.html?id=${t.company_id}&tab=activities` : '/activities.html',
    }));
    const actions = (this.compActionsByDate[this.calSelected] || []).map(c => ({
      type: 'company', label: c.name,
      sub:  c.next_action_type || 'Касание',
      url:  `/company.html?id=${c.id}`,
    }));
    return [...tasks, ...actions];
  },

  calPrev() {
    if (this.calMonth === 0) { this.calMonth = 11; this.calYear--; }
    else this.calMonth--;
    this.calSelected = null;
  },
  calNext() {
    if (this.calMonth === 11) { this.calMonth = 0; this.calYear++; }
    else this.calMonth++;
    this.calSelected = null;
  },
  calSelectDay(day) {
    if (!day.current || !day.total) return;
    this.calSelected = this.calSelected === day.date ? null : day.date;
  },
  calGoToday() {
    const now = new Date();
    this.calYear  = now.getFullYear();
    this.calMonth = now.getMonth();
    this.calSelected = null;
  },

  // ── PUSH-УВЕДОМЛЕНИЯ ─────────────────────────────────────────────────────

  async _initPush() {
    this.pushPermission = Notification?.permission ?? 'denied';
    this.pushSupported  = 'serviceWorker' in navigator && 'PushManager' in window;

    if (!this.pushSupported) return;

    try {
      // Регистрируем Service Worker
      this.swRegistration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;

      // Проверяем текущую подписку
      const existing = await this.swRegistration.pushManager.getSubscription();
      if (existing) {
        // Верифицируем на сервере
        const res = await fetch(
          `/api/notifications/status?endpoint=${encodeURIComponent(existing.endpoint)}`,
          { credentials: 'include' }
        );
        const data = await res.json();
        this.pushSubscribed = data.subscribed;
      }
    } catch (err) {
      console.warn('[push] SW init:', err.message);
    }
  },

  async togglePush() {
    if (!this.pushSupported) return;
    this.pushLoading = true;
    try {
      if (this.pushSubscribed) {
        await this._unsubscribe();
      } else {
        await this._subscribe();
      }
    } finally {
      this.pushLoading = false;
    }
  },

  async _subscribe() {
    // Запрашиваем разрешение
    const permission = await Notification.requestPermission();
    this.pushPermission = permission;
    if (permission !== 'granted') {
      toast('Разрешение на уведомления отклонено. Разрешите в настройках браузера.', 'error');
      return;
    }

    // Получаем VAPID публичный ключ с сервера
    const keyRes = await fetch('/api/notifications/vapid-key', { credentials: 'include' });
    if (!keyRes.ok) {
      toast('Push уведомления не настроены на сервере', 'error');
      return;
    }
    const { publicKey } = await keyRes.json();

    // Подписываемся
    const subscription = await this.swRegistration.pushManager.subscribe({
      userVisibleOnly:      true,
      applicationServerKey: this._urlBase64ToUint8Array(publicKey),
    });

    // Сохраняем на сервере
    await fetch('/api/notifications/subscribe', {
      method:      'POST',
      headers:     { 'Content-Type': 'application/json' },
      credentials: 'include',
      body:        JSON.stringify(subscription.toJSON()),
    });

    this.pushSubscribed = true;
    toast('🔔 Уведомления включены', 'success');

    // Тестовый push чтобы убедиться что всё работает
    setTimeout(() => this._sendTest(), 1000);
  },

  async _unsubscribe() {
    const existing = await this.swRegistration.pushManager.getSubscription();
    if (existing) {
      await fetch('/api/notifications/subscribe', {
        method:      'DELETE',
        headers:     { 'Content-Type': 'application/json' },
        credentials: 'include',
        body:        JSON.stringify({ endpoint: existing.endpoint }),
      });
      await existing.unsubscribe();
    }
    this.pushSubscribed = false;
    toast('Уведомления отключены');
  },

  async _sendTest() {
    await fetch('/api/notifications/test', {
      method:      'POST',
      credentials: 'include',
    });
  },

  // Конвертация VAPID ключа для браузерного API
  _urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw     = atob(base64);
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
  },

  // ── Утилиты шаблона ───────────────────────────────────────────────────────

  fmtDate(s)         { return fmtDate(s); },
  segColor(seg)      { return SEGMENT_COLORS[seg] || 'gray'; },
  segLabel(seg)      { return SEGMENT_LABELS[seg] || seg; },
  taskCompany(a)     { return this.compByIdMap[a.company_id]; },
  taskIsOverdue(a)   { return a.next_step_due < todayStr(); },
  taskUrl(a)         {
    const c = this.compByIdMap[a.company_id];
    return c ? `/company.html?id=${c.id}&tab=activities` : '/activities.html';
  },
}));

window.Alpine = Alpine;
Alpine.start();
