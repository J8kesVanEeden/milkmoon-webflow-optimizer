// Streaming HTML rewrite for Webflow pages: every Webflow CDN URL the page references becomes a
// signed same-origin URL (/_img/… for resizable images, /_wf/… for everything else we proxy).
// Ported from v5; only the EMITTED URL changed. Handlers are async because signing is async —
// HTMLRewriter awaits them without buffering the page.
import { classify } from './webflow.js';
import { wfPath, imgPath } from './urls.js';

const HTML_CACHE_CONTROL = 'public, max-age=0, must-revalidate';
const IMAGE_URL_ATTRS = ['src', 'data-src'];
const SRCSET_ATTRS = ['srcset', 'data-srcset'];
const OG_KEYS = ['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src'];

// Webflow's runtime chunks and Finsweet Attributes scripts must load from their own origins (Finsweet
// resolves sibling modules relative to its script URL; Webflow chunks are version-coupled).
// Only a Finsweet .js FILE matches — not any URL containing "finsweet": Webflow names the site CSS
// after the site ("<site>.webflow.shared.<hash>.min.css"), so the old substring test skipped the
// main stylesheet of every site with "finsweet" in its name (found on finsweet.com, Task 10).
function isWebflowInternalScript(url) {
  const path = url.split('?')[0];
  const file = path.split('/').pop() || '';
  if (/finsweet/i.test(file) && /\.js$/i.test(file) && !/\.webflow\./i.test(file)) return true;
  return path.includes('/dist/chunk-') || (path.includes('/dist/') && path.endsWith('.js'));
}

function parseAbsolute(raw) {
  const s = raw.trim();
  if (!s) return null;
  const withScheme = s.startsWith('//') ? 'https:' + s : s;
  if (!/^https?:\/\//i.test(withScheme)) return null;
  try {
    return new URL(withScheme);
  } catch {
    return null;
  }
}

/**
 * The single URL decision. `want`: 'image' (img/srcset/poster/css url()), 'og', 'asset'
 * (stylesheet/script/modulepreload), 'icon' (image or .ico). Returns the raw value when untouched.
 */
async function toProxy(raw, ctx, want) {
  const u = parseAbsolute(raw);
  if (!u) return raw;
  const c = classify(u);
  if (!c) return raw;

  if (c === 'asset') {
    if (want !== 'asset' && !(want === 'icon' && /\.ico$/i.test(u.pathname))) return raw;
    if (isWebflowInternalScript(u.href)) return raw;
    return ctx.origin + (await wfPath(u, ctx.signer));
  }
  if (want === 'asset') return raw;
  if (c === 'passthrough-image') {
    // AVIF OG images stay on Webflow: social scrapers handle AVIF poorly and it can't be converted.
    if (want === 'og' && /\.avif$/i.test(u.pathname)) return raw;
    return ctx.origin + (await wfPath(u, ctx.signer));
  }
  return ctx.origin + (await imgPath(want === 'og' ? 'og' : 'img', u, ctx.signer));
}

/**
 * srcset per the HTML parsing rules: a URL is a run of non-whitespace (commas inside it are part of
 * the URL unless trailing); descriptors run to the next comma. Returns the input byte-identical when
 * no candidate changes.
 */
function parseSrcset(value) {
  const out = [];
  const n = value.length;
  let i = 0;
  const isWs = (ch) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
  while (i < n) {
    while (i < n && (isWs(value[i]) || value[i] === ',')) i++;
    if (i >= n) break;
    const start = i;
    while (i < n && !isWs(value[i])) i++;
    let url = value.slice(start, i);
    let desc = '';
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      let depth = 0;
      const dStart = i;
      while (i < n) {
        const ch = value[i];
        if (ch === '(') depth++;
        else if (ch === ')') depth = Math.max(0, depth - 1);
        else if (ch === ',' && depth === 0) break;
        i++;
      }
      desc = value.slice(dStart, i).trim();
      if (i < n) i++; // the comma
    }
    if (url) out.push({ url, desc });
  }
  return out;
}

export async function rewriteSrcset(value, ctx) {
  const entries = parseSrcset(value);
  let changed = false;
  const parts = await Promise.all(
    entries.map(async ({ url, desc }) => {
      const next = await toProxy(url, ctx, 'image');
      if (next !== url) changed = true;
      return desc ? `${next} ${desc}` : next;
    }),
  );
  return changed ? parts.join(', ') : value;
}

