#!/usr/bin/env bash
# =============================================================================
# backup-s3.sh — pg_dump → gzip → S3
#
# Расположение на сервере: /opt/logicrm/scripts/backup-s3.sh
# Права:                   chmod 750 /opt/logicrm/scripts/backup-s3.sh
#
# Запуск вручную:
#   /opt/logicrm/scripts/backup-s3.sh
#
# Автоматически (crontab -e для пользователя deploy):
#   0 2 * * * /opt/logicrm/scripts/backup-s3.sh >> /var/log/logicrm-backup.log 2>&1
#
# Требования:
#   • docker (pg_dump запускается внутри контейнера logicrm_db)
#   • aws CLI v2 (установка: https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html)
#   • Настроенные AWS-credentials: ~/.aws/credentials или переменные окружения
#     AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_DEFAULT_REGION
#
# Конфигурация: задавайте переменные в /opt/logicrm/.env.backup
# (или экспортируйте перед вызовом скрипта)
# =============================================================================

set -euo pipefail

# ── Цвета для консольного вывода ─────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "$(date '+%Y-%m-%d %H:%M:%S') ${GREEN}[INFO]${NC}  $*"; }
warn() { echo -e "$(date '+%Y-%m-%d %H:%M:%S') ${YELLOW}[WARN]${NC}  $*"; }
err()  { echo -e "$(date '+%Y-%m-%d %H:%M:%S') ${RED}[ERROR]${NC} $*" >&2; }

# ── Загружаем конфиг из файла (если есть) ────────────────────────────────────
ENV_FILE="/opt/logicrm/.env.backup"
if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  log "Загружена конфигурация из ${ENV_FILE}"
fi

# ── Параметры (можно переопределить через env) ────────────────────────────────
DB_CONTAINER="${DB_CONTAINER:-logicrm_db}"
DB_USER="${DB_USER:-logicrm}"
DB_NAME="${DB_NAME:-logicrm}"
S3_BUCKET="${S3_BUCKET:?Переменная S3_BUCKET не задана. Установите её в ${ENV_FILE}}"
S3_PREFIX="${S3_PREFIX:-backups}"                   # папка внутри бакета
S3_STORAGE_CLASS="${S3_STORAGE_CLASS:-STANDARD_IA}" # STANDARD_IA дешевле для редкого доступа
BACKUP_DIR="${BACKUP_DIR:-/home/deploy/backups}"
RETENTION_LOCAL_DAYS="${RETENTION_LOCAL_DAYS:-7}"   # хранить локально N дней
RETENTION_S3_DAYS="${RETENTION_S3_DAYS:-90}"        # хранить в S3 N дней (lifecycle policy)

# ── Переменные ────────────────────────────────────────────────────────────────
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
FILENAME="logicrm_${TIMESTAMP}.sql.gz"
FILEPATH="${BACKUP_DIR}/${FILENAME}"
S3_PATH="s3://${S3_BUCKET}/${S3_PREFIX}/${FILENAME}"

# ── Вспомогательные функции ───────────────────────────────────────────────────

# Trap: вызывается при любом выходе
cleanup() {
  local exit_code=$?
  if [[ ${exit_code} -ne 0 ]]; then
    err "Бэкап завершился с ошибкой (код ${exit_code})"
    # Удаляем частично записанный файл
    [[ -f "${FILEPATH}" ]] && rm -f "${FILEPATH}" && warn "Удалён незавершённый файл ${FILEPATH}"
    notify_failure "${exit_code}"
  fi
}
trap cleanup EXIT

# Опциональное уведомление в Telegram при ошибке
notify_failure() {
  local code=$1
  if [[ -n "${TG_BOT_TOKEN:-}" && -n "${TG_CHAT_ID:-}" ]]; then
    curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage" \
      -d chat_id="${TG_CHAT_ID}" \
      -d text="❌ LogiCRM backup failed (code ${code}) on $(hostname) at $(date '+%Y-%m-%d %H:%M')" \
      > /dev/null || true
  fi
}

# ── Проверки перед запуском ───────────────────────────────────────────────────

log "=== LogiCRM Backup ==="
log "БД: ${DB_NAME} @ контейнер ${DB_CONTAINER}"
log "Назначение: ${S3_PATH}"

# Проверяем что контейнер БД запущен
if ! docker inspect --format='{{.State.Running}}' "${DB_CONTAINER}" 2>/dev/null | grep -q "true"; then
  err "Контейнер ${DB_CONTAINER} не запущен"
  exit 1
fi

# Проверяем AWS CLI
if ! command -v aws &> /dev/null; then
  err "AWS CLI не установлен. Установите: https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html"
  exit 1
fi

# Проверяем доступ к S3-бакету
if ! aws s3 ls "s3://${S3_BUCKET}" > /dev/null 2>&1; then
  err "Нет доступа к S3-бакету s3://${S3_BUCKET}. Проверьте AWS credentials и права IAM."
  exit 1
fi

# Создаём директорию для локальных бэкапов
mkdir -p "${BACKUP_DIR}"
log "Локальная директория: ${BACKUP_DIR}"

# ── Создаём дамп ─────────────────────────────────────────────────────────────

log "Запускаем pg_dump..."

# pg_dump внутри контейнера, результат пайпится в gzip локально.
# Это безопаснее чем pg_dump > file в контейнере (не занимаем место внутри контейнера).
docker exec "${DB_CONTAINER}" \
  pg_dump \
    --username="${DB_USER}" \
    --no-password \
    --format=plain \
    --encoding=UTF8 \
    "${DB_NAME}" \
  | gzip -9 > "${FILEPATH}"

# Проверяем что файл не пустой
FILESIZE="$(stat -c%s "${FILEPATH}" 2>/dev/null || echo 0)"
if [[ "${FILESIZE}" -lt 1024 ]]; then
  err "Файл бэкапа подозрительно маленький (${FILESIZE} байт). Возможно pg_dump завершился с ошибкой."
  exit 1
fi

log "Дамп создан: ${FILEPATH} ($(numfmt --to=iec "${FILESIZE}"))"

# ── Загружаем в S3 ────────────────────────────────────────────────────────────

log "Загружаем в S3..."

aws s3 cp \
  "${FILEPATH}" \
  "${S3_PATH}" \
  --storage-class "${S3_STORAGE_CLASS}" \
  --no-progress

log "Загружено в S3: ${S3_PATH}"

# Верифицируем: файл действительно появился в S3
aws s3 ls "${S3_PATH}" > /dev/null
log "Верификация S3 ОК"

# ── Очистка старых локальных бэкапов ─────────────────────────────────────────

LOCAL_DELETED=$(find "${BACKUP_DIR}" -name "logicrm_*.sql.gz" -mtime "+${RETENTION_LOCAL_DAYS}" -print -delete | wc -l)
if [[ "${LOCAL_DELETED}" -gt 0 ]]; then
  log "Удалено старых локальных бэкапов: ${LOCAL_DELETED} (старше ${RETENTION_LOCAL_DAYS} дней)"
fi

# ── Итог ─────────────────────────────────────────────────────────────────────

log "=== Бэкап завершён успешно ==="
log "Файл:    ${FILENAME}"
log "Размер:  $(numfmt --to=iec "${FILESIZE}")"
log "S3:      ${S3_PATH}"
log "Хранить: ${RETENTION_S3_DAYS} дней (настройте Lifecycle Policy в S3 бакете)"
