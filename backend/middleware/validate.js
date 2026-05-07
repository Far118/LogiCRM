/**
 * middleware/validate.js
 *
 * Принимает Zod-схему, возвращает Express middleware.
 *
 * При ошибке валидации отвечает 400 с массивом проблем:
 *   { error: 'Ошибка валидации', errors: [{ field, message }] }
 *
 * При успехе заменяет req.body распарсенными данными — Zod автоматически
 * отрезает поля, которых нет в схеме (strip by default), что защищает
 * от mass-assignment атак.
 *
 * Использование:
 *   import { validate } from '../middleware/validate.js';
 *   router.post('/', authenticate, validate(MySchema), handler);
 */

export function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      const errors = result.error.errors.map(e => ({
        field:   e.path.join('.') || 'body',
        message: e.message,
      }));
      return res.status(400).json({ error: 'Ошибка валидации', errors });
    }

    // Заменяем req.body провалидированными и очищенными данными
    req.body = result.data;
    next();
  };
}
