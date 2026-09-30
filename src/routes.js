// Serves the two signed proxy routes. Only URLs the Worker itself signed are served (see urls.js), so
// neither route can be used as an open relay. Responses carry their own Cache-Control, which Workers
// Cache honours: 2xx for a year, 404/410 for 60s, errors and 5xx never.
import { parseSigned } from './urls.js';
import { extOf } from './webflow.js';

const FONT_EXT = ['woff', 'woff2', 'ttf', 'otf', 'eot'];
const NO_TRANSFORM_EXT = ['avif', 'svg']; // AVIF input unsupported; SVG never resized
const FALLBACK_TYPES = {
  css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  json: 'application/json',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};
// Short negative caching so a briefly-missing Webflow file is not pinned as a 404 for a year.
const NEGATIVE_TTL = 60;
// Original bytes served because the transformer failed: cache for an hour, not a year.
const FALLBACK_TTL = 3600;

const plain = (status, msg, cacheControl = 'no-store') =>
  new Response(msg, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': cacheControl } });

// Error statuses from the origin: 404/410 cached briefly, everything else (incl. all 5xx) never.
const originError = (status) =>
  plain(status, 'Origin ' + status, status === 404 || status === 410 ? `public, max-age=${NEGATIVE_TTL}` : 'no-store');

// Clients never choose width/quality/format directly: only named presets, plus format negotiation.
export function imageOptions(preset, ext, accept, config) {
  if (preset === 'og') return { format: config.OG_FORMAT, quality: config.OG_QUALITY };
  const a = accept || '';
  const o = {};
  // AVIF output isn't animated, so a (possibly animated) GIF only ever becomes WebP.
  if (ext !== 'gif' && /image\/avif/.test(a)) o.format = 'avif';
  else if (/image\/webp/.test(a)) o.format = 'webp';
  o.quality = config.IMAGE_QUALITY;
  return o;
}

function cacheControl(config) {
  return config.EDGE_TTL === config.BROWSER_TTL
    ? `public, max-age=${config.BROWSER_TTL}, immutable`
    : `public, max-age=${config.BROWSER_TTL}, s-maxage=${config.EDGE_TTL}, immutable`;
}

async function originFetch(href, method, cf) {
  try {
    return await fetch(href, { method, cf });
  } catch (e) {
    console.error('origin fetch failed', href, e && e.message);
    return null;
  }
}

export async function handleSigned(request, url, config, signer) {
  if (!url.pathname.startsWith('/_wf/') && !url.pathname.startsWith('/_img/')) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return plain(405, 'Method not allowed');

  const target = await parseSigned(url.pathname, url.search, signer);
  if (!target) return plain(403, 'Bad or missing signature');

  const ext = extOf(target.url);
  const method = request.method;
  const transform = target.kind === 'img' && !NO_TRANSFORM_EXT.includes(ext);
  const plainCf = { cacheEverything: true, cacheTtlByStatus: { '200-299': config.EDGE_TTL, '404': NEGATIVE_TTL, '410': NEGATIVE_TTL, '500-599': -1 } };

  let origin = transform
    ? await originFetch(target.url.href, method, { image: imageOptions(target.preset, ext, request.headers.get('Accept'), config) })
    : await originFetch(target.url.href, method, plainCf);

  let fellBack = false;
  if (transform && (!origin || !origin.ok)) {
    // Transformer failure (unsupported input, size limit, free-plan quota error 9422): serve the
    // original bytes rather than a broken image — cached briefly, so the optimised version takes
    // over once the transformer works again.
    origin = await originFetch(target.url.href, method, plainCf);
    fellBack = true;
  }
  if (!origin) return plain(502, 'Origin fetch failed');
  if (!origin.ok) return originError(origin.status);

  // Generic/missing types are replaced by the real one: with nosniff, a script or stylesheet served
  // as octet-stream would be blocked by the browser (older S3-backed Webflow hosts do this).
  const originType = origin.headers.get('Content-Type') || '';
  const generic = !originType || /^(application|binary)\/octet-stream\b/i.test(originType);
  const type = generic ? FALLBACK_TYPES[ext] || originType || 'application/octet-stream' : originType;
  if (FONT_EXT.includes(ext) && /text\/html/i.test(type)) return plain(502, 'Origin returned HTML for a font');
  if (target.kind === 'img' && !/^image\//i.test(type)) return plain(502, 'Origin returned a non-image');

  const h = new Headers({
    'Content-Type': type,
    'Cache-Control': fellBack ? `public, max-age=${FALLBACK_TTL}` : cacheControl(config),
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
  });
  if (target.kind === 'img') h.set('Vary', 'Accept');
  // SVG is now served from the site's own origin: never let script inside it run there.
  if (ext === 'svg' || /svg/i.test(type)) h.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");

  return new Response(method === 'HEAD' ? null : origin.body, { status: 200, headers: h });
}
