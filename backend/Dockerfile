FROM node:20-alpine

WORKDIR /app

# Копируем package-lock.json — npm ci использует его для воспроизводимой сборки
# и не позволяет drift'у зависимостей. --ignore-scripts блокирует postinstall-скрипты
# (supply-chain защита), --omit=dev исключает dev-зависимости из образа.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && \
    apk add --no-cache curl

# --chown=node:node: файлы принадлежат непривилегированному пользователю node
COPY --chown=node:node . .

# Запускаем от непривилегированного пользователя (uid 1000).
# node:20-alpine уже содержит этого пользователя.
# Это закрывает эскалацию привилегий при RCE внутри контейнера.
USER node

CMD ["sh", "-c", "node db/migrate.js && node server.js"]

EXPOSE 3000
