/**
 * HTML rewriting (6.0). Ported from the v5 suite, re-expressed with signed-URL builders. Fixture
 * markup mirrors real Webflow output, including the content-before-property / href-before-rel
 * attribute order that silently killed v4's regex handling of OG images and favicons.
 */
import { describe, it, expect } from 'vitest';
import { makeSigner } from '../src/sign.js';
import { wfPath, imgPath } from '../src/urls.js';
import { rewriteWebflowHtml, rewriteLinkHeader, rewriteSrcset } from '../src/rewrite.js';
import { parseConfig } from '../src/config.js';

const { config } = parseConfig({ SIGNING_KEY: 'k'.repeat(32) });
const signer = await makeSigner(config.SIGNING_KEY);
const S = 'https://www.any-webflow-site.test';
const CDN = 'https://cdn.prod.website-files.com/61819aaca0e7acc94c5a2d47';

const img = async (u) => S + (await imgPath('img', new URL(u), signer));
const og = async (u) => S + (await imgPath('og', new URL(u), signer));
const wf = async (u) => S + (await wfPath(new URL(u), signer));
const ctx = (path = '/', extra = {}) => ({ origin: S, signer, config, requestUrl: S + path, version: '6.0.0-test', ...extra });

const page = (body, headers = {}, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'max-age=1382400', ...headers } });
const run = async (body, c = ctx(), headers, status) => {
  const res = await rewriteWebflowHtml(page(body, headers, status), c);
  return { res, html: await res.text() };
};

const FIXTURE = `<!DOCTYPE html>
<html data-wf-domain="www.any-webflow-site.test" data-wf-site="61819aaca0e7acc94c5a2d47">
<head>
  <meta charset="utf-8"/>
  <title>Fixture</title>
  <meta content="Site" property="og:title"/>
  <meta content="${CDN}/697_og.jpg" property="og:image"/>
  <meta content="${CDN}/697_og.jpg" name="twitter:image"/>
  <link href="${CDN}/css/site.min.css" rel="stylesheet" type="text/css" integrity="sha384-x" crossorigin="anonymous"/>
  <link href="https://cdn.prod.website-files.com" rel="preconnect" crossorigin="anonymous"/>
  <link href="${CDN}/635_Favicon.png" rel="shortcut icon" type="image/x-icon"/>
  <link href="${CDN}/635_Favicon.ico" rel="icon"/>
  <link href="${CDN}/635_Webclip.jpg" rel="apple-touch-icon"/>
  <link href="${CDN}/hero-large.jpg" rel="preload" as="image" imagesrcset="${CDN}/hero-500.jpg 500w, ${CDN}/hero-large.jpg 1024w"/>
  <script src="${CDN}/js/webflow.schunk.abc.js" type="text/javascript"></script>
  <script src="${CDN}/js/dist/chunk-common.js" type="text/javascript"></script>
  <script src="https://cdn.jsdelivr.net/npm/@finsweet/attributes@2/attributes.js" type="module"></script>
  <script src="https://d3e54v103j8qbb.cloudfront.net/js/jquery-3.5.1.min.dc5e7f18c8.js?site=61819aaca0e7acc94c5a2d47" type="text/javascript"></script>
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
  <script src="https://www.googletagmanager.com/gtag/js?id=G-X"></script>
  <style>.hero > .bg { background-image: url("${CDN}/bg.png"); } .plain { color: red; }</style>
</head>
<body>
  <img src="${CDN}/photo.jpg" srcset="${CDN}/photo-500.jpg 500w, ${CDN}/photo.jpg 800w" sizes="100vw" alt=""/>
  <img data-src="${CDN}/lazy.png" data-srcset="${CDN}/lazy-500.png 500w" alt=""/>
  <picture><source srcset="${CDN}/pic.webp" type="image/webp"/><img src="${CDN}/pic.jpg" alt=""/></picture>
  <img src="${CDN}/already-optimal.avif" alt=""/>
  <img src="${CDN}/vector.svg" alt=""/>
  <div style="background-image:url('${CDN}/inline-bg.jpg')"></div>
  <img src="https://example.com/external.jpg" alt="not a Webflow host"/>
  <img src="https://cdn.prod.website-files.com/686294e263eb7e215bd232f7/embedded.jpg" alt="another Webflow site id"/>
  <img src="${S}/local.jpg" alt="own domain"/>
  <img src="/relative.jpg" alt="relative"/>
  <img src="data:image/gif;base64,R0lGOD" alt="data uri"/>
  <video poster="${CDN}/poster.jpg" src="${CDN}/clip.mp4"></video>
</body>
</html>`;

