import { fetchMock } from 'cloudflare:test';
import { beforeAll, afterEach, describe, it, expect } from 'vitest';
import { makeSigner } from '../src/sign.js';
import { wfPath, imgPath } from '../src/urls.js';
import { handleSigned, imageOptions } from '../src/routes.js';
import { parseConfig } from '../src/config.js';

const { config } = parseConfig({ SIGNING_KEY: 'k'.repeat(32) });
const signer = await makeSigner(config.SIGNING_KEY);
const SITE = 'https://any-webflow-site.example';
const CDN = 'https://cdn.prod.website-files.com';

beforeAll(() => { fetchMock.activate(); fetchMock.disableNetConnect(); });
afterEach(() => fetchMock.assertNoPendingInterceptors());

const call = (path, init) => {
  const url = new URL(SITE + path);
  return handleSigned(new Request(url, init), url, config, signer);
};
const cdn = (path) => new URL(CDN + path);

describe('/_wf', () => {
  it('serves a signed Webflow file with 1-year immutable caching and CORS', async () => {
    fetchMock.get(CDN).intercept({ path: '/abc/css/x.css' }).reply(200, 'body{}', { headers: { 'Content-Type': 'text/css' } });
    const res = await call(await wfPath(cdn('/abc/css/x.css'), signer));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Type')).toBe('text/css');
    expect(await res.text()).toBe('body{}');
  });

  it('forwards the signed query string to the origin', async () => {
    fetchMock.get('https://d3e54v103j8qbb.cloudfront.net')
      .intercept({ path: '/js/jquery-3.5.1.min.dc5e7f18c8.js?site=63565c108c96756a59b92502' })
      .reply(200, 'jq', { headers: { 'Content-Type': 'application/javascript' } });
    const p = await wfPath(new URL('https://d3e54v103j8qbb.cloudfront.net/js/jquery-3.5.1.min.dc5e7f18c8.js?site=63565c108c96756a59b92502'), signer);
    const res = await call(p);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('jq');
  });

  it('fills a missing Content-Type from the extension', async () => {
    fetchMock.get(CDN).intercept({ path: '/abc/f.woff2' }).reply(200, 'FONT');
    const res = await call(await wfPath(cdn('/abc/f.woff2'), signer));
    expect(res.headers.get('Content-Type')).toBe('font/woff2');
  });

  it('replaces a generic octet-stream type with the real one (nosniff would block it)', async () => {
    fetchMock.get(CDN).intercept({ path: '/abc/app.js' }).reply(200, 'x', { headers: { 'Content-Type': 'application/octet-stream' } });
    const res = await call(await wfPath(cdn('/abc/app.js'), signer));
    expect(res.headers.get('Content-Type')).toBe('application/javascript; charset=utf-8');
  });

  it('403s a bad signature without fetching', async () => {
    const res = await call('/_wf/AAAAAAAAAAAAAAAA/cdn.prod.website-files.com/abc/x.css');
    expect(res.status).toBe(403);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('405s anything but GET and HEAD', async () => {
    const res = await call(await wfPath(cdn('/abc/x.css'), signer), { method: 'POST' });
    expect(res.status).toBe(405);
  });

  it('answers HEAD without a body', async () => {
    fetchMock.get(CDN).intercept({ path: '/abc/h.css', method: 'HEAD' }).reply(200, '', { headers: { 'Content-Type': 'text/css' } });
    const res = await call(await wfPath(cdn('/abc/h.css'), signer), { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('caches origin 404s for 60s only', async () => {
    fetchMock.get(CDN).intercept({ path: '/abc/gone.css' }).reply(404, 'nope');
    const res = await call(await wfPath(cdn('/abc/gone.css'), signer));
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
  });

  it('never caches origin 5xx', async () => {
    fetchMock.get(CDN).intercept({ path: '/abc/err.css' }).reply(503, 'down');
    const res = await call(await wfPath(cdn('/abc/err.css'), signer));
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('refuses HTML where a font was expected (502, not cached)', async () => {
    fetchMock.get(CDN).intercept({ path: '/abc/f.woff2' }).reply(200, '<html>', { headers: { 'Content-Type': 'text/html' } });
    const res = await call(await wfPath(cdn('/abc/f.woff2'), signer));
    expect(res.status).toBe(502);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('sandboxes SVG served from the site origin', async () => {
    fetchMock.get(CDN).intercept({ path: '/abc/logo.svg' }).reply(200, '<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } });
    const res = await call(await wfPath(cdn('/abc/logo.svg'), signer));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Security-Policy')).toMatch(/sandbox/);
  });

  it('returns null for paths that are not signed routes', async () => {
    expect(await call('/about')).toBeNull();
    expect(await call('/_wfx/a')).toBeNull();
  });
});

describe('imageOptions', () => {
  it('negotiates format from Accept and uses preset quality only', () => {
    expect(imageOptions('img', 'jpg', 'image/avif,image/webp,*/*', config)).toEqual({ format: 'avif', quality: 85 });
    expect(imageOptions('img', 'jpg', 'image/webp,*/*', config)).toEqual({ format: 'webp', quality: 85 });
    expect(imageOptions('img', 'jpg', 'image/jpeg', config)).toEqual({ quality: 85 });
    expect(imageOptions('img', 'jpg', null, config)).toEqual({ quality: 85 });
    expect(imageOptions('og', 'jpg', 'image/avif', config)).toEqual({ format: 'jpeg', quality: 80 });
  });

  it('never asks AVIF for a GIF (keeps animation): WebP or untouched format', () => {
    expect(imageOptions('img', 'gif', 'image/avif,image/webp,*/*', config)).toEqual({ format: 'webp', quality: 85 });
    expect(imageOptions('img', 'gif', 'image/avif,*/*', config)).toEqual({ quality: 85 });
  });
});

describe('/_img', () => {
  it('serves a signed image with Vary: Accept and immutable caching', async () => {
    fetchMock.get(CDN).intercept({ path: '/abc/p.jpg' }).reply(200, 'JPG', { headers: { 'Content-Type': 'image/jpeg' } });
    const res = await call(await imgPath('img', cdn('/abc/p.jpg'), signer), { headers: { Accept: 'image/webp' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('Vary')).toBe('Accept');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  it('falls back to the original bytes when the transformer fails', async () => {
    fetchMock.get(CDN).intercept({ path: '/abc/q.jpg' }).reply(415, 'unsupported');
    fetchMock.get(CDN).intercept({ path: '/abc/q.jpg' }).reply(200, 'ORIG', { headers: { 'Content-Type': 'image/jpeg' } });
    const res = await call(await imgPath('img', cdn('/abc/q.jpg'), signer), { headers: { Accept: 'image/webp' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ORIG');
    // Short cache only: a failure such as the free-plan quota (error 9422) must not pin the
    // unoptimised original for a year — the optimised version replaces it within the hour.
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
  });

  it('refuses a non-image answer on an image route (502, not cached)', async () => {
    fetchMock.get(CDN).intercept({ path: '/abc/r.jpg' }).reply(200, '<html>', { headers: { 'Content-Type': 'text/html' } });
    const res = await call(await imgPath('img', cdn('/abc/r.jpg'), signer));
    expect(res.status).toBe(502);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('a signed preset cannot be swapped for another', async () => {
    const p = await imgPath('img', cdn('/abc/p.jpg'), signer);
    expect((await call(p.replace('/_img/img/', '/_img/og/'))).status).toBe(403);
  });
});
