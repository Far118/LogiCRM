/**
 * js/pages/dashboard.js — Alpine-компонент дашборда
 * Статистика, задачи, мини-календарь (dropdown в топбаре), push-уведомления.
 */

import Alpine from 'alpinejs';
import { initUI, fmtDate, todayStr, toast } from '../ui.js';
import { getCompanies, SEGMENT_LABELS, SEGMENT_COLORS } from '../companies.js';
import { getMyActivities } from '../activities.js';
import { can, ROLES } from '../auth.js';

const MONTHS_RU = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
const DOW_RU    = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];

// Ключевая утилита: нормализует дату из PostgreSQL к 'YYYY-MM-DD'.
// PostgreSQL DATE возвращается как '2024-01-15T00:00:00.000Z' — split('T')[0] исправляет это.
const normDate = v => v ? String(v).split('T')[0] : '';

Alpine.data('dashboardPage', () => ({

  // ── Состояние ────────────────────────────────────────────────────────────
  session:    null,
  loading:    true,
  activities: [],
  companies:  [],
  planData:   null,
  funnel:     [],   // [{stage, label, count, pipeline}]

  stats:          { overdue: 0, today: 0, week: 0, companies: 0 },
  greetTitle:     '',
  greetSub:       '',
  overdueTasks:   [],
  todayTasks:     [],
  weekTasks:      [],
  freshCompanies: [],
  weekActivity:   {},

  // ── Календарь (dropdown) ─────────────────────────────────────────────────
  calOpen:     false,
  calYear:     new Date().getFullYear(),
  calMonth:    new Date().getMonth(),
  calSelected: null,

  // ── Push ─────────────────────────────────────────────────────────────────
  pushSupported:  false,
  pushSubscribed: false,
  pushLoading:    false,
  pushPermission: 'default',
  swRegistration: null,

  // ── Инициализация ─────────────────────────────────────────────────────────

  async init() {
    this.session = await initUI({ active: 'dashboard' });
    if (!this.session) return;

    const h = new Date().getHours();
    const g = h<6?'Доброй ночи':h<12?'Доброе утро':h<17?'Добрый день':'Добрый вечер';
    this.greetTitle = `${g}, ${this.session.first_name || this.session.email.split('@')[0]}!`;

    document.addEventListener('keydown', e => {
      if (e.target.matches('input,textarea,select')) return;
      if (e.key==='n'||e.key==='т') location.href='/companies.html?new=1';
      if (e.key==='/') { e.preventDefault(); location.href='/companies.html'; }
      if (e.key==='d'||e.key==='в') location.href='/deals.html?new=1';
      if (e.key==='Escape') this.calOpen = false;
    });

    // Закрыть календарь при клике вне
    document.addEventListener('click', e => {
      if (this.calOpen && !e.target.closest('.cal-btn-wrap')) {
        this.calOpen = false;
      }
    });

    const [activities, companies, planData, funnel] = await Promise.all([
      getMyActivities(), getCompanies(), this._loadPlan(), this._loadFunnel(),
    ]);
    this.activities = activities;
    this.companies  = companies;
    this.planData   = planData;
    this.funnel     = funnel;

    this._computeStats();
    this._computeGreetSub();
    this._computeFresh();
    this._computeWeekActivity();
    this.loading = false;
    this._initPush();
  },

  // ── Загрузка плана ────────────────────────────────────────────────────────

  async _loadPlan() {
    try {
      const now = new Date();
      const res = await fetch(`/api/plans/my?year=${now.getFullYear()}&month=${now.getMonth()+1}`, { credentials:'include' });
      return res.ok ? await res.json() : null;
    } catch { return null; }
  },

  // ── Загрузка воронки ──────────────────────────────────────────────────────

  async _loadFunnel() {
    try {
      const now = new Date();
      const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
      const to   = now.toISOString().split('T')[0];
      const res  = await fetch(`/api/reports/funnel?from=${from}&to=${to}`, { credentials:'include' });
      return res.ok ? await res.json() : [];
    } catch { return []; }
  },

  // ── Статистика ────────────────────────────────────────────────────────────

  _computeStats() {
    const today   = todayStr();
    const weekEnd = (() => { const d=new Date(); d.setDate(d.getDate()+7); return d.toISOString().split('T')[0]; })();

    // normDate исправляет баг PostgreSQL: '2024-01-15T00:00:00Z' → '2024-01-15'
    const tasks = this.activities.filter(a => a.next_step && a.next_step_due && !a.is_done);
    const nd    = a => normDate(a.next_step_due);

    this.overdueTasks = tasks.filter(a => nd(a) < today).sort((a,b) => nd(a).localeCompare(nd(b)));
    this.todayTasks   = tasks.filter(a => nd(a) === today);
    this.weekTasks    = tasks.filter(a => nd(a) > today && nd(a) <= weekEnd).sort((a,b) => nd(a).localeCompare(nd(b)));

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
      .sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''))
      .slice(0, 5);
  },

  _computeWeekActivity() {
    const weekAgo = (() => { const d=new Date(); d.setDate(d.getDate()-7); return d.toISOString(); })();
    const myWeek  = this.activities.filter(a => a.occurred_at && a.occurred_at >= weekAgo);
    this.weekActivity = {
      calls:     myWeek.filter(a => ['call_out','call_in'].includes(a.type)).length,
      emails:    myWeek.filter(a => ['email_out','email_in'].includes(a.type)).length,
      meetings:  myWeek.filter(a => a.type==='meeting').length,
      proposals: myWeek.filter(a => a.type==='proposal').length,
    };
  },

  // ── Вычисляемые свойства ──────────────────────────────────────────────────

  get weekTotal()   { return Object.values(this.weekActivity).reduce((s,v) => s+v, 0); },
  get compByIdMap() { return Object.fromEntries(this.companies.map(c => [c.id, c])); },
  get compLabel()   { return can([ROLES.MANAGER]) ? 'Моих компаний' : 'Всего компаний'; },
  get isHead()      { return can([ROLES.ADMIN, ROLES.HEAD]); },

  // Бейдж на кнопке календаря
  get calBadge() {
    const n = this.stats.overdue + this.stats.today;
    return n > 0 ? (n > 99 ? '99+' : String(n)) : '';
  },

  // ── Воронка ───────────────────────────────────────────────────────────────

  // Стадии с ненулевым количеством сделок (только активные)
  get funnelActive() {
    return this.funnel.filter(s => s.count > 0);
  },

  // Максимум для нормировки баров
  get funnelMax() {
    return Math.max(...this.funnel.map(s => s.count), 1);
  },

  // Итого по воронке
  get funnelTotal() {
    return this.funnel.reduce((s, r) => s + r.count, 0);
  },

  get funnelPipeline() {
    const total = this.funnel.reduce((s, r) => s + Number(r.pipeline || 0), 0);
    if (total >= 1_000_000) return (total / 1_000_000).toFixed(1) + ' млн ₽';
    if (total >= 1_000)     return (total / 1_000).toFixed(0) + ' тыс ₽';
    return total + ' ₽';
  },

  fmtPipeline(n) {
    n = Number(n || 0);
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000)     return (n / 1_000).toFixed(0) + 'K';
    return String(n);
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
    const monthPct = Math.round(now.getDate() / new Date(now.getFullYear(), now.getMonth()+1, 0).getDate() * 100);
    const fmtRub = n => {
      n = Number(n||0);
      if (n>=1_000_000) return (n/1_000_000).toFixed(1)+' млн';
      if (n>=1_000)     return (n/1_000).toFixed(0)+' тыс';
      return String(n);
    };
    return [
      { label:'💰 Выручка',     pct:progress.revenue,      nums:fmtRub(fact.revenue)+' / '+fmtRub(plan.target_revenue)+' ₽' },
      { label:'🏆 Сделок',      pct:progress.deals_won,    nums:fact.deals_won+' / '+plan.target_deals_won },
      { label:'📋 Активностей', pct:progress.activities,   nums:fact.activities+' / '+plan.target_activities },
      { label:'📞 Звонков',     pct:progress.calls,        nums:fact.calls+' / '+plan.target_calls },
      { label:'🤝 Встреч',      pct:progress.meetings,     nums:fact.meetings+' / '+plan.target_meetings },
      { label:'📄 КП',          pct:progress.proposals,    nums:fact.proposals+' / '+plan.target_proposals },
      { label:'🏢 Компаний',    pct:progress.new_companies,nums:fact.new_companies+' / '+plan.target_new_companies },
    ].filter(r => r.pct !== null).map(r => {
      const p = r.pct || 0;
      const barClass = p>=100?'good':p>=monthPct?'ok':p>=monthPct*.7?'warn':'behind';
      const color    = p>=100?'var(--success)':p>=monthPct?'var(--primary)':p>=monthPct*.7?'var(--warning)':'var(--error)';
      return { ...r, p: Math.min(p,100), barClass, color };
    });
  },
  get planDaysInfo() {
    if (!this.planData?.plan) return null;
    const now = new Date();
    const total = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
    return { passed: now.getDate(), total, pct: Math.round(now.getDate()/total*100) };
  },

  // ── КАЛЕНДАРЬ ─────────────────────────────────────────────────────────────

  get calTitle() { return `${MONTHS_RU[this.calMonth]} ${this.calYear}`; },
  get calDow()   { return DOW_RU; },

  // Задачи по дате — normDate ОБЯЗАТЕЛЕН для совместимости с PostgreSQL
  get tasksByDate() {
    const map = {};
    this.activities
      .filter(a => a.next_step && a.next_step_due && !a.is_done)
      .forEach(a => {
        const d = normDate(a.next_step_due);
        if (d) (map[d] = map[d] || []).push(a);
      });
    return map;
  },

  // Касания с компаниями по дате
  get compActionsByDate() {
    const map = {};
    this.companies.forEach(c => {
      if (!c.next_action_at) return;
      const d = normDate(c.next_action_at);
      if (d) (map[d] = map[d] || []).push(c);
    });
    return map;
  },

  // 42 ячейки для сетки (6 нед × 7 дней)
  get calDays() {
    const today   = todayStr();
    const year    = this.calYear;
    const month   = this.calMonth;
    const first   = new Date(year, month, 1).getDay();       // 0=вс
    const offset  = (first + 6) % 7;                          // 0=пн
    const inMonth = new Date(year, month+1, 0).getDate();
    const inPrev  = new Date(year, month, 0).getDate();
    const days    = [];

    for (let i = offset-1; i >= 0; i--)
      days.push({ day: inPrev-i, current: false, date: null });

    for (let d = 1; d <= inMonth; d++) {
      const date    = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const tasks   = this.tasksByDate[date]       || [];
      const actions = this.compActionsByDate[date]  || [];
      const total   = tasks.length + actions.length;
      days.push({
        day:        d,
        current:    true,
        date,
        isToday:    date === today,
        isPast:     date < today,
        isSelected: date === this.calSelected,
        hasOverdue: date <  today && total > 0,
        hasToday:   date === today && total > 0,
        hasFuture:  date >  today && total > 0,
        total, tasks, actions,
      });
    }

    for (let d = 1; days.length < 42; d++)
      days.push({ day: d, current: false, date: null });

    return days;
  },

  // Элементы выбранного дня
  get calSelectedItems() {
    if (!this.calSelected) return [];
    const tasks   = (this.tasksByDate[this.calSelected]||[]).map(t => ({
      type:'task', label: t.next_step,
      sub:  this.compByIdMap[t.company_id]?.name || '',
      url:  t.company_id ? `/company.html?id=${t.company_id}&tab=activities` : '/activities.html',
    }));
    const actions = (this.compActionsByDate[this.calSelected]||[]).map(c => ({
      type:'company', label: c.name,
      sub:  c.next_action_type || 'Касание',
      url:  `/company.html?id=${c.id}`,
    }));
    return [...tasks, ...actions];
  },

  calToggle() {
    this.calOpen = !this.calOpen;
    if (this.calOpen) {
      const now = new Date();
      this.calYear  = now.getFullYear();
      this.calMonth = now.getMonth();
      this.calSelected = null;
    }
  },
  calPrev() {
    if (this.calMonth===0) { this.calMonth=11; this.calYear--; }
    else this.calMonth--;
    this.calSelected = null;
  },
  calNext() {
    if (this.calMonth===11) { this.calMonth=0; this.calYear++; }
    else this.calMonth++;
    this.calSelected = null;
  },
  calGoToday() {
    const now = new Date();
    this.calYear=now.getFullYear(); this.calMonth=now.getMonth();
    this.calSelected=null;
  },
  calSelectDay(day) {
    if (!day.current) return;
    this.calSelected = this.calSelected===day.date ? null : day.date;
  },

  // ── PUSH ──────────────────────────────────────────────────────────────────

  async _initPush() {
    this.pushPermission = Notification?.permission ?? 'denied';
    this.pushSupported  = 'serviceWorker' in navigator && 'PushManager' in window;
    if (!this.pushSupported) return;
    try {
      this.swRegistration = await navigator.serviceWorker.register('/sw.js', { scope:'/' });
      await navigator.serviceWorker.ready;
      const existing = await this.swRegistration.pushManager.getSubscription();
      if (existing) {
        const res  = await fetch(`/api/notifications/status?endpoint=${encodeURIComponent(existing.endpoint)}`, { credentials:'include' });
        const data = await res.json();
        this.pushSubscribed = data.subscribed;
      }
    } catch(err) { console.warn('[push]', err.message); }
  },

  async togglePush() {
    if (!this.pushSupported) return;
    this.pushLoading = true;
    try {
      this.pushSubscribed ? await this._unsubscribe() : await this._subscribe();
    } finally { this.pushLoading = false; }
  },

  async _subscribe() {
    const perm = await Notification.requestPermission();
    this.pushPermission = perm;
    if (perm !== 'granted') { toast('Разрешение отклонено — разрешите в настройках браузера','error'); return; }
    const keyRes = await fetch('/api/notifications/vapid-key', { credentials:'include' });
    if (!keyRes.ok) { toast('Push не настроен на сервере','error'); return; }
    const { publicKey } = await keyRes.json();
    const sub = await this.swRegistration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: this._b64ToUint8(publicKey),
    });
    await fetch('/api/notifications/subscribe', { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include', body: JSON.stringify(sub.toJSON()) });
    this.pushSubscribed = true;
    toast('🔔 Уведомления включены','success');
    setTimeout(() => fetch('/api/notifications/test', { method:'POST', credentials:'include' }), 1000);
  },

  async _unsubscribe() {
    const existing = await this.swRegistration.pushManager.getSubscription();
    if (existing) {
      await fetch('/api/notifications/subscribe', { method:'DELETE', headers:{'Content-Type':'application/json'}, credentials:'include', body: JSON.stringify({ endpoint: existing.endpoint }) });
      await existing.unsubscribe();
    }
    this.pushSubscribed = false;
    toast('Уведомления отключены');
  },

  _b64ToUint8(b64) {
    const pad = '='.repeat((4 - b64.length%4) % 4);
    const raw = atob((b64+pad).replace(/-/g,'+').replace(/_/g,'/'));
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
  },

  // ── Утилиты шаблона ───────────────────────────────────────────────────────

  fmtDate(s)      { return fmtDate(s); },
  segColor(seg)   { return SEGMENT_COLORS[seg] || 'gray'; },
  segLabel(seg)   { return SEGMENT_LABELS[seg] || seg; },
  taskCompany(a)  { return this.compByIdMap[a.company_id]; },
  taskIsOverdue(a){ return normDate(a.next_step_due) < todayStr(); },
  taskUrl(a) {
    const c = this.compByIdMap[a.company_id];
    return c ? `/company.html?id=${c.id}&tab=activities` : '/activities.html';
  },
}));

window.Alpine = Alpine;
Alpine.start();
