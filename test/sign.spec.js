import { describe, it, expect } from 'vitest';
import { makeSigner } from '../src/sign.js';

const KEY = 'k'.repeat(32);

describe('sign', () => {
  it('produces a 16-char base64url signature that verifies', async () => {
    const s = await makeSigner(KEY);
    const sig = await s.sign('wf|cdn.prod.website-files.com/abc/x.css');
    expect(sig).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(await s.verify('wf|cdn.prod.website-files.com/abc/x.css', sig)).toBe(true);
  });
  it('rejects a signature for a different string or key', async () => {
    const s = await makeSigner(KEY);
    const sig = await s.sign('wf|a');
    expect(await s.verify('wf|b', sig)).toBe(false);
    expect(await (await makeSigner('z'.repeat(32))).verify('wf|a', sig)).toBe(false);
  });
  it('is deterministic (same input → same URL → cache hits)', async () => {
    const s = await makeSigner(KEY);
    expect(await s.sign('img|img|h/p')).toBe(await s.sign('img|img|h/p'));
  });
  it('rejects malformed signatures without throwing', async () => {
    const s = await makeSigner(KEY);
    for (const bad of ['', 'short', 'x'.repeat(16), '!!!!!!!!!!!!!!!!', null, undefined, 42]) {
      expect(await s.verify('wf|a', bad)).toBe(false);
    }
  });
  it('rejects a signature that differs in one character', async () => {
    const s = await makeSigner(KEY);
    const sig = await s.sign('wf|a');
    const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    expect(await s.verify('wf|a', flipped)).toBe(false);
  });

  it('verify never stores attacker-supplied strings (memo only grows from sign)', async () => {
    const s = await makeSigner(KEY);
    for (let i = 0; i < 50; i++) await s.verify('wf|' + 'x'.repeat(1000) + i, 'AAAAAAAAAAAAAAAA');
    expect(s.memoSize()).toBe(0);
    await s.sign('wf|a');
    expect(s.memoSize()).toBe(1);
  });
});
