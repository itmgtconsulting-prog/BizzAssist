#!/bin/bash
# ══════════════════════════════════════════════════════════════════════════════
# Backup .env.local til timestamped fil
# Kør manuelt: bash scripts/backup-env.sh
# Eller automatisk via npm script: npm run backup:env
# ══════════════════════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_DIR/.env.local"
BACKUP_DIR="$PROJECT_DIR/.env-backups"

if [ ! -f "$ENV_FILE" ]; then
  echo "⚠️  .env.local ikke fundet — intet at backuppe"
  exit 0
fi

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="$BACKUP_DIR/.env.local.$TIMESTAMP"

cp "$ENV_FILE" "$BACKUP_FILE"
echo "✅ Backup: $BACKUP_FILE ($(wc -l < "$ENV_FILE") linjer)"

# Behold kun de seneste 10 backups
ls -t "$BACKUP_DIR"/.env.local.* 2>/dev/null | tail -n +11 | xargs rm -f 2>/dev/null

# Vis alle backups
echo ""
echo "📁 Backups:"
ls -la "$BACKUP_DIR"/.env.local.* 2>/dev/null | tail -5