describe('rewriteWebflowHtml', () => {
  it('rewrites every asset context to signed URLs and leaves exclusions alone', async () => {
    const { html } = await run(FIXTURE);

    // images → /_img/img/
    expect(html).toContain(`src="${await img(`${CDN}/photo.jpg`)}"`);
    expect(html).toContain(`srcset="${await img(`${CDN}/photo-500.jpg`)} 500w, ${await img(`${CDN}/photo.jpg`)} 800w"`);
    expect(html).toContain(`data-src="${await img(`${CDN}/lazy.png`)}"`);
    expect(html).toContain(`data-srcset="${await img(`${CDN}/lazy-500.png`)} 500w"`);
    expect(html).toContain(`srcset="${await img(`${CDN}/pic.webp`)}"`);
    expect(html).toContain(`poster="${await img(`${CDN}/poster.jpg`)}"`);
    // passthrough images → /_wf/
    expect(html).toContain(`src="${await wf(`${CDN}/already-optimal.avif`)}"`);
    expect(html).toContain(`src="${await wf(`${CDN}/vector.svg`)}"`);

    // OG / twitter → og preset (content written before property)
    expect(html).toContain(`content="${await og(`${CDN}/697_og.jpg`)}" property="og:image"`);
    expect(html).toContain(`content="${await og(`${CDN}/697_og.jpg`)}" name="twitter:image"`);
    // favicons: raster → image preset, .ico → file proxy
    expect(html).toContain(`href="${await img(`${CDN}/635_Favicon.png`)}" rel="shortcut icon"`);
    expect(html).toContain(`href="${await wf(`${CDN}/635_Favicon.ico`)}" rel="icon"`);
    expect(html).toContain(`href="${await img(`${CDN}/635_Webclip.jpg`)}" rel="apple-touch-icon"`);

    // preload as=image, with imagesrcset
    expect(html).toContain(`href="${await img(`${CDN}/hero-large.jpg`)}" rel="preload" as="image"`);
    expect(html).toContain(`imagesrcset="${await img(`${CDN}/hero-500.jpg`)} 500w, ${await img(`${CDN}/hero-large.jpg`)} 1024w"`);

    // assets → /_wf/
    expect(html).toContain(`href="${await wf(`${CDN}/css/site.min.css`)}" rel="stylesheet"`);
    expect(html).toContain(`src="${await wf(`${CDN}/js/webflow.schunk.abc.js`)}"`);
    expect(html).toContain(`src="${await wf('https://d3e54v103j8qbb.cloudfront.net/js/jquery-3.5.1.min.dc5e7f18c8.js?site=61819aaca0e7acc94c5a2d47')}"`);

    // CSS url() in style blocks and inline styles; selectors not entity-escaped
    expect(html).toContain(`url("${await img(`${CDN}/bg.png`)}")`);
    expect(html).toContain('.hero > .bg');
    expect(html).not.toContain('&gt;');
    expect(html).toContain(`url('${await img(`${CDN}/inline-bg.jpg`)}')`);

    // 6.0 deliberate change: another Webflow site id the page itself references IS rewritten —
    // only this page's HTML can produce the signature, so it cannot become a relay.
    expect(html).toContain(`src="${await img('https://cdn.prod.website-files.com/686294e263eb7e215bd232f7/embedded.jpg')}"`);

    // untouched
    expect(html).toContain(`src="${CDN}/js/dist/chunk-common.js"`);
    expect(html).toContain('src="https://cdn.jsdelivr.net/npm/@finsweet/attributes@2/attributes.js"');
    expect(html).toContain('src="https://challenges.cloudflare.com/turnstile/v0/api.js"');
    expect(html).toContain('src="https://www.googletagmanager.com/gtag/js?id=G-X"');
    expect(html).toContain('src="https://example.com/external.jpg"');
    expect(html).toContain(`src="${S}/local.jpg"`);
    expect(html).toContain('src="/relative.jpg"');
    expect(html).toContain('src="data:image/gif;base64,R0lGOD"');
    expect(html).toContain(`src="${CDN}/clip.mp4"`); // video never proxied
    expect(html).toContain('href="https://cdn.prod.website-files.com" rel="preconnect"');

    // no raw CDN image/css URL left in a rewritable attribute
    expect(html).not.toMatch(/(?:src|href|content|poster)="https:\/\/cdn\.prod\.website-files\.com\/[0-9a-f]{24}\/[^"]*\.(?:jpg|jpeg|png|webp|gif|css|avif|svg)"/);
  });

  it('uses the request host, not a configured domain', async () => {
    const other = 'https://apex-only.example';
    const { html } = await run(`<html><body><img src="${CDN}/a.jpg"></body></html>`, ctx('/', { origin: other, requestUrl: other + '/' }));
    expect(html).toContain(`src="${other}${await imgPath('img', new URL(`${CDN}/a.jpg`), signer)}"`);
  });

  it('rewrites CSS url() with parentheses in the filename (quoted and unquoted)', async () => {
    const a = `${CDN}/card%20(1).png`, b = `${CDN}/Dots%20(2).jpg`, c = `${CDN}/x%20(3).webp`;
    const { html } = await run(`<html><head><style>.a{background:url(${a}) no-repeat}.b{background-image:url("${b}")}</style></head>` +
      `<body><div style="background-image:url('${c}')"></div></body></html>`);
    expect(html).toContain(`url(${await img(a)}) no-repeat`);
    expect(html).toContain(`url("${await img(b)}")`);
    expect(html).toContain(`url('${await img(c)}')`);
  });

  it('proxies a site whose NAME contains "finsweet" (only Finsweet script files stay direct)', async () => {
    const css = `${CDN}/css/finsweet-demo.webflow.shared.25c99204e.min.css`;
    const fsJs = `${CDN}/js/finsweet-attributes-cmsload.js`;
    const { html } = await run(`<html><head><link href="${css}" rel="stylesheet"/><script src="${fsJs}"></script></head><body></body></html>`);
    expect(html).toContain(`href="${await wf(css)}"`);
    expect(html).toContain(`src="${fsJs}"`);
  });

  // HTMLRewriter getAttribute() returns attribute text still entity-encoded, and setAttribute()
  // escapes " but not & (probed 2026-09-29). URLs must be decoded before signing, re-encoded after.
  it('decodes &amp; in a Webflow URL before signing, and writes it back encoded', async () => {
    const real = `${CDN}/x.jpg?a=1&b=2`;
    const { html } = await run(`<html><body><img src="${CDN}/x.jpg?a=1&amp;b=2"></body></html>`);
    const signed = await img(real);
    expect(html).toContain(`src="${signed.replace(/&/g, '&amp;')}"`);
  });

  it('rewrites CSS url(&quot;…&quot;) in style attributes (Webflow CMS background images)', async () => {
    const u = `${CDN}/cms-bg.jpg`;
    const { html } = await run(`<html><body><div style="background-image:url(&quot;${u}&quot;)"></div></body></html>`);
    expect(html).toContain(`style="background-image:url(&quot;${await img(u)}&quot;)"`);
  });

  it('leaves an unchanged attribute with entities byte-identical', async () => {
    const src = 'https://example.com/a.jpg?x=1&amp;y=2';
    const { html } = await run(`<html><body><img src="${src}"></body></html>`);
    expect(html).toContain(`src="${src}"`);
  });

  it('rewrites protocol-relative Webflow URLs', async () => {
    const { html } = await run(`<html><body><img src="//cdn.prod.website-files.com/61819aaca0e7acc94c5a2d47/p.jpg"></body></html>`);
    expect(html).toContain(`src="${await img(`${CDN}/p.jpg`)}"`);
  });

  it('keeps literal %xx filenames byte-exact inside the signed URL', async () => {
    const stitch = 'https://cdn.prod.website-files.com/63565c108c96757108b92506/6a5a454b_Project%2520-%2520Stitch.png';
    const { html } = await run(`<html><body><img src="${stitch}" alt=""></body></html>`);
    expect(html).toContain(`src="${await img(stitch)}"`);
    expect(html).toContain('/6a5a454b_Project%2520-%2520Stitch.png"');
  });

  it('leaves AVIF OG images on Webflow (transformer cannot read AVIF; scrapers dislike it)', async () => {
    const avif = `${CDN}/64aeaf92_OG.avif`;
    const { html } = await run(`<html><head><meta content="${avif}" property="og:image"/></head><body></body></html>`);
    expect(html).toContain(`content="${avif}" property="og:image"`);
  });

  it('leaves font preloads alone in HTML (CSS loads fonts from their original URL)', async () => {
    const font = `${CDN}/fonts/Inter.woff2`;
    const { html } = await run(`<html><head><link href="${font}" rel="preload" as="font" type="font/woff2" crossorigin="anonymous"/></head><body></body></html>`);
    expect(html).toContain(`href="${font}" rel="preload" as="font"`);
  });

  it('sets HTML caching + identity headers and keeps HTML out of Workers Cache', async () => {
    const { res } = await run('<html><head><title>x</title></head><body>hi</body></html>');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
    expect(res.headers.get('Cloudflare-CDN-Cache-Control')).toBe('no-store');
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('x-edge-worker')).toBe('webflow-o2o/6.0.0-test');
    expect(res.headers.get('X-MMS-Worker')).toBeNull();
  });

  it('drops the origin ETag/Last-Modified (a 304 must never keep stale signed links alive)', async () => {
    const { res } = await run('<html><body></body></html>', ctx(), { ETag: '"abc"', 'Last-Modified': 'Tue, 29 Sep 2026 10:00:00 GMT' });
    expect(res.headers.get('ETag')).toBeNull();
    expect(res.headers.get('Last-Modified')).toBeNull();
  });

  it('uses the given browser cache control (no-store for error pages) and keeps the status', async () => {
    const { res, html } = await run(`<html><body><img src="${CDN}/x.jpg"></body></html>`, ctx('/missing', { browserCacheControl: 'no-store' }), {}, 404);
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(html).toContain(await img(`${CDN}/x.jpg`));
  });
});