// url("…") / url('…') read to the matching quote; unquoted url(…) may contain balanced "(…)" pairs —
// Webflow filenames like "card%20(1).png" are common (Figma exports), and stopping at the first ")"
// left them unoptimised.
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|((?:[^"'()\s\\]|\([^"'()\s]*\))+))\s*\)/gi;
async function rewriteCssUrls(css, ctx) {
  const jobs = [];
  css.replace(CSS_URL, (m, dq, sq, bare) => {
    jobs.push(toProxy(dq ?? sq ?? bare, ctx, 'image'));
    return m;
  });
  if (!jobs.length) return css;
  const done = await Promise.all(jobs);
  let k = 0;
  return css.replace(CSS_URL, (m, dq, sq, bare) => {
    const next = done[k++];
    const orig = dq ?? sq ?? bare;
    if (next === orig) return m; // untouched: keep the original bytes exactly
    const q = dq !== undefined ? '"' : sq !== undefined ? "'" : '';
    return `url(${q}${next}${q})`;
  });
}

// Link header entries are separated by commas that precede "<" (a comma inside a quoted param or a
// URL is never followed by "<"). Webflow sends two Link headers; Headers.get joins them ", ".
const splitLinkHeader = (value) => value.split(/,(?=\s*<)/).map((s) => s.trim()).filter(Boolean);

/**
 * Webflow preloads its CSS from its CDN; Cloudflare Early Hints turns that into a 103, so without
 * this the browser downloads each file twice. Point preload targets at the SAME URL the rewritten
 * HTML uses; leave every other entry byte-identical. Fonts are left alone: they load from their own
 * absolute URLs in CSS, so a rewritten preload would double-download them.
 */
export async function rewriteLinkHeader(value, ctx) {
  const entries = await Promise.all(
    splitLinkHeader(value).map(async (entry) => {
      const m = entry.match(/^<([^>]*)>(.*)$/);
      if (!m) return entry;
      const [, target, params] = m;
      const rels = ((params.match(/;\s*rel\s*=\s*"?([^";]+)"?/i) || [])[1] || '').toLowerCase().split(/\s+/);
      if (rels.includes('modulepreload')) return `<${await toProxy(target, ctx, 'asset')}>${params}`;
      if (!rels.includes('preload')) return entry;
      const as = ((params.match(/;\s*as\s*=\s*"?([a-z]+)"?/i) || [])[1] || '').toLowerCase();
      if (as === 'style' || as === 'script') return `<${await toProxy(target, ctx, 'asset')}>${params}`;
      if (as === 'image') {
        let withSet = params;
        const sm = params.match(/(;\s*imagesrcset\s*=\s*")([^"]*)(")/i);
        if (sm) withSet = params.replace(sm[0], sm[1] + (await rewriteSrcset(sm[2], ctx)) + sm[3]);
        return `<${await toProxy(target, ctx, 'image')}>${withSet}`;
      }
      return entry;
    }),
  );
  return entries.join(', ');
}

// HTMLRewriter's getAttribute() returns the attribute text still entity-encoded ("a=1&amp;b=2",
// "url(&quot;…&quot;)"), and setAttribute() escapes `"` but NOT `&` (probed 2026-09-29). So values
// are decoded before any URL work (a URL signed as "&amp;" would never verify once the browser
// decodes it) and `&` is re-encoded on write. Untouched attributes are never re-written.
const ENTITY = /&(?:#(\d+)|#x([0-9a-f]+)|(amp|quot|apos|lt|gt));/gi;
const NAMED = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
const decodeAttr = (v) =>
  v.includes('&')
    ? v.replace(ENTITY, (m, dec, hex, name) =>
        dec ? String.fromCodePoint(+dec) : hex ? String.fromCodePoint(parseInt(hex, 16)) : NAMED[name.toLowerCase()])
    : v;
const encodeForSetAttribute = (v) => v.replace(/&/g, '&amp;');

async function setIfChanged(el, attr, next) {
  const raw = el.getAttribute(attr);
  if (!raw) return;
  const value = decodeAttr(raw);
  const out = await next(value);
  if (out !== value) el.setAttribute(attr, encodeForSetAttribute(out));
}

class MediaElementHandler {
  constructor(ctx) { this.ctx = ctx; }
  async element(el) {
    for (const a of IMAGE_URL_ATTRS) await setIfChanged(el, a, (v) => toProxy(v, this.ctx, 'image'));
    for (const a of SRCSET_ATTRS) await setIfChanged(el, a, (v) => rewriteSrcset(v, this.ctx));
  }
}

class PosterHandler {
  constructor(ctx) { this.ctx = ctx; }
  async element(el) {
    await setIfChanged(el, 'poster', (v) => toProxy(v, this.ctx, 'image'));
  }
}

class LinkHandler {
  constructor(ctx, ogState) { this.ctx = ctx; this.ogState = ogState; }
  async element(el) {
    const href = el.getAttribute('href');
    if (!href) return;
    const rel = (el.getAttribute('rel') || '').toLowerCase();
    // Remember the canonical for og:url injection (Webflow emits a correct absolute canonical).
    if (rel.includes('canonical')) this.ogState.canonical = href;

    let want = null;
    if (rel.includes('icon')) want = 'icon';
    else if (rel.includes('stylesheet')) want = 'asset';
    else if (rel.includes('preload') || rel.includes('prefetch') || rel.includes('modulepreload')) {
      const as = (el.getAttribute('as') || '').toLowerCase();
      if (as === 'image') {
        want = 'image';
        await setIfChanged(el, 'imagesrcset', (v) => rewriteSrcset(v, this.ctx));
      } else if (as !== 'font') {
        want = 'asset';
      }
    }
    // canonical, alternate, preconnect, dns-prefetch, font preloads: deliberately untouched
    if (want) await setIfChanged(el, 'href', (v) => toProxy(v, this.ctx, want));
  }
}

class ScriptHandler {
  constructor(ctx) { this.ctx = ctx; }
  async element(el) {
    await setIfChanged(el, 'src', (v) => toProxy(v, this.ctx, 'asset'));
  }
}

class MetaHandler {
  constructor(ctx, ogState) { this.ctx = ctx; this.ogState = ogState; }
  async element(el) {
    const key = (el.getAttribute('property') || el.getAttribute('name') || '').toLowerCase();
    // A page that already declares og:url keeps it, and gets no second one.
    if (key === 'og:url') this.ogState.sawOgUrl = true;
    if (!OG_KEYS.includes(key)) return;
    await setIfChanged(el, 'content', (v) => toProxy(v, this.ctx, 'og'));
  }
}

const escapeAttr = (value) =>
  String(value).replace(/&(?!(?:[a-z]+|#\d+|#x[0-9a-f]+);)/gi, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Adds og:url when the page has none. Webflow never emits one, yet it is one of the four basic Open
 * Graph properties: platforms use it to de-duplicate shares of the same page reached via different
 * URLs. Injected at the END of <head> — the only point where we know whether the page declared one.
 * Falls back to the request URL minus query/fragment, so ?utm_source never becomes the identity.
 */
class HeadHandler {
  constructor(ogState, requestUrl) { this.ogState = ogState; this.requestUrl = requestUrl; }
  element(el) {
    el.onEndTag((end) => {
      if (this.ogState.sawOgUrl) return;
      let url = this.ogState.canonical;
      if (!url) {
        try {
          const u = new URL(this.requestUrl);
          u.search = '';
          u.hash = '';
          url = u.toString();
        } catch {
          return;
        }
      }
      end.before(`<meta property="og:url" content="${escapeAttr(url)}"/>`, { html: true });
    });
  }
}

class InlineStyleHandler {
  constructor(ctx) { this.ctx = ctx; }
  async element(el) {
    const raw = el.getAttribute('style');
    if (!raw || !raw.includes('url(')) return;
    await setIfChanged(el, 'style', (v) => rewriteCssUrls(v, this.ctx));
  }
}

// <style> text arrives in chunks that can split mid-URL: buffer to the end of the text node, then
// rewrite once. html:true because the replacement is CSS — entity-escaping would corrupt `.a > .b`.
class StyleBlockHandler {
  constructor(ctx) { this.ctx = ctx; this.buffer = ''; }
  async text(chunk) {
    this.buffer += chunk.text;
    if (!chunk.lastInTextNode) {
      chunk.remove();
      return;
    }
    const css = this.buffer;
    this.buffer = '';
    chunk.replace(css.includes('url(') ? await rewriteCssUrls(css, this.ctx) : css, { html: true });
  }
}

/**
 * ctx: { origin, signer, config, requestUrl, version, browserCacheControl? }
 * `origin` comes from the request — there is no configured domain.
 */
export async function rewriteWebflowHtml(response, ctx) {
  const ogState = { sawOgUrl: false, canonical: null };
  const rewriter = new HTMLRewriter()
    .on('img, source', new MediaElementHandler(ctx))
    .on('video', new PosterHandler(ctx))
    .on('link', new LinkHandler(ctx, ogState))
    .on('script', new ScriptHandler(ctx))
    .on('meta', new MetaHandler(ctx, ogState))
    .on('head', new HeadHandler(ogState, ctx.requestUrl))
    .on('*[style]', new InlineStyleHandler(ctx))
    .on('style', new StyleBlockHandler(ctx));

  const transformed = rewriter.transform(response);
  const headers = new Headers(transformed.headers);
  const link = headers.get('Link');
  if (link) headers.set('Link', await rewriteLinkHeader(link, ctx));
  headers.set('Content-Type', 'text/html; charset=utf-8');
  // The body is no longer Webflow's bytes: Webflow's validators must not let a browser revalidate
  // (304) into keeping a copy whose signed links are dead after a rollback or key change.
  headers.delete('ETag');
  headers.delete('Last-Modified');
  headers.set('Cache-Control', ctx.browserCacheControl || HTML_CACHE_CONTROL);
  // HTML stays out of Workers Cache in 6.0 (the origin fetch keeps its own short edge TTL);
  // Cloudflare strips this header before the browser.
  headers.set('Cloudflare-CDN-Cache-Control', 'no-store');
  headers.set('x-edge-worker', `webflow-o2o/${ctx.version}`);
  return new Response(transformed.body, { status: transformed.status, statusText: transformed.statusText, headers });
}
