/**
 * ui.js — общий модуль инициализации интерфейса.
 *
 * Каждая защищённая страница вызывает:
 *   const session = await initUI({ active: 'companies' });
 *
 * Что делает:
 *   1. Проверяет авторизацию (requireAuth), редиректит если нет сессии
 *   2. Вставляет HTML сайдбара в #sidebar
 *   3. Проставляет active на нужном пункте меню
 *   4. Заполняет данные пользователя (аватар, имя, роль)
 *   5. Инициализирует переключатель темы
 *   6. Инициализирует мобильное меню
 *
 * Параметры initUI:
 *   active  — id пункта навигации ('dashboard'|'companies'|'deals'|
 *              'activities'|'admin')
 *   roles   — массив допустимых ролей (null = любая авторизованная роль)
 */

import {
  requireAuth, getSession, getRoleLabel, getUserInitials,
  logout, ROLES, can,
} from './auth.js';

// ── Иконки (inline SVG строки) ────────────────────────────────────────────────

const ICONS = {
  dashboard: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
    <rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
  </svg>`,
  companies: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M3 21h18M9 8h1M9 12h1M9 16h1M14 8h1M14 12h1M14 16h1"/>
    <path d="M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16"/>
  </svg>`,
  deals: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
  </svg>`,
  activities: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
    <polyline points="14 2 14 8 20 8"/>
    <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
  </svg>`,
  requests: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <rect x="1" y="3" width="15" height="13"/>
    <path d="M16 8h4l3 3v5h-7V8z"/>
    <circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>
  </svg>`,
  admin: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
  </svg>`,
  import_icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
    <polyline points="7 10 12 15 17 10"/>
    <line x1="12" y1="15" x2="12" y2="3"/>
  </svg>`,
  plans: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
  </svg>`,
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
  </svg>`,
  reports: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/>
    <line x1="6" y1="20" x2="6" y2="14"/>
  </svg>`,
  carriers: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <rect x="1" y="3" width="15" height="13"/>
    <path d="M16 8h4l3 3v5h-7V8z"/>
    <circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>
  </svg>`,
  logout: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
    <polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
  </svg>`,
  sun: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <circle cx="12" cy="12" r="5"/>
    <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
  </svg>`,
  moon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
  </svg>`,
  menu: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <line x1="3" y1="12" x2="21" y2="12"/>
    <line x1="3" y1="6" x2="21" y2="6"/>
    <line x1="3" y1="18" x2="21" y2="18"/>
  </svg>`,
};

// ── Сайдбар: структура навигации ──────────────────────────────────────────────

const NAV = [
  { id: 'dashboard',  href: '/index.html',         label: 'Дашборд',          icon: 'dashboard'  },
  { id: 'companies',  href: '/companies.html',      label: 'Компании',         icon: 'companies'  },
  { id: 'deals',      href: '/deals.html',          label: 'Сделки',           icon: 'deals'      },
  { id: 'activities', href: '/activities.html',     label: 'Активности',       icon: 'activities' },
  { id: 'requests',   href: '/requests.html',       label: 'Запросы',          icon: 'requests'   },
  { id: 'carriers',   href: '/carriers.html',       label: 'Перевозчики',      icon: 'carriers'   },
];
const NAV_ADMIN = [
  { id: 'reports',    href: '/reports.html',        label: 'Отчёты',           icon: 'reports',      roles: ['admin','head'] },
  { id: 'import',     href: '/import.html',         label: 'Импорт',           icon: 'import_icon',  roles: ['admin','head','manager'] },
  { id: 'plans',      href: '/plans.html',          label: 'Планы продаж',     icon: 'plans',        roles: ['admin','head'] },
  { id: 'admin',      href: '/admin/users.html',    label: 'Пользователи',     icon: 'admin',        roles: ['admin'] },
];

// ── Отрисовка сайдбара ────────────────────────────────────────────────────────

function buildSidebar(session, activeId) {
  const items = (role) => [...NAV, ...NAV_ADMIN]
    .filter(item => !item.roles || item.roles.includes(role))
    .map(item => {
      const active = item.id === activeId ? ' active' : '';
      const soon = item.soon
        ? '<span style="font-size:.68rem;color:var(--text-faint);margin-left:auto">скоро</span>'
        : '';
      return `<a href="${item.href}" class="nav-item${active}">
        ${ICONS[item.icon]}
        ${item.label}
        ${soon}
      </a>`;
    }).join('');

  return `
    <a href="/index.html" class="sidebar-logo">
      <svg width="28" height="28" viewBox="0 0 40 40" fill="none">
        <rect width="40" height="40" rx="10" fill="currentColor" opacity=".08"/>
        <path d="M10 8 L10 28 L26 28" stroke="currentColor" stroke-width="3"
              stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="30" cy="14" r="4" fill="currentColor"/>
        <path d="M10 17 C16 17 22 11 30 14" stroke="currentColor" stroke-width="1.5"
              stroke-dasharray="2 2" opacity=".5"/>
      </svg>
      <span class="sidebar-logo-name">Logi<span>CRM</span></span>
    </a>

    <nav class="sidebar-nav">
      <div class="nav-section-label">Рабочий стол</div>
      ${items(session.role)}
      <div class="nav-section-label" style="margin-top:.75rem">Аккаунт</div>
      <button class="nav-item" id="navLogout" style="width:100%;text-align:left">
        ${ICONS.logout}
        Выйти
      </button>
    </nav>

    <div class="sidebar-footer">
      <div class="user-chip">
        <div class="avatar" id="userAvatar">${getUserInitials(session)}</div>
        <div class="user-info">
          <div class="user-name">${escHtml(
            [session.first_name, session.last_name].filter(Boolean).join(' ') || session.email
          )}</div>
          <div class="user-role">${getRoleLabel(session.role)}</div>
        </div>
        <button class="theme-btn" id="gsBtn" aria-label="Поиск (Ctrl+K)" title="Поиск Ctrl+K" onclick="document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}))">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        </button>
        <button class="theme-btn" id="themeBtn" aria-label="Сменить тему"></button>
      </div>
    </div>
  `;
}

function escHtml(s) {
  // Аудит 6.1: добавлено экранирование кавычек — защита от XSS в атрибутах.
  // Без " → &quot; и ' → &#39; вставка в href="..." или value="..." небезопасна.
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Тема ─────────────────────────────────────────────────────────────────────

function initTheme() {
  const root = document.documentElement;
  const btn  = document.getElementById('themeBtn');
  if (!btn) return;

  // Читаем сохранённую тему или берём из prefers-color-scheme
  let theme = localStorage.getItem('logicrm_theme')
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  apply(theme);

  btn.addEventListener('click', () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('logicrm_theme', theme);
    apply(theme);
  });

  function apply(t) {
    root.setAttribute('data-theme', t);
    btn.innerHTML = t === 'dark' ? ICONS.sun : ICONS.moon;
  }
}

// ── Мобильное меню ────────────────────────────────────────────────────────────

function initMobileMenu() {
  const sidebar  = document.getElementById('sidebar');
  const overlay  = document.getElementById('sidebarOverlay');
  const menuBtn  = document.getElementById('menuBtn');
  if (!sidebar || !menuBtn) return;

  menuBtn.addEventListener('click', () => {
    sidebar.classList.toggle('open');
    overlay.classList.toggle('visible');
  });
  overlay?.addEventListener('click', () => {
    sidebar.classList.remove('open');
    overlay.classList.remove('visible');
  });
}

// ── Кнопка «Меню» в topbar ────────────────────────────────────────────────────

export function getMenuBtnHtml() {
  return `<button class="menu-btn btn" id="menuBtn" aria-label="Открыть меню">${ICONS.menu}</button>`;
}

// ── Главная точка входа ───────────────────────────────────────────────────────

/**
 * Инициализирует UI защищённой страницы.
 * @param {{ active?: string, roles?: string[] }} opts
 * @returns {Promise<object|null>} — объект сессии или null (уже произошёл редирект)
 */
export async function initUI({ active = '', roles = null } = {}) {
  // Скрываем страницу до проверки сессии — убирает вспышку контента
  document.documentElement.style.visibility = 'hidden';

  try {
    const ok = await requireAuth(roles);
    if (!ok) return null; // редирект уже произошёл внутри requireAuth

    const session = getSession();

    const sidebarEl = document.getElementById('sidebar');
    if (sidebarEl) sidebarEl.innerHTML = buildSidebar(session, active);

    document.getElementById('navLogout')?.addEventListener('click', async () => {
      if (confirm('Выйти из системы?')) await logout();
    });

    initTheme();
    initMobileMenu();
    initGlobalSearch();

    return session;
  } catch (err) {
    console.error('[initUI]', err);
    return null;
  } finally {
    // Всегда показываем страницу — даже при ошибке
    document.documentElement.style.visibility = 'visible';
  }
}

// ── Toast ─────────────────────────────────────────────────────────────────────

let _toastTimer = null;

/**
 * Показать toast-уведомление.
 * @param {string} msg
 * @param {'default'|'error'|'success'} type
 */
export function toast(msg, type = 'default') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className   = `toast show${type !== 'default' ? ' ' + type : ''}`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ── Утилиты ───────────────────────────────────────────────────────────────────

/** HTML-escape строки. */
export function esc(s) { return escHtml(s); }

/** Форматирование даты. */
export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Форматирование даты+времени. */
export function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Сегодняшняя дата строкой YYYY-MM-DD. */
export function todayStr() {
  return new Date().toISOString().split('T')[0];
}

/** Проверка просрочки (дата < сегодня). */
export function isOverdueDate(dateStr) {
  return !!dateStr && dateStr < todayStr();
}

// ═══════════════════════════════════════════════════════════════════════════
// Глобальный поиск (Ctrl+K / Cmd+K)
// Монтируется один раз при вызове initGlobalSearch() из initUI
// ═══════════════════════════════════════════════════════════════════════════

const SEARCH_CSS = `
#gs-backdrop {
  display:none; position:fixed; inset:0; z-index:200;
  background:oklch(0 0 0 / .45); backdrop-filter:blur(2px);
  align-items:flex-start; justify-content:center; padding-top:10vh;
}
#gs-backdrop.open { display:flex; }
#gs-box {
  width:100%; max-width:580px; margin:0 1rem;
  background:var(--surface); border:1px solid var(--border);
  border-radius:var(--r-xl); box-shadow:var(--shadow-md);
  overflow:hidden; display:flex; flex-direction:column;
  max-height:80vh;
}
#gs-input-wrap {
  display:flex; align-items:center; gap:.75rem;
  padding:.9rem 1rem; border-bottom:1px solid var(--divider); flex-shrink:0;
}
#gs-input-wrap svg { width:18px; height:18px; color:var(--text-muted); flex-shrink:0; }
#gs-input {
  flex:1; border:none; outline:none; background:none;
  font-size:1rem; color:var(--text); font-family:var(--font);
}
#gs-input::placeholder { color:var(--text-faint); }
#gs-kbd {
  font-size:.72rem; color:var(--text-faint); padding:2px 6px;
  border:1px solid var(--border); border-radius:4px; flex-shrink:0;
}
#gs-results { overflow-y:auto; flex:1; }
.gs-empty {
  padding:2.5rem 1rem; text-align:center;
  color:var(--text-muted); font-size:.9em;
}
.gs-group-label {
  padding:.5rem 1rem .2rem; font-size:.68rem;
  text-transform:uppercase; letter-spacing:.06em;
  color:var(--text-faint); font-weight:600;
  position:sticky; top:0; background:var(--surface); z-index:1;
}
.gs-item {
  display:flex; align-items:center; gap:.75rem;
  padding:.6rem 1rem; cursor:pointer; text-decoration:none;
  color:var(--text);
}
.gs-item:hover, .gs-item.active { background:var(--surface-off); }
.gs-item.active { background:var(--primary-subtle); }
.gs-icon {
  width:30px; height:30px; border-radius:var(--r-md);
  display:flex; align-items:center; justify-content:center;
  flex-shrink:0; font-size:.7rem; font-weight:700;
}
.gs-icon.company  { background:var(--primary-subtle); color:var(--primary); }
.gs-icon.contact  { background:color-mix(in oklch,var(--blue) 12%,var(--surface)); color:var(--blue); }
.gs-icon.deal     { background:color-mix(in oklch,var(--orange) 12%,var(--surface)); color:var(--orange); }
.gs-icon.request  { background:color-mix(in oklch,var(--success) 12%,var(--surface)); color:var(--success); }
.gs-body { flex:1; min-width:0; }
.gs-title { font-size:.9em; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.gs-sub   { font-size:.75em; color:var(--text-muted); margin-top:1px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.gs-meta  { font-size:.72em; color:var(--text-faint); white-space:nowrap; flex-shrink:0; }
.gs-footer {
  padding:.5rem 1rem; border-top:1px solid var(--divider); flex-shrink:0;
  display:flex; gap:1.25rem; font-size:.72rem; color:var(--text-faint);
}
.gs-footer kbd {
  display:inline-flex; align-items:center; justify-content:center;
  padding:1px 5px; border:1px solid var(--border); border-radius:3px;
  font-size:.9em; margin-right:3px;
}
mark { background:oklch(from var(--primary) l c h / .2); color:var(--primary); border-radius:2px; font-style:normal; }
`;

const TYPE_ICONS = {
  company: 'КО',
  contact: 'КТ',
  deal:    'СД',
  request: 'ЗП',
};

function highlight(text, q) {
  if (!q || !text) return esc(text || '');
  const re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + ')', 'gi');
  return esc(text).replace(re, '<mark>$1</mark>');
}

function initGlobalSearch() {
  // Вставляем стили
  if (!document.getElementById('gs-style')) {
    const style = document.createElement('style');
    style.id = 'gs-style';
    style.textContent = SEARCH_CSS;
    document.head.appendChild(style);
  }

  // Вставляем HTML
  if (document.getElementById('gs-backdrop')) return; // уже монтирован
  const backdrop = document.createElement('div');
  backdrop.id = 'gs-backdrop';
  backdrop.innerHTML = `
    <div id="gs-box">
      <div id="gs-input-wrap">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input id="gs-input" placeholder="Поиск по компаниям, контактам, сделкам…" autocomplete="off">
        <span id="gs-kbd">Esc</span>
      </div>
      <div id="gs-results"><div class="gs-empty">Введите от 2 символов</div></div>
      <div class="gs-footer">
        <span><kbd>↑↓</kbd> навигация</span>
        <span><kbd>Enter</kbd> открыть</span>
        <span><kbd>Esc</kbd> закрыть</span>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const input   = document.getElementById('gs-input');
  const results = document.getElementById('gs-results');
  let items  = [];
  let active = -1;
  let timer  = null;

  function open() {
    backdrop.classList.add('open');
    input.value = '';
    results.innerHTML = '<div class="gs-empty">Введите от 2 символов</div>';
    items = []; active = -1;
    setTimeout(() => input.focus(), 50);
  }
  function close() {
    backdrop.classList.remove('open');
    clearTimeout(timer);
  }

  function setActive(idx) {
    document.querySelectorAll('.gs-item').forEach((el, i) => {
      el.classList.toggle('active', i === idx);
      if (i === idx) el.scrollIntoView({ block:'nearest' });
    });
    active = idx;
  }

  async function search(q) {
    if (q.length < 2) {
      results.innerHTML = '<div class="gs-empty">Введите от 2 символов</div>';
      items = []; active = -1; return;
    }
    results.innerHTML = '<div class="gs-empty" style="padding:1rem">⏳</div>';

    try {
      const res  = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=30`, { credentials:'include' });
      const data = await res.json();
      if (!data.length) {
        results.innerHTML = `<div class="gs-empty">По запросу «${esc(q)}» ничего не найдено</div>`;
        items = []; active = -1; return;
      }

      // Группируем по типу
      const groups = {};
      data.forEach(r => { (groups[r.type] = groups[r.type] || []).push(r); });
      const TYPE_ORDER = ['company','contact','deal','request'];
      const TYPE_LABELS = { company:'Компании', contact:'Контакты', deal:'Сделки', request:'Запросы' };

      let html = '';
      items = [];
      TYPE_ORDER.filter(t => groups[t]).forEach(type => {
        html += `<div class="gs-group-label">${TYPE_LABELS[type]}</div>`;
        groups[type].forEach(r => {
          const idx = items.length;
          items.push(r);
          html += `<a class="gs-item" data-idx="${idx}" href="${esc(r.url||'#')}">
            <div class="gs-icon ${type}">${TYPE_ICONS[type]}</div>
            <div class="gs-body">
              <div class="gs-title">${highlight(r.title, q)}</div>
              ${r.subtitle || r.meta ? `<div class="gs-sub">${esc(r.subtitle || '')}${r.subtitle && r.meta ? ' · ' : ''}${esc(r.meta || '')}</div>` : ''}
            </div>
          </a>`;
        });
      });

      results.innerHTML = html;
      active = -1;

      // Клики по результатам
      results.querySelectorAll('.gs-item').forEach(el => {
        el.addEventListener('mouseenter', () => setActive(parseInt(el.dataset.idx)));
        el.addEventListener('click', () => close());
      });
    } catch(err) {
      results.innerHTML = `<div class="gs-empty">Ошибка: ${esc(err.message)}</div>`;
    }
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => search(input.value.trim()), 150);
  });

  input.addEventListener('keydown', e => {
    const els = document.querySelectorAll('.gs-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(Math.min(active + 1, els.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(Math.max(active - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0 && items[active]) {
        window.location.href = items[active].url;
        close();
      }
    } else if (e.key === 'Escape') {
      close();
    }
  });

  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });

  // Горячие клавиши — Ctrl+K / Cmd+K / Ctrl+/
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault(); open();
    }
    // '/' когда не в поле ввода
    if (e.key === '/' && !e.target.matches('input,textarea,select,[contenteditable]')) {
      e.preventDefault(); open();
    }
  });

  return { open, close };
}

export { initGlobalSearch };
