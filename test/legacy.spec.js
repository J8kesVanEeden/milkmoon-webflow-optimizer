/**
 * Legacy (v4.4–v5.x) proxy URL shapes, served only when LEGACY_ROUTES is on. Ported from the v5
 * suite: these URLs are still in Google Images, old edge-cached HTML and social previews.
 */
import { fetchMock, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, afterEach, describe, it, expect } from 'vitest';
import { handleLegacy, proxyCacheTtlByStatus } from '../src/legacy.js';
import { parseConfig } from '../src/config.js';

const SITE = 'https://www.milkmoonstudio.com';
const CDN = 'https://cdn.prod.website-files.com/63565c108c96756a59b92502';
const CMS = 'https://cdn.prod.website-files.com/63565c108c96757108b92506';
const enc = encodeURIComponent;

const { config } = parseConfig({
  SIGNING_KEY: 'k'.repeat(32),
  LEGACY_ROUTES: 'true',
  WEBFLOW_SITE_IDS: '63565c108c96756a59b92502,63565c108c96757108b92506',
  LEGACY_DOMAIN: 'www.milkmoonstudio.com',
});

beforeAll(() => { fetchMock.activate(); fetchMock.disableNetConnect(); });
afterEach(() => fetchMock.assertNoPendingInterceptors());