describe('og:url injection', () => {
  const withHead = (head) => `<!DOCTYPE html><html data-wf-site="61819aaca0e7acc94c5a2d47"><head>${head}</head><body></body></html>`;

  it('injects og:url from the canonical when the page has none (exactly one)', async () => {
    const { html } = await run(withHead(`<link href="${S}/about" rel="canonical"/>`), ctx('/about'));
    expect(html).toContain(`<meta property="og:url" content="${S}/about"/>`);
    expect(html.match(/property="og:url"/g)).toHaveLength(1);
  });

  it('does NOT inject when the page already declares og:url', async () => {
    const { html } = await run(withHead(`<link href="${S}/x" rel="canonical"/><meta content="${S}/hand-written" property="og:url"/>`), ctx('/x'));
    expect(html.match(/property="og:url"/g)).toHaveLength(1);
    expect(html).toContain(`${S}/hand-written`);
  });

  it('falls back to the request URL without query or fragment', async () => {
    const { html } = await run(withHead('<title>x</title>'), ctx('/campaign?utm_source=newsletter'));
    expect(html).toContain(`<meta property="og:url" content="${S}/campaign"/>`);
    expect(html).not.toContain('utm_source');
  });

  it('escapes the injected value', async () => {
    const { html } = await run(withHead(`<link href="${S}/a&quot;b" rel="canonical"/>`), ctx('/a'));
    expect(html).toContain(`<meta property="og:url" content="${S}/a&quot;b"/>`);
  });
});

