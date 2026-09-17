#!/usr/bin/env bash
set -euo pipefail
export MAUXI_STATE_DIR="${MAUXI_STATE_DIR:-$PWD/.mauxi-turbopack-state}"
cleanup() {
  npm run instrument:clean >/dev/null || true
}
trap cleanup EXIT INT TERM
npm run build
npm run instrument:apply
npx playwright test --config playwright.turbopack.config.ts "$@"
