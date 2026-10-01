import { describe, it, expect } from 'vitest';
import { parseConfig } from '../src/config.js';

const KEY = 'k'.repeat(32);

describe('config', () => {
  it('works with ONLY a signing key (every other value defaults)', () => {
    const r = parseConfig({ SIGNING_KEY: KEY });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.config).toMatchObject({
      IMAGE_QUALITY: 85, OG_FORMAT: 'jpeg', OG_QUALITY: 80,
      EDGE_TTL: 31536000, BROWSER_TTL: 31536000, LEGACY_ROUTES: false,
    });
    // 0 = no HTML caching in the customer's zone (safe on any host; Webflow's own edge caches and
    // purges on publish). Opt in with a positive value only when the route covers only Webflow.
    expect(r.config.HTML_EDGE_TTL).toBe(0);
    // Page-behaviour changes are opt-in (decided 2026-09-28).
    expect(r.config.SIZES_AUTO).toBe(false);
    expect(Object.isFrozen(r.config)).toBe(true);
  });

  it('SIZES_AUTO is on only for an explicit "true"', () => {
    expect(parseConfig({ SIGNING_KEY: KEY, SIZES_AUTO: 'true' }).config.SIZES_AUTO).toBe(true);
    expect(parseConfig({ SIGNING_KEY: KEY, SIZES_AUTO: ' TRUE ' }).config.SIZES_AUTO).toBe(true);
    for (const v of ['1', 'yes', 'false', '', undefined]) {
      expect(parseConfig({ SIGNING_KEY: KEY, SIZES_AUTO: v }).config.SIZES_AUTO).toBe(false);
    }
  });

  it('is not ok without a signing key, or with one under 32 chars', () => {
    expect(parseConfig({}).ok).toBe(false);
    expect(parseConfig({ SIGNING_KEY: 'short' }).errors.join()).toMatch(/SIGNING_KEY/);
    expect(parseConfig({ SIGNING_KEY: 'k'.repeat(31) }).ok).toBe(false);
  });

  it('never throws on a missing or odd env', () => {
    expect(() => parseConfig(undefined)).not.toThrow();
    expect(parseConfig(undefined).ok).toBe(false);
    expect(parseConfig({ SIGNING_KEY: 12345 }).ok).toBe(false);
  });

  it('clamps and validates numbers and enums, falling back to defaults', () => {
    const c = parseConfig({ SIGNING_KEY: KEY, IMAGE_QUALITY: '500', OG_FORMAT: 'gif', HTML_EDGE_TTL: '-5' }).config;
    expect(c.IMAGE_QUALITY).toBe(85);
    expect(c.OG_FORMAT).toBe('jpeg');
    expect(c.HTML_EDGE_TTL).toBe(0);
  });

  it('accepts valid overrides, incl. jpg as jpeg and upper-case', () => {
    const c = parseConfig({ SIGNING_KEY: KEY, IMAGE_QUALITY: '70', OG_FORMAT: 'JPG', HTML_EDGE_TTL: '0' }).config;
    expect(c.IMAGE_QUALITY).toBe(70);
    expect(c.OG_FORMAT).toBe('jpeg');
    expect(c.HTML_EDGE_TTL).toBe(0);
  });

  it('rejects numbers with trailing junk instead of half-parsing them', () => {
    expect(parseConfig({ SIGNING_KEY: KEY, IMAGE_QUALITY: '70abc' }).config.IMAGE_QUALITY).toBe(85);
  });

  it('legacy mode needs site ids and a domain', () => {
    expect(parseConfig({ SIGNING_KEY: KEY, LEGACY_ROUTES: 'true' }).ok).toBe(false);
    const r = parseConfig({
      SIGNING_KEY: KEY, LEGACY_ROUTES: 'true',
      WEBFLOW_SITE_IDS: '63565c108c96756a59b92502, NOT-AN-ID ,63565C108C96757108B92506',
      LEGACY_DOMAIN: 'WWW.Example.com',
    });
    expect(r.ok).toBe(true);
    expect(r.config.WEBFLOW_SITE_IDS).toEqual(['63565c108c96756a59b92502', '63565c108c96757108b92506']);
    expect(r.config.LEGACY_DOMAIN).toBe('www.example.com');
    expect(Object.isFrozen(r.config.WEBFLOW_SITE_IDS)).toBe(true);
  });
});
