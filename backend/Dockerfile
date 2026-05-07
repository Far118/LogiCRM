FROM node:20-alpine

WORKDIR /app

# Сначала копируем только package.json — кэшируем слой зависимостей
COPY package.json ./
RUN npm install --omit=dev

# Копируем исходники
COPY . .

# Применяем миграции и стартуем
CMD ["sh", "-c", "node db/migrate.js && node server.js"]

EXPOSE 3000
