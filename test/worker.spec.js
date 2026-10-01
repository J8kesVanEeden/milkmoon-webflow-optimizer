/**
 * End-to-end (6.0): the whole Worker via SELF, with the test settings in vitest.config.js (which
 * override wrangler.jsonc, so this suite runs the same in the public template). Unit behaviour lives in the per-module specs.
 */
import { SELF, fetchMock, env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index.js';
import { VERSION } from '../src/version.js';
import { makeSigner } from '../src/sign.js';
import { wfPath, imgPath } from '../src/urls.js';
import { beforeAll, afterEach, describe, it, expect } from 'vitest';

const ANY = 'https://www.any-webflow-site.test';
const LEGACY = 'https://www.legacy-site.test'; // LEGACY_DOMAIN in vitest.config.js
const CDN = 'https://cdn.prod.website-files.com/61819aaca0e7acc94c5a2d47';
const signer = await makeSigner(env.SIGNING_KEY);

const WEBFLOW_PAGE = `<!DOCTYPE html><html data-wf-domain="x.webflow.io" data-wf-site="61819aaca0e7acc94c5a2d47"><head>
<link href="${CDN}/css/site.min.css" rel="stylesheet" type="text/css"/></head>
<body><img src="${CDN}/photo.jpg" alt=""/></body></html>`;
const OTHER_PAGE = `<!DOCTYPE html><html lang="en"><head><link href="${CDN}/css/site.min.css" rel="stylesheet"/></head><body><img src="${CDN}/photo.jpg"></body></html>`;

function mock(origin, path, body, { type = 'text/html; charset=utf-8', headers = {}, status = 200, method = 'GET' } = {}) {
  fetchMock.get(origin).intercept({ path, method }).reply(status, body, { headers: { 'Content-Type': type, 'Cache-Control': 'max-age=1382400', ...headers } });
}

beforeAll(() => { fetchMock.activate(); fetchMock.disableNetConnect(); });
afterEach(() => fetchMock.assertNoPendingInterceptors());

describe('Webflow pages on any host', () => {
  it('rewrites to signed URLs on the request host', async () => {
    mock(ANY, '/', WEBFLOW_PAGE);
    const res = await SELF.fetch(`${ANY}/`);
    const html = await res.text();
    expect(html).toContain(`src="${ANY}${await imgPath('img', new URL(`${CDN}/photo.jpg`), signer)}"`);
    expect(html).toContain(`href="${ANY}${await wfPath(new URL(`${CDN}/css/site.min.css`), signer)}"`);
    expect(res.headers.get('x-edge-worker')).toBe(`webflow-o2o/${VERSION}`);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
    expect(res.headers.get('Cloudflare-CDN-Cache-Control')).toBe('no-store');
  });

  it('rewrites a Webflow 404 page and stops browsers caching it', async () => {
    mock(ANY, '/missing', WEBFLOW_PAGE, { status: 404 });
    const res = await SELF.fetch(`${ANY}/missing`);
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.text()).toContain('/_img/img/');
  });
});

