import { describe, it, expect } from 'vitest';
import { makeSigner } from '../src/sign.js';
import { wfPath, imgPath, parseSigned } from '../src/urls.js';
import { classify, isWebflowAssetHost, isNeverProxied } from '../src/webflow.js';

const signer = await makeSigner('k'.repeat(32));
const u = (s) => new URL(s);
const splitPath = (p) => { const i = p.indexOf('?'); return i < 0 ? [p, ''] : [p.slice(0, i), p.slice(i)]; };

describe('signed URLs', () => {
  it('round-trips a CSS file in a css/ subfolder', async () => {
    const src = u('https://cdn.prod.website-files.com/63565c108c96756a59b92502/css/site.shared.abc.min.css');
    const p = await wfPath(src, signer);
    expect(p).toMatch(/^\/_wf\/[A-Za-z0-9_-]{16}\/cdn\.prod\.website-files\.com\/63565c108c96756a59b92502\/css\/site\.shared\.abc\.min\.css$/);
    const back = await parseSigned(p, '', signer);
    expect(back.kind).toBe('wf');
    expect(back.url.href).toBe(src.href);
  });

  it('keeps literal %xx, spaces-as-%20, commas and parentheses byte-exact', async () => {
    for (const name of ['Project%2520-%2520Stitch.png', 'Hands%202.svg', 'a%2Cb(1).jpg', '%C3%A9t%C3%A9.jpg', 'a,b.jpg']) {
      const src = u(`https://cdn.prod.website-files.com/63565c108c96757108b92506/${name}`);
      const p = await imgPath('img', src, signer);
      // What the Worker will actually see: the path after the runtime's own URL parsing.
      const seen = new URL('https://site.example' + p).pathname;
      const back = await parseSigned(seen, '', signer);
      expect(back, name).not.toBeNull();
      expect(back.url.pathname, name).toBe(src.pathname);
    }
  });

  it('signs and restores query strings (jQuery ?site=)', async () => {
    const src = u('https://d3e54v103j8qbb.cloudfront.net/js/jquery-3.5.1.min.dc5e7f18c8.js?site=63565c108c96756a59b92502');
    const [path, search] = splitPath(await wfPath(src, signer));
    expect((await parseSigned(path, search, signer)).url.href).toBe(src.href);
    expect(await parseSigned(path, '?site=6090e50d603a110a1103c621', signer)).toBeNull(); // tampered query
    expect(await parseSigned(path, '', signer)).toBeNull(); // stripped query
  });

  it('a wf signature is not valid as an img signature (and presets do not swap)', async () => {
    const src = u('https://cdn.prod.website-files.com/a/b.jpg');
    const wf = await wfPath(src, signer);
    const sig = wf.split('/')[2];
    expect(await parseSigned(`/_img/img/${sig}/cdn.prod.website-files.com/a/b.jpg`, '', signer)).toBeNull();
    const img = await imgPath('img', src, signer);
    expect(await parseSigned(img.replace('/_img/img/', '/_img/og/'), '', signer)).toBeNull();
  });

  it('rejects tampering, foreign hosts, traversal and unknown presets', async () => {
    const p = await wfPath(u('https://cdn.prod.website-files.com/63565c108c96756a59b92502/x.css'), signer);
    expect(await parseSigned(p.replace('x.css', 'y.css'), '', signer)).toBeNull();
    expect(await parseSigned('/_wf/AAAAAAAAAAAAAAAA/evil.com/x.css', '', signer)).toBeNull();
    expect(await parseSigned(p.replace('/x.css', '/../x.css'), '', signer)).toBeNull();
    expect(await parseSigned('/_img/w9999/AAAAAAAAAAAAAAAA/cdn.prod.website-files.com/a/b.jpg', '', signer)).toBeNull();
    expect(await parseSigned('/about', '', signer)).toBeNull();
  });

  it('rejects over-long signed paths without verifying (2 KB cap)', async () => {
    const tail = 'cdn.prod.website-files.com/a/' + 'x'.repeat(2100) + '.css';
    const sig = await signer.sign('wf|' + tail);
    expect(await parseSigned(`/_wf/${sig}/${tail}`, '', signer)).toBeNull();
  });

  it('rejects encoded dot-segments even when validly signed', async () => {
    for (const seg of ['%2e%2e', '%2E%2E', '.%2e', '%2e']) {
      const tail = `cdn.prod.website-files.com/a/${seg}/b.css`;
      const sig = await signer.sign('wf|' + tail);
      expect(await parseSigned(`/_wf/${sig}/${tail}`, '', signer), seg).toBeNull();
    }
  });
});

describe('webflow platform facts', () => {
  it('classifies Webflow files', () => {
    expect(classify(u('https://cdn.prod.website-files.com/a/b.jpg'))).toBe('image');
    expect(classify(u('https://cdn.prod.website-files.com/a/b.JPEG'))).toBe('image');
    expect(classify(u('https://cdn.prod.website-files.com/a/b.gif'))).toBe('image');
    expect(classify(u('https://cdn.prod.website-files.com/a/b.avif'))).toBe('passthrough-image');
    expect(classify(u('https://cdn.prod.website-files.com/a/b.svg'))).toBe('passthrough-image');
    expect(classify(u('https://cdn.prod.website-files.com/a/css/b.css'))).toBe('asset');
    expect(classify(u('https://cdn.prod.website-files.com/a/b.woff2'))).toBe('asset');
    expect(classify(u('https://cdn.prod.website-files.com/a/b.mp4'))).toBeNull();
    expect(classify(u('https://cdn.prod.website-files.com/a/noext'))).toBeNull();
    expect(classify(u('https://example.com/a/b.jpg'))).toBeNull();
  });

  it('only allows the jQuery path on the jQuery CDN', () => {
    expect(classify(u('https://d3e54v103j8qbb.cloudfront.net/js/jquery-3.5.1.min.dc5e7f18c8.js'))).toBe('asset');
    expect(classify(u('https://d3e54v103j8qbb.cloudfront.net/other/x.js'))).toBeNull();
  });

  it('knows the asset hosts and the never-proxy list', () => {
    expect(isWebflowAssetHost('global-uploads.webflow.com')).toBe(true);
    expect(isWebflowAssetHost('code-components.website-files.com')).toBe(false);
    expect(isNeverProxied('challenges.cloudflare.com')).toBe(true);
    expect(isNeverProxied('www.googletagmanager.com')).toBe(true);
    expect(isNeverProxied('notgoogletagmanager.com')).toBe(false);
  });
});
