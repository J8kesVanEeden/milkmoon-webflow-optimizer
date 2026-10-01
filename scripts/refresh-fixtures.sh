#!/usr/bin/env bash
# Refresh test/fixtures/*.html from real Webflow sites (6.0 Task 10).
# Pages are trimmed: inline <script> bodies over 2 KB are replaced with a marker, so fixtures stay
# small while every tag the rewriter touches (img/source/link/script src/meta/style) is kept.
# Usage: bash scripts/refresh-fixtures.sh    (then: npm test)
#   FIXTURE_KEEP_ON_FAIL=1  keep the previous fixture for a site that does not return a Webflow page
#   (the scheduled monitor uses this: some sites answer data-centre IPs differently) and continue.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p test/fixtures

# name|url — keep a spread: ours, template marketplaces, a big brand on the legacy CDN hosts,
# and a CMS-heavy listing page.
SITES=(
  "milkmoon|https://milkmoonstudio-redesign.webflow.io/"
  "flowbase|https://www.flowbase.co/"
  "finsweet|https://finsweet.com/"
  "mural|https://www.mural.co/"
  "flowbase-blog|https://www.flowbase.co/blog"
)

for entry in "${SITES[@]}"; do
  name="${entry%%|*}"
  url="${entry#*|}"
  tmp="$(mktemp)"
  curl -sSL --compressed -A 'Mozilla/5.0 (fixture refresh; webflow-o2o tests)' "$url" -o "$tmp"
  if ! python3 - "$tmp" "test/fixtures/$name.html" "$url" <<'PY'
import re, sys
src, dst, url = sys.argv[1], sys.argv[2], sys.argv[3]
html = open(src, encoding='utf-8', errors='replace').read()
def trim(m):
    open_tag, body, close = m.group(1), m.group(2), m.group(3)
    if 'src=' in open_tag or len(body) <= 2048:
        return m.group(0)
    return f'{open_tag}/* trimmed {len(body)} bytes */{close}'
html = re.sub(r'(<script\b[^>]*>)(.*?)(</script>)', trim, html, flags=re.S | re.I)
if not re.search(r'<html\b[^>]*\bdata-wf-site="[0-9a-f]{24}"', html, re.I):
    sys.exit(f'NOT A WEBFLOW PAGE (no data-wf-site): {url}')
open(dst, 'w', encoding='utf-8').write(f'<!-- fixture: {url} -->\n' + html)
print(f'{dst}: {len(html):,} bytes')
PY
  then
    if [ "${FIXTURE_KEEP_ON_FAIL:-0}" = 1 ]; then echo "KEPT previous fixture for $name ($url)"; else rm -f "$tmp"; exit 1; fi
  fi
  rm -f "$tmp"
done
