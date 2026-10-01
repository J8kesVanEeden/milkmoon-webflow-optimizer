#!/usr/bin/env python3
"""
Site-wide live audit of an install through the Worker (default: install #1, www.milkmoonstudio.com).

Pass 1 — every sitemap page: HTTP 200, served version == expected (x-edge-worker 6.x or
         X-MMS-Worker 5.x), no unrewritten Webflow CDN asset URLs left in rewritable attributes,
         Webflow CSS preloads in the Link header rewritten.
Pass 2 — every UNIQUE proxied URL found in pass 1 (/_img/, /_wf/, and the 5.x shapes /cdn-cgi/image/,
         /img-original/, /img-cache/, /asset-cache/) plus files on --also-fetch hosts is fetched for
         real; anything not 2xx is reported with its body snippet. Then up to 30 signed URLs are
         fetched AGAIN and their cf-cache-status reported (Workers Cache: want HIT).
Pass 3 — edge probes: 404 page rewritten + no-store, robots.txt / sitemap.xml untouched, Turnstile
         never proxied; for install #1 also: apex → www redirect, scan./seo./easing. untouched.

Usage:  python3 scripts/site-audit.py [expected-version] [--site URL] [--pin VERSION_ID] [--pages N] [--workers 8]
                [--also-fetch HOST ...] [--turnstile-page PATH] [--apex URL] [--untouched HOST ...]
Exit 0 only if every check passes. Reads response bytes (never text=True — that mangles \\r\\n).
"""
import argparse, concurrent.futures as cf, re, subprocess, sys, time, urllib.parse
from collections import Counter, defaultdict

MMS = 'https://www.milkmoonstudio.com'
# Install #1 extras, used only when --site is MMS (each can be overridden with its flag).
MMS_DEFAULTS = {
    # Our self-hosted fonts (Durer/Poppins). NOT dead — an earlier audit wrongly said so.
    'also_fetch': ['cdn.milkmoonstudio.com'],
    'turnstile_page': '/contact-us',
    'apex': 'https://milkmoonstudio.com/',
    'untouched': ['scan.milkmoonstudio.com', 'seo.milkmoonstudio.com', 'easing.milkmoonstudio.com'],
}
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
WF_HOSTS = r'(?:cdn\.prod|assets|assets-global)\.website-files\.com|(?:uploads-ssl|global-uploads)\.webflow\.com'
# A Webflow CDN image/css/js URL still in a rewritable attribute = a miss. Fonts are excluded (font
# preloads stay direct by design), as are /dist/ runtime chunks.
RAW = re.compile(r'(?:src|href|content|poster|srcset)="[^"]*https://(?:%s)/[0-9a-f]{24}/(?![^"]*/dist/)[^"]*\.(?:jpe?g|png|webp|gif|css|js|svg)(?=["?\s,])' % WF_HOSTS)
SINGLE_ATTR = re.compile(r'\s(?:src|href|content|poster|data-src)="([^"]*)"')
LIST_ATTR = re.compile(r'\s(?:srcset|imagesrcset|data-srcset)="([^"]*)"')
CSS_URL = re.compile(r'url\(\s*(?:&quot;|["\'])?([^"\'&\s]+?)(?:&quot;|["\'])?\s*\)')
# Proxied 5.x URLs contain commas ("format=auto,quality=85"), so srcset lists may only be split on a
# comma FOLLOWED BY WHITESPACE AND A NEW URL. (v1 of this script cut URLs at the first comma and
# requested truncated paths — the WAF then correctly 403'd them: a false failure.)
SRCSET_SPLIT = re.compile(r',\s+(?=https?://)')
PREFIXES = ('_img', '_wf', 'cdn-cgi', 'img-original', 'img-cache', 'asset-cache')


def served_version(h):
    v = h.get('x-edge-worker')
    return v.rsplit('/', 1)[-1] if v else h.get('x-mms-worker')


def worker_header(h):
    return 'x-edge-worker' in h or 'x-mms-worker' in h


