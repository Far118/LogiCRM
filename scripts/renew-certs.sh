#!/usr/bin/env bash
# scripts/renew-certs.sh
#
# Копирует обновлённые сертификаты certbot в /opt/logicrm-certs
# и перезагружает nginx без даунтайма.
#
# Запускать после certbot renew:
#   sudo certbot renew --deploy-hook /opt/logicrm/scripts/renew-certs.sh
#
# Или добавить в crontab (под root):
#   0 3 * * * certbot renew --quiet --deploy-hook /opt/logicrm/scripts/renew-certs.sh

set -euo pipefail

DOMAIN="mankochat.ru"
CERTS_DIR="/opt/logicrm-certs"
ARCHIVE="/etc/letsencrypt/archive/${DOMAIN}"

echo "[renew-certs] Копируем сертификаты ${DOMAIN} → ${CERTS_DIR}"

mkdir -p "${CERTS_DIR}"

# Ищем самые свежие файлы (certbot нумерует: fullchain1.pem, fullchain2.pem...)
FULLCHAIN=$(ls -t "${ARCHIVE}"/fullchain*.pem | head -1)
PRIVKEY=$(ls -t "${ARCHIVE}"/privkey*.pem   | head -1)

cp "${FULLCHAIN}" "${CERTS_DIR}/fullchain.pem"
cp "${PRIVKEY}"   "${CERTS_DIR}/privkey.pem"
chmod 644 "${CERTS_DIR}/fullchain.pem"
chmod 644 "${CERTS_DIR}/privkey.pem"

echo "[renew-certs] Перезагружаем nginx..."
docker exec logicrm_nginx nginx -s reload

echo "[renew-certs] Готово. Сертификат действует до:"
openssl x509 -enddate -noout -in "${CERTS_DIR}/fullchain.pem"
