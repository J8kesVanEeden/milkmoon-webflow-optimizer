import { describe, it, expect } from 'vitest';
import { detectWebflow } from '../src/detect.js';

const enc = new TextEncoder();
const chunked = (parts, init = { headers: { 'Content-Type': 'text/html' } }) =>
  new Response(new ReadableStream({ start(c) { for (const p of parts) c.enqueue(enc.encode(p)); c.close(); } }), init);

describe('detectWebflow', () => {
  it('finds data-wf-site and returns the body byte-identical', async () => {
    const html = '<!DOCTYPE html><html data-wf-domain="x.webflow.io" data-wf-site="63565c108c96756a59b92502"><body>hi</body></html>';
    const r = await detectWebflow(chunked([html.slice(0, 20), html.slice(20)]));
    expect(r.isWebflow).toBe(true);
    expect(r.siteId).toBe('63565c108c96756a59b92502');
    expect(await r.response.text()).toBe(html);
  });

  it('finds the marker when the <html> tag arrives after a long comment in a later chunk', async () => {
    const html = '<!DOCTYPE html>\n<!-- ' + 'x'.repeat(9000) + ' -->\n<html data-wf-site="61819aaca0e7acc94c5a2d47"><body></body></html>';
    const r = await detectWebflow(chunked([html.slice(0, 4000), html.slice(4000, 9500), html.slice(9500)]));
    expect(r.isWebflow).toBe(true);
    expect(await r.response.text()).toBe(html);
  });

  it('finds the marker when the attribute itself is split across chunks', async () => {
    const html = '<!DOCTYPE html><html lang="en" data-wf-site="63565c108c96756a59b92502"><body>ok</body></html>';
    const cut = html.indexOf('wf-site') + 3;
    const r = await detectWebflow(chunked([html.slice(0, cut), html.slice(cut)]));
    expect(r.isWebflow).toBe(true);
    expect(await r.response.text()).toBe(html);
  });

  it('is not fooled by an <html> tag inside a leading comment', async () => {
    const html = '<!DOCTYPE html><!-- old: <html lang="x"> -->\n<html data-wf-site="63565c108c96756a59b92502"><body></body></html>';
    const r = await detectWebflow(chunked([html.slice(0, 40), html.slice(40)]));
    expect(r.isWebflow).toBe(true);
    expect(await r.response.text()).toBe(html);
  });

  it('is not fooled by a Webflow <html> tag quoted inside a comment', async () => {
    const html = '<!DOCTYPE html><!-- <html data-wf-site="63565c108c96756a59b92502"> --><html lang="en"><body></body></html>';
    const r = await detectWebflow(chunked([html]));
    expect(r.isWebflow).toBe(false);
    expect(await r.response.text()).toBe(html);
  });

  it('says no for non-Webflow HTML and still returns every byte', async () => {
    const html = '<!DOCTYPE html><html lang="en"><body>' + 'y'.repeat(30000) + '</body></html>';
    const r = await detectWebflow(chunked([html.slice(0, 1000), html.slice(1000)]));
    expect(r.isWebflow).toBe(false);
    expect(r.siteId).toBe(null);
    expect(await r.response.text()).toBe(html);
  });

  it('ignores the marker text when it is not on the <html> tag', async () => {
    const html = '<!DOCTYPE html><html lang="en"><body>data-wf-site="63565c108c96756a59b92502"</body></html>';
    const r = await detectWebflow(chunked([html]));
    expect(r.isWebflow).toBe(false);
    expect(await r.response.text()).toBe(html);
  });

  it('gives up after 16 KB with no <html> tag and keeps every byte', async () => {
    const html = 'z'.repeat(20000) + '<html data-wf-site="63565c108c96756a59b92502"></html>';
    const r = await detectWebflow(chunked([html.slice(0, 8000), html.slice(8000, 17000), html.slice(17000)]));
    expect(r.isWebflow).toBe(false);
    expect(await r.response.text()).toBe(html);
  });

  it('keeps status and headers', async () => {
    const r = await detectWebflow(chunked(['<html></html>'], { status: 404, headers: { 'Content-Type': 'text/html', 'X-Test': '1' } }));
    expect(r.response.status).toBe(404);
    expect(r.response.headers.get('X-Test')).toBe('1');
  });

  it('handles an empty body and a null body', async () => {
    const r = await detectWebflow(new Response('', { headers: { 'Content-Type': 'text/html' } }));
    expect(r.isWebflow).toBe(false);
    expect(await r.response.text()).toBe('');
    const n = await detectWebflow(new Response(null, { status: 204 }));
    expect(n.isWebflow).toBe(false);
    expect(n.response.status).toBe(204);
  });
});
