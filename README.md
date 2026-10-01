# Milk Moon Webflow Optimizer — faster Webflow sites, smaller images, less Webflow bandwidth

A Cloudflare Worker for **Webflow sites that run through Cloudflare** (your Webflow domain's DNS
record is proxied, the orange cloud — "O2O"). It sits in front of your site and:

- **shrinks every Webflow image** to AVIF or WebP for each visitor's browser (JPEG for social
  previews), at a quality you choose;
- **serves your Webflow images, CSS, JavaScript and fonts from your own domain**, cached at
  Cloudflare's edge close to each visitor — so Webflow sends far less and pages load faster;
- **changes nothing else.** Your pages look exactly the same.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/J8kesVanEeden/milkmoon-webflow-optimizer)

> Made by [Milk Moon Studio](https://www.milkmoonstudio.com) and running on our own site.
> **Want us to set it up for you?** [Get in touch](https://www.milkmoonstudio.com).

---

## How it works (one minute)

When a page comes back from Webflow, the Worker rewrites every Webflow file address on it to an
address on **your** domain:

| Webflow sends | The page now says | Served as |
|---|---|---|
| `https://cdn.prod.website-files.com/…/hero.jpg` | `https://www.yoursite.com/_img/img/<signature>/cdn.prod.website-files.com/…/hero.jpg` | AVIF / WebP / JPEG per browser, cached |
| `…/css/site.min.css`, `…/logo.svg`, fonts, jQuery | `https://www.yoursite.com/_wf/<signature>/…` | the same file, cached |

The first visitor anywhere near a data centre triggers one fetch from Webflow; everyone after that
gets the cached copy (Workers Cache — a repeat request is answered without running the Worker's code).

**The signature** is why there is nothing to configure per site: the Worker only serves addresses
that it wrote itself (HMAC-SHA256 with your secret key). Nobody can use your domain to fetch other
people's Webflow files or to generate image variants at your expense.

## Measured on our own install (www.milkmoonstudio.com, v6.0.0)

- The 66 image files on our homepage: **15,302 KB from Webflow → 4,169 KB through the Worker (−73%)**.
- First 24 hours live: **0** Worker errors, **0.3%** of file requests refused (bots asking for
  addresses the Worker never wrote), every one of 628 pages and 1,255 files checked and working.
- Side by side with the same site served straight from Webflow, PageSpeed's image-delivery and
  page-weight warnings were smaller with the Worker on every page we tested, and it never made a
  score worse.

## Safe by default

- **Only Webflow pages are touched.** A page is rewritten only if it carries Webflow's own
  `data-wf-site` marker. Anything else on the route — an app, an API, a login page — passes through
  byte-for-byte and is never cached by the Worker.
- **Never breaks the site.** Missing key, bad setting or a bug: the original page is served, untouched.
- **Never proxied:** Cloudflare Turnstile, Google Tag Manager / Analytics, Google Fonts, Webflow
  Optimize, marketplace-app scripts, Webflow's own runtime chunks, and video.
- **Fresh after you publish:** HTML is not cached by the Worker by default, so a Webflow publish
  shows up immediately. Files are cached for a year, which is safe because Webflow gives every
  changed file a new address.
- If an image can't be converted (e.g. an unusual format, or you run out of free transformations),
  the original is served instead — never a broken image.

## Install

**You need:** a Webflow site on a custom domain whose DNS is **proxied by Cloudflare** (orange
cloud), and a Cloudflare account on any plan.

1. **Click Deploy to Cloudflare** (above). It copies this repo into your GitHub account and deploys
   the Worker. When it asks for `SIGNING_KEY`, paste a random value of at least 32 characters —
   e.g. the output of `openssl rand -base64 36`, or any password manager's generator. Keep it
   private; you never need to type it again.
2. **Put it on your site.** In your new repo, open `wrangler.jsonc`, uncomment `routes` and put your
   Webflow host in it:
   ```jsonc
   "routes": [{ "pattern": "www.yoursite.com/*", "zone_name": "yoursite.com" }],
   ```
   Commit — Cloudflare redeploys automatically. Use **only the host that serves your Webflow site**
   (not `*.yoursite.com/*`).
3. **If your zone runs the Cloudflare OWASP Core Ruleset** (Managed Rules; Pro plan and up), add an
   exception for the Worker's paths — otherwise OWASP rule `949110: Inbound Anomaly Score Exceeded`
   treats the Webflow host name inside the paths as suspicious and shows some visitors (and Google's
   renderers) a challenge instead of the image. This is safe: every request on these paths is
   already verified by the Worker's signature. Steps (Cloudflare docs, *Add an exception in the
   dashboard*):
   1. Cloudflare dashboard → your domain → **Security rules** → **Create** → **Managed rules**.
   2. **Exception name:** `Skip OWASP on Milk Moon Webflow Optimizer paths`.
   3. **When incoming requests match** → edit the expression and paste:
      `starts_with(http.request.uri.path, "/_wf/") or starts_with(http.request.uri.path, "/_img/")`
   4. **Then:** *Skip specific rules from a Managed Ruleset* → **Select ruleset** → next to
      *Cloudflare OWASP Core Ruleset* select **Select rules** → tick the header checkbox → **Select all
      rules** → **Next** → **Deploy**.
   5. Make sure the exception is listed **before** the rule that deploys the OWASP Core Ruleset
      (exceptions only skip rules listed after them).
4. **Check it** (below). That's it.

<details><summary>Without the button (command line)</summary>

```bash
git clone https://github.com/J8kesVanEeden/milkmoon-webflow-optimizer milkmoon-webflow-optimizer && cd milkmoon-webflow-optimizer
npm ci
npx wrangler login
npx wrangler secret put SIGNING_KEY      # paste a random value, 32+ characters
# edit wrangler.jsonc → routes (step 2 above)
npm run deploy
```
</details>

## Check it's working

```bash
curl -sI https://www.yoursite.com/ | grep -i x-edge-worker
# x-edge-worker: webflow-o2o/6.0.2
```

Then view the page source: image addresses start with `https://www.yoursite.com/_img/` and
stylesheets with `https://www.yoursite.com/_wf/`. In your browser's network panel, images arrive as
`image/avif` or `image/webp`. Also try a page with a form or Turnstile to confirm it still works.

## Settings (all optional)

Set these as `vars` in `wrangler.jsonc`. Invalid values fall back to the default.

| Setting | Default | What it does |
|---|---|---|
| `IMAGE_QUALITY` | `85` | Quality (1–100) for page images. |
| `OG_FORMAT` | `jpeg` | Format for social-preview images (`og:image`, `twitter:image`): `jpeg`, `png` or `webp`. JPEG is safest for every platform. |
| `OG_QUALITY` | `80` | Quality for social-preview images. |
| `EDGE_TTL` / `BROWSER_TTL` | `31536000` | Seconds files are cached at the edge / in browsers (1 year; safe because Webflow file addresses change when files change). |
| `HTML_EDGE_TTL` | `0` | Seconds to cache **pages** in your zone. Leave at `0` unless the route covers nothing but your Webflow site: a positive value caches every response on the route before the Worker can check it's a Webflow page. Webflow already caches pages and clears them when you publish. |
| `SIGNING_KEY` | — | **Required secret.** Changing it gives every file a new address (a one-off cache refill). |

For sites that ran the older Milk Moon Worker (v4/v5) there is a `LEGACY_ROUTES` mode — see
`src/legacy.js`. New installs don't need it.

## What it costs

- **Workers requests:** every request on your route counts — pages, and each image/CSS/JS/font file,
  **including cached ones** (a cache hit skips the Worker's CPU time, not the request charge).
  Workers Free covers 100,000 requests a day; Workers Paid is $5/month with 10 million requests
  included, then $0.30 per million. [Pricing](https://developers.cloudflare.com/workers/platform/pricing/).
- **Image transformations:** Cloudflare's free allowance is **5,000 unique transformations a month**;
  after that, new ones fail (the Worker then serves the original image, cached for an hour) until
  the month resets — or buy the Images Paid plan ($0.50 per 1,000 beyond 5,000). A unique
  transformation is one image at one setting per month; repeat views are free. An image can count
  once per format it's served in (AVIF, WebP, original), so budget up to 3 per image.
  [Pricing](https://developers.cloudflare.com/images/pricing/).

## Good to know

- **Upload JPG or PNG, not AVIF, to Webflow.** Webflow makes no responsive sizes for AVIF uploads and
  Cloudflare can't convert AVIF, so AVIF files are served as they are.
- **Video** is never proxied (it needs range requests, which cached responses don't support yet).
- **Lottie JSON** and fonts referenced from *inside* stylesheets still load from Webflow.

## Updating

Pull the latest version into your repo (or re-deploy from the button) — settings live in your
`wrangler.jsonc` and your secret stays set. The `x-edge-worker` header shows which version you run.

## Uninstall

Remove the `routes` entry (or delete the Worker in the Cloudflare dashboard). Your site goes back to
loading everything from Webflow immediately. Cached files are simply no longer used.

## Develop

```bash
npm ci
npm test            # runs in the real Workers runtime, incl. real pages from 5 Webflow sites
echo 'SIGNING_KEY=local-dev-key-local-dev-key-local-dev' > .dev.vars
npm run dev
```

Code map: `src/index.js` (flow) · `config.js` (settings) · `detect.js` (is it Webflow?) ·
`rewrite.js` (the page) · `urls.js` + `sign.js` (signed addresses) · `routes.js` (serving `/_wf` +
`/_img`) · `webflow.js` (Webflow platform facts) · `legacy.js` (old address shapes).

## License

MIT — see `LICENSE`.
