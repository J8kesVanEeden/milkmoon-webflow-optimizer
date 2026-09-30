// Every setting is optional except SIGNING_KEY. A bad config never half-works: callers pass traffic
// through untouched when ok === false (and log the errors).

// Whole-digit strings only — parseInt('70abc') would silently give 70.
const num = (v, d, min, max) => {
  const s = String(v ?? '').trim();
  if (!/^\d+$/.test(s)) return d;
  const n = Number(s);
  return n >= min && n <= max ? n : d;
};
const pick = (v, allowed, d) => {
  const s = String(v ?? '').trim().toLowerCase();
  return allowed.includes(s) ? s : d;
};

export function parseConfig(env) {
  env = env || {};
  const errors = [];

  const SIGNING_KEY = typeof env.SIGNING_KEY === 'string' ? env.SIGNING_KEY : '';
  if (SIGNING_KEY.length < 32) errors.push('SIGNING_KEY missing or shorter than 32 characters');

  const LEGACY_ROUTES = String(env.LEGACY_ROUTES ?? '').trim().toLowerCase() === 'true';
  const WEBFLOW_SITE_IDS = Object.freeze(
    String(env.WEBFLOW_SITE_IDS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => /^[0-9a-f]{24}$/.test(s)),
  );
  const LEGACY_DOMAIN = String(env.LEGACY_DOMAIN ?? '').trim().toLowerCase();
  if (LEGACY_ROUTES && (!WEBFLOW_SITE_IDS.length || !LEGACY_DOMAIN)) {
    errors.push('LEGACY_ROUTES needs WEBFLOW_SITE_IDS and LEGACY_DOMAIN');
  }

  const og = pick(env.OG_FORMAT, ['jpeg', 'jpg', 'png', 'webp'], 'jpeg');
  const config = Object.freeze({
    SIGNING_KEY,
    IMAGE_QUALITY: num(env.IMAGE_QUALITY, 85, 1, 100),
    OG_FORMAT: og === 'jpg' ? 'jpeg' : og,
    OG_QUALITY: num(env.OG_QUALITY, 80, 1, 100),
    EDGE_TTL: num(env.EDGE_TTL, 31536000, 0, 31536000),
    BROWSER_TTL: num(env.BROWSER_TTL, 31536000, 0, 31536000),
    // 0 (default) = HTML is NOT cached in this zone: fetched from Webflow's own edge, which caches it
    // and purges on publish. Safe even if the route also covers non-Webflow pages. A positive value
    // edge-caches every HTML response on the route (cacheEverything) BEFORE Webflow detection can run —
    // only for routes that cover nothing but the Webflow site.
    HTML_EDGE_TTL: num(env.HTML_EDGE_TTL, 0, 0, 86400),
    LEGACY_ROUTES,
    WEBFLOW_SITE_IDS,
    LEGACY_DOMAIN,
  });
  return { ok: errors.length === 0, errors, config };
}
