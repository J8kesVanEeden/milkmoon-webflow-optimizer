#!/usr/bin/env bash
# Daily tier of the monitor (docs/MONITORING-PLAN.md): every check runs even if an earlier one fails;
# the combined Markdown report goes to $1 and the exit code is 1 if anything failed.
# Usage: bash scripts/monitor-daily.sh report.md     (CF_API_TOKEN optional; logs skipped without it)
set -u
cd "$(dirname "$0")/.."
OUT="${1:-monitor-report.md}"; : > "$OUT"
FAIL=0
section() { printf '\n%s\n\n' "$1" >> "$OUT"; }

# 1. Full audit of every page + every proxied file, per install
python3 - <<'PY' > /tmp/monitor-sites.txt
import json
for s in json.load(open('monitor/sites.json'))['sites']:
    print(s['name'], s['url'], s['worker'], s['version'])
PY
while read -r name url worker version; do
  section "## Full-site audit — $name ($url)"
  if python3 scripts/site-audit.py "$version" --site "$url" --worker "$worker" > /tmp/audit-$name.txt 2>&1; then
    echo "✅ $(tail -1 /tmp/audit-$name.txt)" >> "$OUT"
  else
    FAIL=1; echo '❌ audit failed:' >> "$OUT"; echo '```' >> "$OUT"; tail -25 /tmp/audit-$name.txt >> "$OUT"; echo '```' >> "$OUT"
  fi
done < /tmp/monitor-sites.txt

# 2. Did Webflow start using new hosts / script types on our pages?
MONITOR_REPORT=/tmp/drift.md python3 scripts/monitor.py drift > /dev/null || FAIL=1
cat /tmp/drift.md >> "$OUT"

# 3. Today's real Webflow pages from 5 sites still handled by the code? (fixture tests on fresh copies)
section "## Fresh Webflow fixtures (5 real sites, downloaded now) through the test suite"
if FIXTURE_KEEP_ON_FAIL=1 bash scripts/refresh-fixtures.sh > /tmp/fixtures.txt 2>&1 && npm ci --silent > /dev/null 2>&1 && NO_COLOR=1 npx vitest run > /tmp/tests.txt 2>&1; then
  echo "✅ $(grep -E 'Tests ' /tmp/tests.txt | tr -s ' ')" >> "$OUT"
  grep -E 'KEPT|NOT A WEBFLOW' /tmp/fixtures.txt | sed 's/^/- note: /' >> "$OUT" || true
else
  FAIL=1; echo '❌ fixtures or tests failed — Webflow may have changed its markup:' >> "$OUT"
  echo '```' >> "$OUT"; { tail -5 /tmp/fixtures.txt; grep -E 'FAIL|×|Tests ' /tmp/tests.txt | head -20; } >> "$OUT"; echo '```' >> "$OUT"
fi

# 4. Logs and edge analytics (Workers Logs + zone GraphQL), last 24 h
MONITOR_REPORT=/tmp/logs.md python3 scripts/monitor.py logs > /dev/null || FAIL=1
cat /tmp/logs.md >> "$OUT"

cat "$OUT"
exit $FAIL