def extract_proxied(body, link_header, site):
    body = body.replace('&amp;', '&')
    found = list(SINGLE_ATTR.findall(body))
    for lst in LIST_ATTR.findall(body):
        found += [c.strip().split()[0] for c in SRCSET_SPLIT.split(lst) if c.strip()]
    found += CSS_URL.findall(body)
    found += re.findall(r'<([^>]+)>', link_header)
    urls = {u for u in found if u.startswith(site + '/') and u[len(site) + 1:].split('/')[0] in PREFIXES}
    for u in urls:  # self-check: a 5.x transform URL must carry its source, never be cut short
        if u.split('/')[3] == 'cdn-cgi' and '/img-original/' not in u and '.website-files.com' not in u:
            raise SystemExit(f'EXTRACTION BUG: truncated transform URL {u[:120]}')
    return urls


EXTRA_HEADERS = []  # e.g. a version pin, set from --pin


def fetch(url, head_only=False, tries=3):
    for i in range(tries):
        cmd = ['curl', '-s', '--max-time', '30', '-A', UA, '-H', 'Accept: image/avif,image/webp,*/*', '-D', '-']
        for h in EXTRA_HEADERS:
            cmd += ['-H', h]
        cmd += ['-o', '/dev/null'] if head_only else []
        r = subprocess.run(cmd + [url], capture_output=True)
        raw = r.stdout.decode('utf-8', 'replace')
        head, _, body = raw.partition('\r\n\r\n')
        while re.match(r'HTTP/\S+ 1\d\d', head):  # skip 103 Early Hints / 100 blocks
            head, _, body = body.partition('\r\n\r\n')
        m = re.match(r'HTTP/\S+ (\d{3})', head)
        if m:
            hdrs = dict((k.lower(), v.strip()) for k, _, v in (l.partition(':') for l in head.split('\r\n')[1:]))
            return int(m.group(1)), hdrs, body
        time.sleep(1.5 * (i + 1))
    return 0, {}, ''


