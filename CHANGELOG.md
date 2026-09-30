# Changelog

## 6.0.0 — unreleased (branch `feat/v6.0`)

**The Worker becomes reusable: any Webflow site on Cloudflare can install it with one secret.**

- **Signed URLs replace site IDs.** Every Webflow CDN URL on a page becomes
  `/_img/<preset>/<sig>/<host><path>` (resized, AVIF/WebP per browser) or `/_wf/<sig>/<host><path>`
  (as-is). The routes serve only signatures this Worker wrote (HMAC-SHA256, 96 bits), so the proxy
  cannot relay other tenants on Webflow's shared CDN and there are no IDs to maintain.
- **Webflow auto-detect.** Only pages with Webflow's `data-wf-site` marker are rewritten; any other
  response is byte-identical. The host comes from the request (no `DOMAIN` setting).
- **Workers Cache** serves `/_wf` + `/_img` without running the Worker on a hit. Every other response
  is marked `Cloudflare-CDN-Cache-Control: no-store` so a page or sitemap is never pinned.
- **HTML is not cached in the zone by default** (`HTML_EDGE_TTL=0`): Webflow's own edge caches it and
  purges on publish, and zone caching happens before detection could stop it on a non-Webflow host.
  Positive values restore the 5.x behaviour for routes that cover only the Webflow site.
- **Fail-safe config.** Only `SIGNING_KEY` (≥32 chars) is required; a missing or bad config passes
  all traffic through untouched.
- **Legacy URL shapes** (`/img-original/`, `/img-cache/`, `/asset-cache/`) behind `LEGACY_ROUTES`,
  locked to `WEBFLOW_SITE_IDS` and `LEGACY_DOMAIN` — for sites that ran 4.x/5.x.
- Also: spec-compliant `srcset` parsing (commas in filenames), protocol-relative Webflow URLs,
  GIFs never converted to AVIF (animation), SVG proxied with a sandbox CSP, 5xx never cached,
  og:url escaping no longer double-escapes entities, identity header `x-edge-worker: webflow-o2o/<v>`
  (replaces the site-specific `X-MMS-Worker`).
- Code split into modules: `config`, `sign`, `detect`, `webflow`, `urls`, `routes`, `rewrite`,
  `legacy`, `index`.

## 5.x — single-site (www.milkmoonstudio.com)

- **5.4.0 (2026-09-29)** — `compatibility_date` 2023-07-19 → 2026-09-01 (moved alone, deliberately);
  Workers Logs on at 10% sampling.
- **5.3.1 (2026-09-29)** — no double-decode of crawler-decoded inner URLs; Link-header rewrite
  limited to style/script/image(+imagesrcset)/modulepreload (fonts untouched, in the Link header and
  in HTML `<link rel=preload as=font>`); 5xx never stored at the edge (`cacheTtlByStatus` -1);
  proxied Webflow 404/410 cached 60 s, not 1 year; half-decoded inner URLs still accepted.
- **5.3.0 (2026-09-28)** — byte-exact proxy URL encoding (`%2520` fix), tolerant inner-URL parsing
  (BingBot), no AVIF into the transformer, Early Hints `Link` rewrite, 404 pages optimised, host
  lists from the CDN scan, Smart Placement off.
- **5.2.0 (2026-09-28)** — SECURITY: proxy locked to our Webflow site/CMS ids (it was an open relay
  for every Webflow tenant's assets and billable transformations); jQuery host locked to
  `/js/jquery*`; legacy third-party relay hosts removed.
- **5.1.0 (2026-08-06)** — injects `og:url` (Webflow never emits one).
- **5.0.0 (2026-07-22)** — streaming HTMLRewriter port of v4.4:
  1. HTMLRewriter replaces ~8 regex passes; HTML streams instead of being buffered.
  2. Fix: OG/Twitter images actually rewritten (v4 regex expected `property` before `content`;
     Webflow writes `content` first, so the feature was silently dead).
  3. Fix: favicon / apple-touch-icon rewritten (same attribute-order bug).
  4. New: `<link rel=preload as=image>` href + imagesrcset rewritten to match the `<img>`.
  5. HTML browser caching: `max-age=0, must-revalidate` (origin sent 16 days). 5.0.1: HTML edge TTL
     600 s — Webflow does NOT purge the customer's zone on publish (disproved 2026-07-22).
  6. Allowlist replaces the `CATCH_ALL_EXTERNAL` blacklist (blacklists fail open — the Turnstile
     outage, docs/INCIDENT-2026-07-16.md).

## ≤ 4.4

Dashboard-edited Worker; history in git (split from `milk-moon-edge-workers/webflow-cdn-proxy`).
