#!/usr/bin/env bash
# Live smoke check for ANY install — run BEFORE and AFTER every deploy.
# Usage: bash scripts/verify.sh <site-url> [expected-version]
#   e.g. bash scripts/verify.sh https://www.milkmoonstudio.com 6.0.0
# Version is read from x-edge-worker (6.x: "webflow-o2o/<v>") or X-MMS-Worker (5.x).
# Exit 0 = OK. Fails on: homepage not 200, wrong version, no proxied asset, a proxied asset or image
# not 200, Turnstile proxied.
set -euo pipefail

SITE="${1:?site url, e.g. https://www.milkmoonstudio.com}"; SITE="${SITE%/}"
WANT="${2:-}"
TMP=$(mktemp); HDR=$(mktemp)
trap 'rm -f "$TMP" "$HDR"' EXIT
HOST_RE=$(printf '%s' "$SITE" | sed 's/[.]/\\./g')

version_of() { # headers file → version or empty
  local v
  v=$(grep -i '^x-edge-worker:' "$1" | tail -1 | cut -d: -f2- | tr -d ' \r' | sed 's#.*/##')
  [ -n "$v" ] || v=$(grep -i '^x-mms-worker:' "$1" | tail -1 | cut -d: -f2- | tr -d ' \r')
  printf '%s' "$v"
}

echo "== HTML ($SITE/) =="
STATUS=$(curl -s -D "$HDR" -o "$TMP" -w '%{http_code}' "$SITE/")
echo "status=$STATUS bytes=$(wc -c < "$TMP" | tr -d ' ')"
[ "$STATUS" = "200" ] || { echo "FAIL: homepage not 200"; exit 1; }
VER=$(version_of "$HDR")
echo "worker-version=${VER:-(none)}"
echo "html-cache-control=$(grep -i '^cache-control' "$HDR" | tail -1 | tr -d '\r')"
if [ -n "$WANT" ] && [ "$VER" != "$WANT" ]; then echo "FAIL: expected version $WANT, got '${VER:-none}'"; exit 1; fi

echo
echo "== rewrite counts =="
for p in /_img/ /_wf/ /cdn-cgi/image/ /img-original/ /img-cache/ /asset-cache/; do
  printf '%-16s %s\n' "$p" "$(grep -o "$p" "$TMP" | wc -l | tr -d ' ')"
done

echo
echo "== Webflow CDN URLs still in rewritable attributes (info; font preloads, AVIF og:image and /dist/ chunks are expected) =="
grep -oE '(src|href|content|poster)="https://(cdn\.prod|assets|assets-global)\.website-files\.com/[0-9a-f]{24}/[^"]+"' "$TMP" | head -10 || echo "(none)"

# No match is normal (e.g. no /_wf/ on a 5.x install) — never let grep's exit 1 abort under set -e.
first() { { grep -oE "\"$HOST_RE($1)[^\"]*\"" "$TMP" || true; } | head -1 | tr -d '"' | sed 's/&amp;/\&/g'; }

echo
echo "== sample proxied file =="
ASSET=$(first '/_wf/'); [ -n "$ASSET" ] || ASSET=$(first '/asset-cache/')
[ -n "$ASSET" ] || { echo "FAIL: no /_wf/ or /asset-cache/ URL in the HTML"; exit 1; }
echo "$ASSET" | cut -c1-140
curl -sI "$ASSET" | grep -iE '^(HTTP|content-type|cache-control|cf-cache-status|x-cache)' | tr -d '\r'
[ "$(curl -s -o /dev/null -w '%{http_code}' "$ASSET")" = "200" ] || { echo "FAIL: proxied file not 200"; exit 1; }

echo
echo "== sample image =="
IMG=$(first '/_img/'); [ -n "$IMG" ] || IMG=$(first '/cdn-cgi/image/')
if [ -n "$IMG" ]; then
  echo "$IMG" | cut -c1-140
  curl -sI "$IMG" -H 'Accept: image/avif,image/webp,image/*' | grep -iE '^(HTTP|content-type|cf-resized|cf-cache-status|vary|warning)' | tr -d '\r'
  [ "$(curl -s -o /dev/null -w '%{http_code}' -H 'Accept: image/avif,image/webp,image/*' "$IMG")" = "200" ] || { echo "FAIL: image not 200"; exit 1; }
else
  echo "WARN: no /_img/ or /cdn-cgi/image/ URL in the HTML"
fi

echo
echo "== Turnstile untouched (must load from challenges.cloudflare.com directly) =="
if grep -qE '(_wf/|asset-cache/)[^"]*challenges' "$TMP"; then echo "FAIL: Turnstile proxied"; exit 1; fi
grep -oE '<script[^>]*challenges\.cloudflare\.com[^>]*>' "$TMP" || echo "(no Turnstile script on the homepage)"

echo
echo "OK"
