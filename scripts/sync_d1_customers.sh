#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHUNK_DIR="${ROOT_DIR}/data/exports/d1_customers_chunks"
CHUNK_SIZE="${D1_SYNC_CHUNK_SIZE:-25}"

cd "$ROOT_DIR"
if [[ -n "${WRANGLER_CONFIG:-}" ]]; then
  WRANGLER_CONFIG="$WRANGLER_CONFIG"
elif [[ -f "${ROOT_DIR}/crm-ai-worker/wrangler.local.toml" ]]; then
  WRANGLER_CONFIG="wrangler.local.toml"
else
  WRANGLER_CONFIG="wrangler.toml"
fi

if [[ ! -x "${ROOT_DIR}/.venv/bin/python" ]]; then
  echo "Missing Python virtual environment: ${ROOT_DIR}/.venv" >&2
  exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "npx is required to execute D1 SQL" >&2
  exit 1
fi

echo "Generating local D1 import files..."
PYTHONPATH=src .venv/bin/python scripts/export_d1_customers.py \
  --output-dir "$CHUNK_DIR" \
  --chunk-size "$CHUNK_SIZE"

echo "Executing generated files against remote D1 crm-ai-db..."
shopt -s nullglob
files=("${CHUNK_DIR}"/*.sql)
if (( ${#files[@]} == 0 )); then
  echo "No SQL files were generated" >&2
  exit 1
fi

for sql_file in "${files[@]}"; do
  echo "Importing $(basename "$sql_file")"
  (
    cd "${ROOT_DIR}/crm-ai-worker"
    npx wrangler --config "$WRANGLER_CONFIG" d1 execute crm-ai-db --remote --file="../data/exports/d1_customers_chunks/$(basename "$sql_file")" --yes
  )
done

echo "Remote D1 customer count:"
(
  cd "${ROOT_DIR}/crm-ai-worker"
  npx wrangler --config "$WRANGLER_CONFIG" d1 execute crm-ai-db --remote \
    --command="SELECT COUNT(*) AS total FROM customers;" \
    --yes
)

echo "Synchronization complete. Generated SQL remains under data/exports/ and is ignored by Git."
