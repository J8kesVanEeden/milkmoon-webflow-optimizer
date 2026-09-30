// Webflow PLATFORM facts only (true for every Webflow site). Nothing about any one site belongs here.
// Source: research/webflow-cdn-scan/REPORT.md (106 Webflow sites, 2026-09-28).
export const WEBFLOW_ASSET_HOSTS = Object.freeze([
  'cdn.prod.website-files.com',
  'assets.website-files.com',
  'assets-global.website-files.com',
  'uploads-ssl.webflow.com',
  'global-uploads.webflow.com',
]);
// Webflow's jQuery CDN. Only /js/jquery* is ever proxied from it.
export const JQUERY_HOST = 'd3e54v103j8qbb.cloudfront.net';

// Dynamic / per-visitor / rotating scripts: never proxied (the Turnstile outage class).
// code-components.website-files.com is deliberately NOT an asset host (Webflow code components).
const NEVER = Object.freeze([
  'challenges.cloudflare.com', 'intellimize.co', 'intellimizeio.com', 'webflow.services',
  'googletagmanager.com', 'google-analytics.com', 'fonts.googleapis.com', 'fonts.gstatic.com',
]);
const endsWithHost = (h, list) => list.some((d) => h === d || h.endsWith('.' + d));

export const isWebflowAssetHost = (h) => WEBFLOW_ASSET_HOSTS.includes(h) || h === JQUERY_HOST;
export const isNeverProxied = (h) => endsWithHost(h, NEVER);

// 'image' → may go through the transformer. GIF is included (animation is preserved for GIF/WebP
// output); routes.js never asks for AVIF output from a GIF, since AVIF output isn't animated.
const IMAGE = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
// AVIF input is unsupported (error 9520); SVG is never resized. Cached, but served as-is.
const PASS = ['avif', 'svg'];
const ASSET = ['css', 'js', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'ico', 'json'];

export function extOf(url) {
  const last = url.pathname.split('/').pop() || '';
  const dot = last.lastIndexOf('.');
  return dot < 0 ? '' : last.slice(dot + 1).toLowerCase();
}

export function classify(url) {
  const h = url.hostname.toLowerCase();
  if (!isWebflowAssetHost(h) || isNeverProxied(h)) return null;
  if (h === JQUERY_HOST && !url.pathname.startsWith('/js/jquery')) return null;
  const ext = extOf(url);
  if (IMAGE.includes(ext)) return 'image';
  if (PASS.includes(ext)) return 'passthrough-image';
  if (ASSET.includes(ext)) return 'asset';
  return null;
}
