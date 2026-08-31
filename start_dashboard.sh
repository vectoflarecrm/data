#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

compose_command=""
if docker compose version >/dev/null 2>&1; then
  compose_command="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  compose_command="docker-compose"
fi

if [[ -n "$compose_command" ]]; then
  $compose_command up -d postgres
  for attempt in {1..30}; do
    if $compose_command exec -T postgres pg_isready -U watersports -d watersports >/dev/null 2>&1; then
      break
    fi
    if [[ "$attempt" == "30" ]]; then
      echo "PostgreSQL 启动超时。请运行 '$compose_command logs postgres' 查看日志。" >&2
      exit 1
    fi
    sleep 1
  done
else
  echo "未找到可用的 Docker Compose。请安装 Docker Compose，或先启动本机 PostgreSQL。" >&2
  exit 1
fi

.venv/bin/alembic upgrade head

if command -v xdg-open >/dev/null 2>&1; then
  (sleep 2; xdg-open "http://127.0.0.1:8000/dashboard") >/dev/null 2>&1 &
elif command -v open >/dev/null 2>&1; then
  (sleep 2; open "http://127.0.0.1:8000/dashboard") >/dev/null 2>&1 &
fi

exec env PYTHONPATH=src .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
