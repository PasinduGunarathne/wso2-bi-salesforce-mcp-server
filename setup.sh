#!/usr/bin/env bash
# Convenience wrapper: ensure deps + build, then run the .env-driven setup.
# Usage:  ./setup.sh [--no-deploy] [--no-build]
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "✗ No .env found. Create one first:  cp .env.example .env  (then fill it in)"
  exit 1
fi

[ -d node_modules ] || { echo "▶ Installing dependencies…"; npm install; }
[ -f dist/index.js ] || { echo "▶ Building the server…"; npm run build; }

exec node scripts/setup.mjs "$@"
