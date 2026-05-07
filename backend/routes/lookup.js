/**
 * routes/lookup.js
 *
 * GET /api/lookup/inn/:inn — поиск компании по ИНН через Dadata
 *
 * Требует переменной окружения DADATA_API_KEY.
 * Бесплатный ключ: https://dadata.ru/profile/#info (раздел «API-ключи»)
 *
 * Возвращает нормализованный объект, готовый к вставке в форму компании.
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { config } from '../config.js';

const router = Router();
router.use(authenticate);

const DADATA_URL = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party';

router.get('/inn/:inn', async (req, res) => {
  const { inn } = req.params;

  // Базовая валидация ИНН (10 цифр — юрлицо, 12 — ИП)
  if (!/^\d{10}$|^\d{12}$/.test(inn)) {
    return res.status(400).json({ error: 'ИНН должен содержать 10 или 12 цифр' });
  }

  if (!config.dadataApiKey) {
    return res.status(503).json({
      error: 'Поиск по ИНН не настроен. Добавьте DADATA_API_KEY в .env',
    });
  }

  try {
    const response = await fetch(DADATA_URL, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Accept':        'application/json',
        'Authorization': `Token ${config.dadataApiKey}`,
      },
      body: JSON.stringify({ query: inn, count: 1 }),
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('[lookup/inn] Dadata error:', response.status, text.slice(0, 200));
      if (response.status === 401) {
        return res.status(502).json({ error: 'Неверный ключ Dadata. Проверьте DADATA_API_KEY в .env' });
      }
      return res.status(502).json({ error: `Ошибка сервиса: ${response.status}` });
    }

    const data = await response.json();
    const suggestion = data.suggestions?.[0];

    if (!suggestion) {
      return res.status(404).json({ error: 'Компания с таким ИНН не найдена' });
    }

    const d = suggestion.data;

    // ── Определяем отрасль по ОКВЭД ─────────────────────────────────────────
    const okvedCode  = d.okved ?? '';
    const okvedLabel = d.okved_type || suggestion.unrestricted_value || '';
    const industry   = guessIndustry(okvedCode, d.name?.full_with_opf || '');

    // ── Нормализуем ответ ────────────────────────────────────────────────────
    const result = {
      // Основное
      name:           d.name?.short_with_opf  || d.name?.full_with_opf || suggestion.value,
      name_full:      d.name?.full_with_opf   || '',
      inn:            d.inn  || inn,
      ogrn:           d.ogrn || '',
      kpp:            d.kpp  || '',

      // Адреса
      address_legal:  d.address?.value || '',
      address_actual: d.address?.value || '',   // Dadata не разделяет — пользователь уточнит

      // Регион → используем в chip-select регионов
      region:         d.address?.data?.region || '',

      // Руководитель
      director_name:  d.management?.name || '',
      director_post:  d.management?.post || '',

      // Статус
      status:         d.state?.status || '',         // ACTIVE | LIQUIDATING | LIQUIDATED
      status_date:    d.state?.registration_date || null,
      okved:          okvedCode,
      okved_name:     okvedLabel,
      industry,

      // Тип (ЮЛ / ИП)
      type:           d.type || '',   // LEGAL | INDIVIDUAL
    };

    res.json(result);
  } catch (err) {
    if (err.name === 'TimeoutError') {
      return res.status(504).json({ error: 'Сервис Dadata не ответил за 8 секунд' });
    }
    console.error('[lookup/inn]', err.message);
    res.status(500).json({ error: 'Ошибка при запросе к Dadata' });
  }
});

// ── Угадываем отрасль по ОКВЭД-коду ─────────────────────────────────────────

function guessIndustry(okved, name) {
  if (!okved) return '';
  const code = okved.replace('.', '');
  const n    = parseInt(code, 10);

  if (n >= 4900 && n <= 5399)  return 'Транспорт и логистика';
  if (n >= 5200 && n <= 5299)  return 'Складирование и хранение';
  if (n >= 4600 && n <= 4699)  return 'Оптовая торговля';
  if (n >= 4700 && n <= 4799)  return 'Розничная торговля';
  if (n >= 1000 && n <= 3399)  return 'Производство';
  if (n >= 4100 && n <= 4399)  return 'Строительство';
  if (n >= 6400 && n <= 6699)  return 'Финансы и страхование';
  if (n >= 6800 && n <= 6899)  return 'Недвижимость';
  if (n >= 6900 && n <= 7599)  return 'Профессиональные услуги';
  if (n >= 8500 && n <= 8599)  return 'Образование';
  if (n >= 8600 && n <= 8899)  return 'Здравоохранение';

  // Ключевые слова в названии
  const nl = name.toLowerCase();
  if (/логист|транспорт|перевоз|экспед|карго|cargo|freight/.test(nl)) return 'Транспорт и логистика';
  if (/торгов|трейд|trade/.test(nl))  return 'Оптовая торговля';
  if (/строй|монтаж|строительств/.test(nl)) return 'Строительство';

  return '';
}

export default router;
