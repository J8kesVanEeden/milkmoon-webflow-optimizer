/**
 * webflow-o2o — a reusable Cloudflare Worker for Webflow sites on Cloudflare (O2O).
 *
 * Put it on your Webflow site's route. It streams each Webflow page through HTMLRewriter and points
 * every Webflow CDN image, stylesheet, script and font at signed URLs on your own domain:
 *   /_img/<preset>/<sig>/<webflow-host><path>  → resized/re-encoded (AVIF/WebP per browser), cached
 *   /_wf/<sig>/<webflow-host><path>            → the file as-is, cached
 * Both are served from Workers Cache (a repeat request never runs the Worker). Signatures mean only
 * URLs this Worker wrote are served: no site IDs to configure, and no open relay on Webflow's
 * shared CDN.
 *
 * Safe by default:
 *   - only pages carrying Webflow's data-wf-site marker are touched; anything else is byte-identical
 *   - a config error, or an error before the response starts → the origin response, untouched
 *   - nothing but the signed routes is ever stored in Workers Cache
 *   - HTML is not cached in your zone unless HTML_EDGE_TTL > 0 (see src/config.js)
 *   - Turnstile, analytics, tag managers and video are never proxied (src/webflow.js)
 *
 * Only SIGNING_KEY (a secret, ≥32 chars) is required. See README.md and src/config.js.
 * History: CHANGELOG.md (v1–v5 were a single-site Worker).
 */
import { parseConfig } from './config.js';
import { makeSigner } from './sign.js';
import { detectWebflow } from './detect.js';
import { handleSigned } from './routes.js';
import { handleLegacy } from './legacy.js';
import { rewriteWebflowHtml } from './rewrite.js';
import { VERSION } from './version.js';


// Per-isolate: env is stable for a deployment, so config + signer (and its signature memo) are built
// once per env object.
const setups = new WeakMap();
async function setup(env) {
  let s = setups.get(env);
  if (s) return s;
  const r = parseConfig(env);
  s = { ...r, signer: r.ok ? await makeSigner(r.config.SIGNING_KEY) : null };
  if (!r.ok) console.error('webflow-o2o: config invalid, passing all traffic through untouched:', r.errors.join('; '));
  setups.set(env, s);
  return s;
}

/**
 * Pass a response through unchanged, except that Workers Cache must never store it: Webflow sends
 * multi-day max-age on pages and sitemaps, and Workers Cache would otherwise honour it and keep
 * serving the old copy after a publish. Cloudflare strips this header before the browser.
 */
function passthrough(res, contentType) {
  if (res.status === 101 || res.webSocket) return res;
  const out = new Response(res.body, res);
  out.headers.set('Cloudflare-CDN-Cache-Control', 'no-store');
  if (contentType) out.headers.set('Content-Type', contentType);
  return out;
}

// Webflow serves /sitemap.xml as application/rss+xml; a sitemap is plain XML (sitemaps.org). Only that
// exact mislabel is corrected — any other sitemap Content-Type is left as the origin sent it.
const isMislabelledSitemap = (url, res) =>
  url.pathname === '/sitemap.xml' && res.ok && /^application\/rss\+xml\b/i.test(res.headers.get('Content-Type') || '');

function fetchPage(request, config) {
  const cacheable = request.method === 'GET' || request.method === 'HEAD';
  if (!cacheable || config.HTML_EDGE_TTL <= 0) return fetch(request);
  // Opt-in zone caching of HTML (HTML_EDGE_TTL > 0). This caches EVERY response on the route before
  // Webflow detection runs, so it is only for routes that cover nothing but the Webflow site.
  const ttl = config.HTML_EDGE_TTL;
  return fetch(request, {
    cf: {
      cacheEverything: true,
      cacheTtlByStatus: { '200-299': ttl, '300-399': ttl, '404': 300, '410': 300, '500-599': -1 },
    },
  });
}

async function handle(request, env, ctx) {
  const s = await setup(env);
  if (!s.ok) return passthrough(await fetch(request));
  const url = new URL(request.url);

  const signed = await handleSigned(request, url, s.config, s.signer);
  if (signed) return signed;
  const legacy = await handleLegacy(request, url, s.config, ctx);
  if (legacy) return legacy;

  const res = await fetchPage(request, s.config);
  if (isMislabelledSitemap(url, res)) return passthrough(res, 'application/xml; charset=utf-8');
  if (request.method !== 'GET') return passthrough(res);
  if (!/text\/html/i.test(res.headers.get('Content-Type') || '')) return passthrough(res);
  // Webflow's 404 page is a full page of Webflow-CDN assets, billed like any other page.
  const errorPage = res.status === 404 || res.status === 410;
  if (!res.ok && !errorPage) return passthrough(res);

  const d = await detectWebflow(res);
  if (!d.isWebflow) return passthrough(d.response);
  return rewriteWebflowHtml(d.response, {
    origin: url.origin,
    signer: s.signer,
    config: s.config,
    requestUrl: request.url,
    browserCacheControl: errorPage ? 'no-store' : undefined,
    version: VERSION,
  });
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (e) {
      // Resilience over optimisation: on an error before the response starts, serve the untouched
      // origin response. Only GET/HEAD are retried — any other request's body is already used up.
      // (Errors inside the streaming rewrite happen after this point and can't be caught here.)
      console.error('webflow-o2o: error, passing through:', e && e.stack);
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Origin unavailable', { status: 502, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
      }
      return passthrough(await fetch(request));
    }
  },
};