describe('rewriteSrcset', () => {
  const u = (n) => `${CDN}/${n}`;

  it('returns the value byte-identical when nothing is a Webflow URL', async () => {
    for (const v of ['/a.jpg 1x,/b.jpg 2x', '  /a.jpg   1x ,  /b.jpg 2x  ', 'https://example.com/a,b.jpg 1x']) {
      expect(await rewriteSrcset(v, ctx())).toBe(v);
    }
  });

  it('handles commas inside Webflow filenames', async () => {
    const v = `${u('a,b.jpg')} 500w, ${u('c.jpg')} 800w`;
    expect(await rewriteSrcset(v, ctx())).toBe(`${await img(u('a,b.jpg'))} 500w, ${await img(u('c.jpg'))} 800w`);
  });

  it('handles no-space separators and bare URLs', async () => {
    expect(await rewriteSrcset(`${u('a.jpg')} 1x,${u('b.jpg')} 2x`, ctx())).toBe(`${await img(u('a.jpg'))} 1x, ${await img(u('b.jpg'))} 2x`);
    expect(await rewriteSrcset(u('a.jpg'), ctx())).toBe(await img(u('a.jpg')));
  });

  it('keeps mixed entries (Webflow + other) in order', async () => {
    const v = `/local.jpg 1x, ${u('b.jpg')} 2x`;
    expect(await rewriteSrcset(v, ctx())).toBe(`/local.jpg 1x, ${await img(u('b.jpg'))} 2x`);
  });
});