describe('everything else passes through untouched and is never pinned in Workers Cache', () => {
  it('non-Webflow HTML: byte-identical, origin headers kept', async () => {
    mock('https://scan.example-app.test', '/app', OTHER_PAGE);
    const res = await SELF.fetch('https://scan.example-app.test/app');
    expect(await res.text()).toBe(OTHER_PAGE);
    expect(res.headers.get('Cache-Control')).toBe('max-age=1382400');
    expect(res.headers.get('x-edge-worker')).toBeNull();
    expect(res.headers.get('Cloudflare-CDN-Cache-Control')).toBe('no-store');
  });

  it('non-HTML responses', async () => {
    mock(ANY, '/sitemap.xml', '<urlset/>', { type: 'application/xml' });
    const res = await SELF.fetch(`${ANY}/sitemap.xml`);
    expect(await res.text()).toBe('<urlset/>');
    expect(res.headers.get('x-edge-worker')).toBeNull();
    expect(res.headers.get('Cloudflare-CDN-Cache-Control')).toBe('no-store');
  });

  it('non-HTML 404s, redirects and 5xx', async () => {
    mock(ANY, '/nope.png', 'nope', { type: 'image/png', status: 404 });
    const a = await SELF.fetch(`${ANY}/nope.png`);
    expect(a.status).toBe(404);
    expect(await a.text()).toBe('nope');

    mock(ANY, '/old', '', { headers: { Location: `${ANY}/new` }, status: 301 });
    const b = await SELF.fetch(`${ANY}/old`, { redirect: 'manual' });
    expect(b.status).toBe(301);
    expect(b.headers.get('Location')).toBe(`${ANY}/new`);
    expect(b.headers.get('x-edge-worker')).toBeNull();

    mock(ANY, '/boom', WEBFLOW_PAGE, { status: 503 });
    const c = await SELF.fetch(`${ANY}/boom`);
    expect(c.status).toBe(503);
    expect(await c.text()).toBe(WEBFLOW_PAGE);
    expect(c.headers.get('Cloudflare-CDN-Cache-Control')).toBe('no-store');
  });

  it('POST passes through untouched', async () => {
    mock(ANY, '/form', WEBFLOW_PAGE, { method: 'POST' });
    const res = await SELF.fetch(`${ANY}/form`, { method: 'POST', body: 'a=1' });
    expect(await res.text()).toBe(WEBFLOW_PAGE);
    expect(res.headers.get('x-edge-worker')).toBeNull();
  });

  it('a missing SIGNING_KEY leaves the site working and untouched', async () => {
    mock(ANY, '/', WEBFLOW_PAGE);
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`${ANY}/`), { ...env, SIGNING_KEY: undefined }, ctx);
    await waitOnExecutionContext(ctx);
    expect(await res.text()).toBe(WEBFLOW_PAGE);
    expect(res.headers.get('x-edge-worker')).toBeNull();
    expect(res.headers.get('Cloudflare-CDN-Cache-Control')).toBe('no-store');
  });

  it('an error during handling serves the untouched origin response (GET retried once)', async () => {
    fetchMock.get(ANY).intercept({ path: '/flaky' }).replyWithError(new Error('boom'));
    mock(ANY, '/flaky', WEBFLOW_PAGE);
    const res = await SELF.fetch(`${ANY}/flaky`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(WEBFLOW_PAGE);
    expect(res.headers.get('x-edge-worker')).toBeNull();
    expect(res.headers.get('Cloudflare-CDN-Cache-Control')).toBe('no-store');
  });

  it('a failed POST is never re-sent (its body is used up): plain 502, not an error page', async () => {
    fetchMock.get(ANY).intercept({ path: '/form-fail', method: 'POST' }).replyWithError(new Error('boom'));
    const res = await SELF.fetch(`${ANY}/form-fail`, { method: 'POST', body: 'a=1' });
    expect(res.status).toBe(502);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('a short SIGNING_KEY is treated as missing', async () => {
    mock(ANY, '/', WEBFLOW_PAGE);
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`${ANY}/`), { ...env, SIGNING_KEY: 'short' }, ctx);
    await waitOnExecutionContext(ctx);
    expect(await res.text()).toBe(WEBFLOW_PAGE);
  });
});

describe('signed routes', () => {
  it('are served before any page handling', async () => {
    fetchMock.get('https://cdn.prod.website-files.com').intercept({ path: '/61819aaca0e7acc94c5a2d47/css/site.min.css' }).reply(200, 'body{}', { headers: { 'Content-Type': 'text/css' } });
    const res = await SELF.fetch(ANY + (await wfPath(new URL(`${CDN}/css/site.min.css`), signer)));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(await res.text()).toBe('body{}');
  });

  it('403 on a bad signature, never reaching the origin', async () => {
    const res = await SELF.fetch(`${ANY}/_wf/AAAAAAAAAAAAAAAA/cdn.prod.website-files.com/61819aaca0e7acc94c5a2d47/x.css`);
    expect(res.status).toBe(403);
  });
});

describe('legacy mode (LEGACY_ROUTES on, LEGACY_DOMAIN only)', () => {
  it('still serves the v5 asset proxy on LEGACY_DOMAIN', async () => {
    const t = 'https://cdn.prod.website-files.com/aaaaaaaaaaaaaaaaaaaaaaaa/css/e2e-legacy.css';
    fetchMock.get('https://cdn.prod.website-files.com').intercept({ path: '/aaaaaaaaaaaaaaaaaaaaaaaa/css/e2e-legacy.css' }).reply(200, 'body{}', { headers: { 'Content-Type': 'text/css' } });
    const res = await SELF.fetch(`${LEGACY}/asset-cache/${encodeURIComponent(t)}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('body{}');
  });

  it('does not serve legacy URLs on any other host', async () => {
    const t = 'https://cdn.prod.website-files.com/aaaaaaaaaaaaaaaaaaaaaaaa/css/x.css';
    mock(ANY, `/asset-cache/${encodeURIComponent(t)}`, 'not found', { type: 'text/plain', status: 404 });
    const res = await SELF.fetch(`${ANY}/asset-cache/${encodeURIComponent(t)}`);
    expect(res.status).toBe(404);
  });
});
