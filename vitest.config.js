import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// Test-only: import test/fixtures/*.html as strings (Vite's ?raw path does not resolve in the workers
// pool when the project path contains spaces). Never part of the Worker bundle.
const htmlFixtures = {
  name: 'html-fixtures-as-strings',
  enforce: 'pre',
  transform(code, id) {
    if (/\/test\/fixtures\/[^/]+\.html$/.test(id)) return { code: `export default ${JSON.stringify(code)};`, map: null };
  },
};

export default defineWorkersConfig({
  plugins: [htmlFixtures],
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.jsonc' },
        // Tests own their settings, so they behave the same against any wrangler.jsonc (ours or the
        // public template's). SIGNING_KEY is a secret in production; tests get a fixed dummy.
        miniflare: {
          bindings: {
            SIGNING_KEY: 'test-signing-key-'.padEnd(40, 'k'),
            LEGACY_ROUTES: 'true',
            LEGACY_DOMAIN: 'www.legacy-site.test',
            WEBFLOW_SITE_IDS: 'aaaaaaaaaaaaaaaaaaaaaaaa,bbbbbbbbbbbbbbbbbbbbbbbb',
            HTML_EDGE_TTL: '0',
          },
        },
      },
    },
  },
});
