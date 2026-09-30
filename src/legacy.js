// Legacy (v4.4–v5.x) proxy URL shapes — OPT-IN via LEGACY_ROUTES, for installs that ran the old
// Worker. New HTML never emits these; they stay served because Google Images, old edge-cached HTML
// and social previews still request them:
//   /img-original/<encoded webflow url>   fetched by Cloudflare's /cdn-cgi/image/… transformer
//   /img-cache/<encoded webflow url>      AVIF passthrough
//   /asset-cache/<encoded webflow url>    CSS/JS/fonts/icons
// Unsigned, so they are locked to WEBFLOW_SITE_IDS (Webflow CDNs are multi-tenant) and answer only
// on LEGACY_DOMAIN. Cloudflare's own /cdn-cgi/image/ endpoint is outside the Worker: guard it with a
// WAF rule that only allows your old parameter strings with your own /img-original/ source.
import { WEBFLOW_ASSET_HOSTS, JQUERY_HOST, isNeverProxied } from './webflow.js';

const ROUTES = {
  '/img-cache/': { accept: 'image/avif,image/webp,image/*,*/*', requireImage: true, useCacheApi: true },
  // Fetched by the image transformer, not browsers: the cf fetch cache is the cache layer here.
  '/img-original/': { accept: 'image/*,*/*', requireImage: true, useCacheApi: false },
  '/asset-cache/': { accept: '*/*', requireImage: false, useCacheApi: true },
};
const FONT_EXT = ['woff', 'woff2', 'ttf', 'otf', 'eot'];
const FALLBACK_TYPES = {
  css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  ico: 'image/x-icon',
};

/**
 * Edge TTLs for proxied Webflow fetches, by status (5.3.1). Plain cacheTtl caches EVERY status for
 * the full TTL, so a briefly-404ing asset could be pinned as a 404 for a year. Negative = never store.
 */
export function proxyCacheTtlByStatus(ttl) {
  return { '200-299': ttl, '404': 60, '410': 60, '500-599': -1 };
}

const errorResponse = (status, message) =>
  new Response(message, { status, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });

const preflight = () =>
  new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept',
      'Access-Control-Max-Age': '86400',
    },
  });

function getExtension(pathname) {
  const filename = pathname.split('/').pop();
  if (!filename || !filename.includes('.')) return null;
  const ext = filename.split('.').pop().toLowerCase();
  return ext && ext.length <= 5 && /^[a-z0-9]+$/.test(ext) ? ext : null;
}

/**
 * Proxy paths carry the Webflow URL encodeURIComponent'd (5.3+). Pre-5.3 URLs were encoded after a
 * decode (a real space arrives as "%20"), and crawlers such as BingBot request the inner URL already
 * decoded, sometimes with "//" collapsed to "/". Decode exactly once and accept all three.
 */
export function parseInnerUrl(encodedPath) {
  let s = encodedPath;
  // "https:/" (a real slash) = crawler-decoded already; decoding again would turn a literal "%2520"
  // in a Webflow filename into "%20" and fetch the wrong file (5.3.1). "https:%2F%2F…" (half-decoded)
  // still needs its one decode.
  if (!/^https?:\//i.test(s)) {
    try {
      s = decodeURIComponent(s);
    } catch {
      return null;
    }
  }
  s = s.replace(/^(https?):\/(?!\/)/i, '$1://');
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

// Webflow CDN hosts: first path segment must be one of our site/CMS ids. jQuery: /js/jquery* only.
function isAllowedOrigin(parsed, config) {
  const h = parsed.hostname.toLowerCase();
  if (isNeverProxied(h)) return false;
  if (WEBFLOW_ASSET_HOSTS.includes(h)) {
    const siteId = (parsed.pathname.split('/')[1] || '').toLowerCase();
    return config.WEBFLOW_SITE_IDS.includes(siteId);
  }
  if (h === JQUERY_HOST) return parsed.pathname.startsWith('/js/jquery');
  return false;
}

export async function handleLegacy(request, url, config, ctx) {
  if (!config.LEGACY_ROUTES) return null;
  if (url.hostname.toLowerCase() !== config.LEGACY_DOMAIN) return null;
  const prefix = Object.keys(ROUTES).find((p) => url.pathname.startsWith(p));
  if (!prefix) return null;
  if (request.method === 'OPTIONS') return preflight();

  const opts = ROUTES[prefix];
  const encodedUrl = url.pathname.slice(prefix.length);
  if (!encodedUrl) return errorResponse(400, 'Missing URL parameter');
  const parsed = parseInnerUrl(encodedUrl);
  if (!parsed) return errorResponse(400, 'Invalid URL');
  if (!isAllowedOrigin(parsed, config)) return errorResponse(403, 'Origin not allowed');

  const cacheKey = new Request(url.toString(), { method: 'GET' });
  let cache = null;
  if (opts.useCacheApi) {
    try {
      cache = caches.default;
      const hit = await cache.match(cacheKey);
      if (hit) {
        const headers = new Headers(hit.headers);
        headers.set('X-Cache', 'HIT');
        return new Response(hit.body, { status: hit.status, headers });
      }
    } catch {
      cache = null; // Cache API unavailable (e.g. workers.dev)
    }
  }

  let origin;
  try {
    origin = await fetch(parsed.href, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Cloudflare-Worker)', Accept: opts.accept },
      cf: { cacheEverything: true, cacheTtlByStatus: proxyCacheTtlByStatus(config.EDGE_TTL) },
    });
  } catch (e) {
    console.error('legacy origin fetch failed', parsed.href, e && e.message);
    return errorResponse(502, 'Failed to fetch from origin');
  }
  if (!origin.ok) return errorResponse(origin.status, 'Origin returned error: ' + origin.status);

  const ext = getExtension(parsed.pathname);
  let contentType = origin.headers.get('Content-Type') || '';
  if (opts.requireImage) {
    if (!contentType.startsWith('image/')) return errorResponse(400, 'Response is not an image (Content-Type: ' + contentType + ')');
  } else if (!contentType) {
    contentType = FALLBACK_TYPES[ext] || 'application/octet-stream';
  } else if (/text\/html/i.test(contentType) && FONT_EXT.includes(ext)) {
    return errorResponse(502, 'Origin returned HTML instead of expected asset');
  }

  const headers = new Headers({
    'Content-Type': contentType,
    'Cache-Control': `public, s-maxage=${config.EDGE_TTL}, max-age=${config.BROWSER_TTL}, immutable`,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'X-Cache': 'MISS',
  });
  const res = new Response(origin.body, { status: 200, headers });
  if (cache) ctx.waitUntil(cache.put(cacheKey, res.clone()).catch((e) => console.error('legacy cache put failed', e && e.message)));
  return res;
}