def edge_probes(a):
    """Pass 3 — things a page crawl can't see. Returns {problem-kind: [details]}."""
    out = defaultdict(list)
    st, h, _ = fetch(a.site + '/zz-site-audit-not-a-page')
    v = served_version(h)
    if not (st == 404 and h.get('cache-control') == 'no-store' and v and (not a.version or v == a.version)):
        out['probe-404-page'].append(f"{st} cache-control={h.get('cache-control')} v={v}")
    for path, needle in (('/robots.txt', ''), ('/sitemap.xml', '<urlset')):
        st, h, body = fetch(a.site + path)
        if st != 200 or worker_header(h) or needle not in body:
            out['probe-untouched'].append(f'{path}: {st} worker-header={worker_header(h)}')
    if a.turnstile_page:
        st, h, body = fetch(a.site + a.turnstile_page)
        if re.search(r'(?:asset-cache/https%3A%2F%2F|/_wf/[^"]*)challenges\.cloudflare\.com', body):
            out['probe-turnstile-proxied'].append(f'{a.turnstile_page} proxies challenges.cloudflare.com')
    if a.apex:
        st, h, _ = fetch(a.apex)
        want = urllib.parse.urlparse(a.site).hostname
        if st not in (301, 302, 307, 308) or want not in h.get('location', ''):
            out['probe-apex-redirect'].append(f"{st} -> {h.get('location')}")
    for host in a.untouched:
        st, h, _ = fetch(f'https://{host}/')
        if st != 200 or worker_header(h):
            out['probe-untouched-host'].append(f'{host}: {st} worker-header={worker_header(h)}')
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('version', nargs='?', default=None)
    ap.add_argument('--site', default=MMS)
    ap.add_argument('--pages', type=int, default=0, help='0 = all sitemap pages')
    ap.add_argument('--workers', type=int, default=8)
    ap.add_argument('--also-fetch', nargs='*', default=None, help='extra hosts whose URLs in the HTML are fetched too')
    ap.add_argument('--turnstile-page', default=None)
    ap.add_argument('--apex', default=None)
    ap.add_argument('--untouched', nargs='*', default=None, help='hosts that must answer 200 with no Worker header')
    ap.add_argument('--pin', default=None, help='Worker version id: send every request to that version (it must be in the current deployment, even at 0%%)')
    ap.add_argument('--worker', default='webflow-cdn-proxy-worker')
    a = ap.parse_args()
    if a.pin:
        EXTRA_HEADERS.append(f'Cloudflare-Workers-Version-Overrides: {a.worker}="{a.pin}"')
    a.site = a.site.rstrip('/')
    is_mms = a.site == MMS
    for k, v in MMS_DEFAULTS.items():
        if getattr(a, k) is None:
            setattr(a, k, v if is_mms else ([] if isinstance(v, list) else None))
    extra = re.compile(r'https://(?:%s)/[^"\'\s)]+' % '|'.join(re.escape(h) for h in a.also_fetch)) if a.also_fetch else None

    _, _, sm = fetch(a.site + '/sitemap.xml')
    pages = re.findall(r'<loc>([^<]+)</loc>', sm)
    if a.pages: pages = pages[: a.pages]
    if not pages: sys.exit('no sitemap pages found')
    print(f'pass 1: {len(pages)} pages on {a.site}…', flush=True)

    problems = defaultdict(list); versions = Counter(); proxied = defaultdict(set)
    def page(u):
        st, h, body = fetch(u)
        return u, st, h, body
    with cf.ThreadPoolExecutor(a.workers) as ex:
        for u, st, h, body in ex.map(page, pages):
            v = served_version(h); versions[v] += 1
            if st != 200: problems['page-status'].append(f'{st} {u}'); continue
            if a.version and v != a.version: problems['page-version'].append(f'{v} {u}')
            # A truncated page is what matters, not a small one (a Webflow search page is ~9 KB).
            if len(body) < 2000 or '</html>' not in body[-4096:].lower(): problems['page-tiny-body'].append(f'{len(body)}B, no closing </html>: {u}')
            for m in RAW.findall(body)[:3]: problems['page-unrewritten'].append(f'{u} :: {m[:120]}')
            link = h.get('link', '')
            if re.search(r'<https://(?:%s)/[^>]+\.css>[^,]*rel=preload' % WF_HOSTS, link):
                problems['page-link-unrewritten'].append(u)
            if extra:
                for f in extra.findall(body):
                    proxied[f].add(u)  # fetched in pass 2 like the proxy URLs
            for p in extract_proxied(body, link, a.site):
                proxied[p].add(u)

    def kind_of(p):
        return p.split('/')[3] if p.startswith(a.site + '/') else 'also:' + urllib.parse.urlparse(p).hostname
    kinds = Counter(kind_of(p) for p in proxied)
    print(f'pass 2: {len(proxied)} unique proxied URLs {dict(kinds)}…', flush=True)
    status = Counter()
    def asset(p):
        st, h, body = fetch(p)
        return p, st, h, body[:90]
    with cf.ThreadPoolExecutor(a.workers) as ex:
        for p, st, h, snip in ex.map(asset, sorted(proxied)):
            kind = kind_of(p); status[(kind, st)] += 1
            if not 200 <= st < 300:
                problems[f'asset-{kind}-{st}'].append(f'{urllib.parse.unquote(p)[-110:]}  [{snip.strip()}]  e.g. on {next(iter(proxied[p]))}')

    signed = sorted(p for p in proxied if kind_of(p) in ('_img', '_wf'))[:30]
    cache = Counter()
    if signed:
        with cf.ThreadPoolExecutor(a.workers) as ex:
            for _, st, h, _ in ex.map(asset, signed):
                cache[h.get('cf-cache-status', 'none')] += 1

    print('pass 3: edge probes…', flush=True)
    for k, v in edge_probes(a).items():
        problems[k] += v

    print('\n== versions served:', dict(versions))
    print('== proxied status:', {f'{k}:{s}': n for (k, s), n in sorted(status.items())})
    if signed:
        print(f'== Workers Cache on 2nd fetch of {len(signed)} signed URLs:', dict(cache))
    if not problems:
        print(f'\nALL CHECKS PASSED — {len(pages)} pages, {len(proxied)} unique proxied URLs, edge probes ok')
        return 0
    print('\nPROBLEMS:')
    for k, v in sorted(problems.items()):
        print(f'  {k}: {len(v)}')
        for x in v[:6]: print('     ', x)
    return 1


if __name__ == '__main__':
    sys.exit(main())
