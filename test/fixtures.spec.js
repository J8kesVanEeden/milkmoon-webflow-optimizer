/**
 * 6.0 Task 10: the rewriter on REAL Webflow pages from five different sites (refresh with
 * scripts/refresh-fixtures.sh). Served on a made-up host, so nothing about our own site leaks in.
 */
import { describe, it, expect } from 'vitest';
import finsweet from './fixtures/finsweet.html';
import flowbase from './fixtures/flowbase.html';
import flowbaseBlog from './fixtures/flowbase-blog.html';
import milkmoon from './fixtures/milkmoon.html';
import mural from './fixtures/mural.html';
import { makeSigner } from '../src/sign.js';
import { parseSigned } from '../src/urls.js';
import { rewriteWebflowHtml } from '../src/rewrite.js';
import { detectWebflow } from '../src/detect.js';
import { parseConfig } from '../src/config.js';
import { WEBFLOW_ASSET_HOSTS, JQUERY_HOST } from '../src/webflow.js';

const FIXTURES = { finsweet, flowbase, 'flowbase-blog': flowbaseBlog, milkmoon, mural };
const ORIGIN = 'https://www.made-up-install.test';
const { config } = parseConfig({ SIGNING_KEY: 'fixture-key-'.padEnd(40, 'x') });
const signer = await makeSigner(config.SIGNING_KEY);

const WF_HOSTS = [...WEBFLOW_ASSET_HOSTS, JQUERY_HOST];
const isWebflowUrl = (u) => { try { return WF_HOSTS.includes(new URL(u.startsWith('//') ? 'https:' + u : u).hostname); } catch { return false; } };
// Candidate signed URLs run to a quote, whitespace or '<'. An unquoted CSS url(…) leaves a trailing
// ')' (and maybe ';'/'}'), and filenames can contain ')' themselves — so the verifier below retries
// with trailing ')' stripped until the signature checks.
const SIGNED = new RegExp(`${ORIGIN.replace(/[.]/g, '\\.')}(/_(?:wf|img)/[^"'\\s<>]+)`, 'g');
async function verifySigned(p) {
  let cand = p.replace(/&amp;/g, '&').replace(/[;}]+$/, '');
  for (let i = 0; i < 4 && cand; i++) {
    const u = new URL(ORIGIN + cand);
    const back = await parseSigned(u.pathname, u.search, signer);
    if (back) return back;
    if (!/[),]$/.test(cand)) break;
    cand = cand.slice(0, -1);
  }
  return null;
}

async function rewrite(html) {
  const res = await rewriteWebflowHtml(new Response(html, { headers: { 'Content-Type': 'text/html' } }), {
    origin: ORIGIN, signer, config, requestUrl: ORIGIN + '/', version: 'fixture',
  });
  return res.text();
}

// Attribute values in the contexts the rewriter owns, collected with HTMLRewriter itself.
async function collect(html) {
  const out = [];
  const push = (ctx) => (el) => { for (const a of ctx.attrs) { const v = el.getAttribute(a); if (v) out.push({ ctx: ctx.name, attr: a, v, el }); } };
  const meta = [];
  await new HTMLRewriter()
    .on('img, source', { element: push({ name: 'media', attrs: ['src', 'data-src', 'srcset', 'data-srcset'] }) })
    .on('video', { element: push({ name: 'poster', attrs: ['poster'] }) })
    .on('script[src]', { element: push({ name: 'script', attrs: ['src'] }) })
    .on('link[rel]', { element: (el) => out.push({ ctx: 'link', attr: 'href', v: el.getAttribute('href') || '', rel: (el.getAttribute('rel') || '').toLowerCase(), as: (el.getAttribute('as') || '').toLowerCase() }) })
    .on('meta', { element: (el) => meta.push({ key: (el.getAttribute('property') || el.getAttribute('name') || '').toLowerCase(), v: el.getAttribute('content') || '' }) })
    .transform(new Response(html))
    .text();
  return { attrs: out, meta };
}

const urlsIn = (v) => (/srcset/.test(v.attr) ? v.v.split(/,\s+/).map((s) => s.trim().split(/\s+/)[0]) : [v.v.trim()]);
const nonWebflowAbsolute = (html) => (html.match(/https?:\/\/[^"'\s)<>]+/g) || []).filter((u) => !isWebflowUrl(u) && !u.startsWith(ORIGIN)).sort();
const count = (html, tag) => (html.match(new RegExp(`<${tag}\\b`, 'gi')) || []).length;

describe.each(Object.keys(FIXTURES))('real Webflow page: %s', (name) => {
  const input = FIXTURES[name];

  it('is detected as Webflow', async () => {
    const d = await detectWebflow(new Response(input, { headers: { 'Content-Type': 'text/html' } }));
    expect(d.isWebflow).toBe(true);
    expect(await d.response.text()).toBe(input);
  });

  it('every signed URL verifies and maps back to a Webflow URL the page referenced', async () => {
    const out = await rewrite(input);
    const signed = [...out.matchAll(SIGNED)].map((m) => m[1]);
    expect(signed.length).toBeGreaterThan(10);
    for (const p of new Set(signed)) {
      const back = await verifySigned(p);
      expect(back, p).not.toBeNull();
      // The original must appear in the input (as absolute or protocol-relative URL).
      const orig = back.url.href;
      expect(input.includes(orig) || input.includes(orig.replace(/^https:/, '')) || input.includes(orig.replace(/&/g, '&amp;')), orig).toBe(true);
    }
  });

  it('leaves no Webflow image/css/js URL behind in the contexts the rewriter owns', async () => {
    const { attrs, meta } = await collect(await rewrite(input));
    const left = [];
    for (const a of attrs) {
      if (a.ctx === 'link') {
        const handled = a.rel.includes('stylesheet') || a.rel.includes('icon') || (/(pre|module)load|prefetch/.test(a.rel) && a.as !== 'font');
        if (!handled) continue;
      }
      for (const u of urlsIn(a)) {
        if (!isWebflowUrl(u)) continue;
        if (/\.(mp4|webm|mov|json|otf|ttf|woff2?|eot)(\?|$)/i.test(u)) continue; // never proxied / not in these contexts
        if (a.ctx === 'script' && (/\/dist\//.test(u) || /finsweet/.test(u))) continue; // Webflow runtime chunks
        left.push(`${a.ctx}.${a.attr}: ${u}`);
      }
    }
    for (const m of meta) {
      if (['og:image', 'twitter:image'].includes(m.key) && isWebflowUrl(m.v) && !/\.avif$/i.test(m.v)) left.push(`meta ${m.key}: ${m.v}`);
    }
    expect(left).toEqual([]);
  });

  it('changes no URL on any non-Webflow host (analytics, Turnstile, embeds stay direct)', async () => {
    const out = await rewrite(input);
    // Multiset compare: the ONLY non-Webflow URL the rewriter may add is one injected og:url.
    const after = nonWebflowAbsolute(out);
    const injected = out.match(/<meta property="og:url" content="([^"]+)"\/>/);
    if (injected && !/property="og:url"/.test(input)) after.splice(after.indexOf(injected[1]), 1);
    expect(after).toEqual(nonWebflowAbsolute(input));
  });

  it('keeps every tag (nothing dropped or duplicated)', async () => {
    const out = await rewrite(input);
    for (const tag of ['img', 'script', 'link', 'source', 'meta', 'style', 'video', 'div']) {
      const extra = tag === 'meta' && !/property="og:url"/.test(input) ? 1 : 0; // injected og:url
      expect(count(out, tag), tag).toBe(count(input, tag) + extra);
    }
  });
});