describe('rewriteLinkHeader (Early Hints)', () => {
  const css = `${CDN}/css/site.shared.aa7d1f6c7.min.css`;

  it('points preload targets at the signed URLs and keeps every other entry', async () => {
    const value =
      `<https://cdn.prod.website-files.com>; rel=preconnect; crossorigin, ` +
      `<${css}>; rel=preload; as=style; crossorigin; integrity="sha384-qn0f+x/y=", ` +
      `<https://cdn.example-fonts.test>; rel=preconnect; crossorigin, ` +
      `</llms.txt>; rel="describedby"`;
    const out = await rewriteLinkHeader(value, ctx());
    expect(out).toContain(`<${await wf(css)}>; rel=preload; as=style; crossorigin; integrity="sha384-qn0f+x/y="`);
    expect(out).not.toContain(`<${css}>`);
    expect(out).toContain('<https://cdn.prod.website-files.com>; rel=preconnect; crossorigin');
    expect(out).toContain('<https://cdn.example-fonts.test>; rel=preconnect; crossorigin');
    expect(out).toContain('</llms.txt>; rel="describedby"');
  });

  it('rewrites image preloads incl. imagesrcset, and modulepreload', async () => {
    const mod = `${CDN}/js/webflow.mod.abc.js`;
    const a = `${CDN}/hero-500.jpg`, b = `${CDN}/hero-1080.jpg`;
    const out = await rewriteLinkHeader(`<${mod}>; rel=modulepreload, <${b}>; rel=preload; as=image; imagesrcset="${a} 500w, ${b} 1080w"; imagesizes="100vw"`, ctx());
    expect(out).toContain(`<${await wf(mod)}>; rel=modulepreload`);
    expect(out).toContain(`<${await img(b)}>; rel=preload; as=image; imagesrcset="${await img(a)} 500w, ${await img(b)} 1080w"; imagesizes="100vw"`);
  });

  it('leaves font and third-party preloads alone', async () => {
    const f = `<${CDN}/fonts/x.woff2>; rel=preload; as=font; crossorigin`;
    expect(await rewriteLinkHeader(f, ctx())).toBe(f);
    const g = '<https://fonts.gstatic.com/s/x.woff2>; rel=preload; as=font; crossorigin';
    expect(await rewriteLinkHeader(g, ctx())).toBe(g);
  });

  it('is applied to the response Link header', async () => {
    const { res } = await run('<html><head></head><body></body></html>', ctx(), { Link: `<${css}>; rel=preload; as=style` });
    expect(res.headers.get('Link')).toBe(`<${await wf(css)}>; rel=preload; as=style`);
  });
});
