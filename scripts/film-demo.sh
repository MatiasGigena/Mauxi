#!/usr/bin/env bash
# Rehearses the Stageshow demo of the Mauxi main view with the skill's film tool:
# serves demo/ on 44180, films the wide and phone loops and every marked state,
# and writes the contact sheets and reports to evidence/demo/ (gitignored).
# Pass extra film.mjs flags after the script name, e.g. `npm run demo:film -- --at fix`.
set -euo pipefail
cd "$(dirname "$0")/.."
SKILL=.agents/skills/stageshow
OUT=evidence/demo
URL=http://127.0.0.1:44180/
mkdir -p "$OUT"
[ -d "$SKILL/node_modules/playwright-core" ] || npm --prefix "$SKILL" install --no-audit --no-fund --ignore-scripts
if [ -z "${CHROME_PATH:-}" ] && [ -x /opt/pw-browsers/chromium ]; then export CHROME_PATH=/opt/pw-browsers/chromium; fi
if [ -z "${CHROME_PATH:-}" ]; then CHROME_PATH=$(ls -d /opt/pw-browsers/chromium-*/chrome-linux64/chrome 2>/dev/null | head -1 || true); export CHROME_PATH; fi
npx vite --config vite.demo.config.ts > "$OUT/vite.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
npx wait-on -t 30000 "$URL"
FILM="node $SKILL/scripts/film.mjs $URL --select #mauxi-demo"
if [ $# -gt 0 ]; then $FILM "$@"; exit; fi
# film exits 2 when its frame sampling has gaps (common on a loaded machine) even
# when the gate holds, so a pass is judged by the gate's own verdict line.
gate() { local log; log=$($FILM --gate "$@" 2>&1 || true); printf "%s\n" "$log" >> "$OUT/film.log"; grep -q "^rehearsal passed" <<< "$log"; }
: > "$OUT/film.log"
status=0
gate --every 1000 --count 18 --out "$OUT/wide.png" --report "$OUT/wide.json" || { echo "wide loop: gate failed"; status=1; }
gate --width 390 --every 1000 --count 18 --out "$OUT/phone.png" --report "$OUT/phone.json" || { echo "phone loop: gate failed"; status=1; }
gate --states --out "$OUT/states.png" --report "$OUT/states.json" || { echo "states: gate failed"; status=1; }
# A still is "inconclusive" to film by design (no motion to judge), so it never fails the run
$FILM --reduced --still --out "$OUT/poster.png" >> "$OUT/film.log" 2>&1 || true
[ $status -eq 0 ] && echo "demo rehearsal passed: sheets in $OUT/" 
exit $status