async function call(href, init, cfg = config) {
  const ctx = createExecutionContext();
  const url = new URL(href);
  const res = await handleLegacy(new Request(url, init), url, cfg, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const cdnMock = (path, body, type, status = 200) =>
  fetchMock.get('https://cdn.prod.website-files.com').intercept({ path }).reply(status, body, type ? { headers: { 'Content-Type': type } } : {});

describe('legacy gating', () => {
  it('is off unless LEGACY_ROUTES is on', async () => {
    const off = parseConfig({ SIGNING_KEY: 'k'.repeat(32) }).config;
    expect(await call(`${SITE}/img-original/${enc(`${CDN}/a.png`)}`, undefined, off)).toBeNull();
  });
  it('only answers on LEGACY_DOMAIN', async () => {
    expect(await call(`https://other.example/asset-cache/${enc(`${CDN}/a.css`)}`)).toBeNull();
  });
  it('returns null for non-legacy paths', async () => {
    expect(await call(`${SITE}/about`)).toBeNull();
    expect(await call(`${SITE}/_wf/x`)).toBeNull();
  });
});

describe('legacy proxy routes', () => {
  it('proxies an allowlisted asset with long immutable caching + CORS (v5 headers)', async () => {
    cdnMock('/63565c108c96756a59b92502/css/legacy-one.css', 'body{}', 'text/css');
    const res = await call(`${SITE}/asset-cache/${enc(`${CDN}/css/legacy-one.css`)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/css');
    expect(res.headers.get('Cache-Control')).toBe('public, s-maxage=31536000, max-age=31536000, immutable');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await res.text()).toBe('body{}');
  });

  it('403s non-Webflow origins and excluded domains without fetching', async () => {
    for (const t of [
      'https://evil.example.com/x.js',
      'https://public.codepenassets.com/embed/ei.js',
      'https://challenges.cloudflare.com/turnstile/v0/api.js',
      'https://cdn.intellimize.co/snippet/117571950.js',
      'https://marketo.use1-marketplace-1p-apps-prod-red.if.webflow.services/app.js',
    ]) {
      expect((await call(`${SITE}/asset-cache/${enc(t)}`)).status, t).toBe(403);
    }
  });

  it('403s another Webflow tenant on every route, and paths with no site id', async () => {
    const foreign = 'https://cdn.prod.website-files.com/686294e263eb7e215bd232f7/6a04_webflow-og.jpg';
    for (const route of ['img-original', 'img-cache', 'asset-cache']) {
      expect((await call(`${SITE}/${route}/${enc(foreign)}`)).status, route).toBe(403);
    }
    for (const u of [
      'https://assets.website-files.com/5f0000000000000000000000/x.css',
      'https://uploads-ssl.webflow.com/5f0000000000000000000000/x.png',
      'https://cdn.prod.website-files.com/x.css',
      'https://global-uploads.webflow.com/6090e50d603a110a1103c621/b.png',
    ]) {
      expect((await call(`${SITE}/asset-cache/${enc(u)}`)).status, u).toBe(403);
    }
  });

  it('serves CMS images (second site id) and global-uploads for our ids', async () => {
    cdnMock('/63565c108c96757108b92506/6358_Project.jpg', 'JPEGBYTES', 'image/jpeg');
    const res = await call(`${SITE}/img-original/${enc(`${CMS}/6358_Project.jpg`)}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('JPEGBYTES');
    fetchMock.get('https://global-uploads.webflow.com').intercept({ path: '/63565c108c96756a59b92502/a.png' }).reply(200, 'PNG', { headers: { 'Content-Type': 'image/png' } });
    expect((await call(`${SITE}/img-original/${enc('https://global-uploads.webflow.com/63565c108c96756a59b92502/a.png')}`)).status).toBe(200);
  });

  it('only relays jQuery from Webflow’s CloudFront host', async () => {
    const jq = 'https://d3e54v103j8qbb.cloudfront.net/js/jquery-3.5.1.min.dc5e7f18c8.js?site=63565c108c96756a59b92502';
    fetchMock.get('https://d3e54v103j8qbb.cloudfront.net').intercept({ path: '/js/jquery-3.5.1.min.dc5e7f18c8.js?site=63565c108c96756a59b92502' }).reply(200, '//jq', { headers: { 'Content-Type': 'application/javascript' } });
    const ok = await call(`${SITE}/asset-cache/${enc(jq)}`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('//jq');
    expect((await call(`${SITE}/asset-cache/${enc('https://d3e54v103j8qbb.cloudfront.net/other/thing.js')}`)).status).toBe(403);
  });

  it('rejects non-image content on image routes and HTML where a font was expected', async () => {
    cdnMock('/63565c108c96756a59b92502/notimage.png', '<html>err</html>', 'text/html');
    expect((await call(`${SITE}/img-original/${enc(`${CDN}/notimage.png`)}`)).status).toBe(400);
    cdnMock('/63565c108c96756a59b92502/font.woff2', '<html>x</html>', 'text/html');
    expect((await call(`${SITE}/asset-cache/${enc(`${CDN}/font.woff2`)}`)).status).toBe(502);
  });

  it('answers CORS preflight without touching the origin', async () => {
    const res = await call(`${SITE}/asset-cache/x`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('400s malformed proxy requests', async () => {
    expect((await call(`${SITE}/asset-cache/`)).status).toBe(400);
    expect((await call(`${SITE}/asset-cache/${enc('ftp://x/y.css')}`)).status).toBe(400);
    expect((await call(`${SITE}/img-cache/%E0%A4%A`)).status).toBe(400);
    expect((await call(`${SITE}/img-original/ftp:/cdn.prod.website-files.com/63565c108c96757108b92506/a.png`)).status).toBe(400);
  });
});

describe('legacy URL tolerance (5.3 / 5.3.1)', () => {
  it('fetches the exact Webflow path for a %25-encoded proxy URL', async () => {
    cdnMock('/63565c108c96757108b92506/6a5a454b_Project%2520-%2520Stitch.png', 'PNG', 'image/png');
    const res = await call(`${SITE}/img-original/${enc(`${CMS}/6a5a454b_Project%2520-%2520Stitch.png`)}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('PNG');
  });

  it('keeps pre-5.3 proxy URLs for spaced filenames working', async () => {
    cdnMock('/63565c108c96756a59b92502/635d_Hands%202.svg', '<svg/>', 'image/svg+xml');
    const res = await call(`${SITE}/img-original/https%3A%2F%2Fcdn.prod.website-files.com%2F63565c108c96756a59b92502%2F635d_Hands%202.svg`);
    expect(res.status).toBe(200);
  });

  it('accepts crawler-decoded, single-slash and half-decoded inner URLs', async () => {
    for (const inner of [
      `${CMS}/646cb618_reasons.webp`,
      'https:/cdn.prod.website-files.com/63565c108c96757108b92506/646cb618_reasons.webp',
      'https:%2F%2Fcdn.prod.website-files.com%2F63565c108c96757108b92506%2F646cb618_reasons.webp',
    ]) {
      cdnMock('/63565c108c96757108b92506/646cb618_reasons.webp', 'WEBP', 'image/webp');
      const res = await call(`${SITE}/img-original/${inner}`);
      expect(res.status, inner).toBe(200);
      expect(await res.text()).toBe('WEBP');
    }
  });

  it('does not double-decode a crawler-decoded URL for a literal-% filename', async () => {
    cdnMock('/63565c108c96757108b92506/6a5a_Project%2520-%2520S.jpeg', 'JPG', 'image/jpeg');
    const res = await call(`${SITE}/img-original/${CMS}/6a5a_Project%2520-%2520S.jpeg`);
    expect(res.status).toBe(200);
  });

  it('still rejects foreign tenants in decoded form', async () => {
    expect((await call(`${SITE}/img-original/https://cdn.prod.website-files.com/686294e263eb7e215bd232f7/a.png`)).status).toBe(403);
  });

  it('caches proxied Webflow responses by status: 2xx long, 404/410 briefly, 5xx never', () => {
    const t = proxyCacheTtlByStatus(31536000);
    expect(t).toEqual({ '200-299': 31536000, '404': 60, '410': 60, '500-599': -1 });
  });
});
