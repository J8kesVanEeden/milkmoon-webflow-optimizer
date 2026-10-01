#!/usr/bin/env python3
"""
Scheduled monitor for every install in monitor/sites.json (docs/MONITORING-PLAN.md).

  python3 scripts/monitor.py live    # every 30 min: is each site working right now?
  python3 scripts/monitor.py drift   # daily: did Webflow start using hosts/scripts we have not seen?
  python3 scripts/monitor.py logs    # daily: Worker exceptions/errors, failures + challenges on signed paths
                                     #        (needs CF_API_TOKEN, read-only; skipped if absent)

Writes a Markdown report to $MONITOR_REPORT (default monitor-report.md) and exits 1 if anything
failed, so the workflow can open / comment / close a GitHub issue. Read-only: never changes a site.
Live checks retry once after 90 s before failing, so a single network or Webflow blip does not alert.
"""
import html as htmlmod, json, os, random, re, sys, time, urllib.error, urllib.parse, urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG = json.load(open(os.path.join(ROOT, 'monitor', 'sites.json')))
SITES = CONFIG['sites']
FINGERPRINT = os.path.join(ROOT, 'monitor', 'fingerprint.json')
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 webflow-o2o-monitor'
WF_CDN = re.compile(r'(?:src|href|content|poster|srcset|data-src)="[^"]*https://(?:cdn\.prod|assets|assets-global)\.website-files\.com/[0-9a-f]{24}/(?![^"]*/dist/)[^"]*\.(?:jpe?g|png|webp|gif|css|js|svg)(?=["?\s,])')
report, failures = [], []


def fetch(url, accept='text/html,*/*', method='GET', timeout=30):
    req = urllib.request.Request(url, method=method, headers={'User-Agent': UA, 'Accept': accept, 'Accept-Encoding': 'identity'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read()
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}, e.read()
    except Exception as e:  # DNS, TLS, timeout
        return 0, {}, str(e).encode()


def signed_urls(page_html, base):
    urls = set()
    for v in re.findall(r'\s(?:src|href|content|data-src)="([^"]+)"', page_html):
        urls.add(htmlmod.unescape(v))
    for v in re.findall(r'\s(?:srcset|data-srcset|imagesrcset)="([^"]+)"', page_html):
        for part in re.split(r',\s+(?=https?://|/)', htmlmod.unescape(v)):
            urls.add(part.strip().rsplit(' ', 1)[0])
    out = []
    for u in urls:
        u = urllib.parse.urljoin(base + '/', u)
        if u.startswith(base + '/_img/') or u.startswith(base + '/_wf/'):
            out.append(u)
    return sorted(out)


def check_site_live(s):
    """Returns a list of problems for one site (empty = healthy)."""
    probs, base = [], s['url'].rstrip('/')
    for path in s['pages']:
        st, h, body = fetch(base + path + ('&' if '?' in path else '?') + 'monitor=' + str(random.randint(1, 10**9)))
        page = body.decode('utf-8', 'replace')
        if st != 200:
            probs.append(f'{path}: HTTP {st}'); continue
        ver = (h.get('x-edge-worker') or '').rsplit('/', 1)[-1]
        if ver != s['version']:
            probs.append(f'{path}: served by Worker version {ver or "NONE"}, expected {s["version"]}')
        if 'data-wf-site' not in page:
            probs.append(f'{path}: Webflow marker data-wf-site missing — Webflow changed its markup, or the page is not Webflow any more')
        raw = WF_CDN.findall(page)
        if raw:
            probs.append(f'{path}: {len(raw)} Webflow file address(es) left un-rewritten, e.g. {raw[0][:140]}')
        signed = signed_urls(page, base)
        if path == s['pages'][0] and not any('/_img/' in u for u in signed):
            probs.append(f'{path}: no /_img/ links at all on the homepage')
        sample = random.sample(signed, min(10, len(signed)))
        for u in sample:
            st2, h2, b2 = fetch(u, accept='image/avif,image/webp,*/*')
            ctype = h2.get('content-type', '')
            if st2 != 200:
                probs.append(f'signed file HTTP {st2}: {u[:160]}')
            elif '/_img/' in u and not ctype.startswith('image/'):
                probs.append(f'signed image answered as {ctype}: {u[:160]}')
        if sample:  # the security lock: a tampered signature must be refused
            u = sample[0]
            m = re.search(r'/_(?:img/[a-z]+|wf)/([A-Za-z0-9_-]{16})/', u)
            if m:
                bad = u.replace(m.group(1), ('A' if m.group(1)[0] != 'A' else 'B') + m.group(1)[1:], 1)
                st3, _, _ = fetch(bad)
                if st3 != 403:
                    probs.append(f'tampered signature answered HTTP {st3}, expected 403 (signature lock!)')
        if path == s.get('turnstile_page'):
            # Same rule as site-audit: the page may or may not carry Turnstile; it must never be proxied.
            if re.search(r'/_wf/[^"]*challenges\.cloudflare\.com', page):
                probs.append(f'{path}: Turnstile is being proxied (must load from challenges.cloudflare.com)')
    for u in s.get('untouched', []):
        st, h, _ = fetch(u)
        if st != 200:
            probs.append(f'dependent host {u}: HTTP {st}')
        elif h.get('x-edge-worker'):
            probs.append(f'dependent host {u} is answered by the Worker (route widened?)')
    return probs


def cmd_live():
    for s in SITES:
        probs = check_site_live(s)
        if probs:  # one retry, so a single blip does not alert
            time.sleep(int(os.environ.get('MONITOR_RETRY_SECONDS', '90')))
            probs = check_site_live(s)
        report.append(f"### {s['name']} — {'❌ FAIL' if probs else '✅ ok'} ({s['url']}, expect {s['version']})")
        report.extend(f'- {p}' for p in probs)
        failures.extend(f"{s['name']}: {p}" for p in probs)


def inventory(s):
    """External hosts + Webflow runtime script names on a site's pages (as Webflow serves them)."""
    hosts, scripts = set(), set()
    base = s['url'].rstrip('/')
    for path in s['pages']:
        st, _, body = fetch(base + path)
        page = body.decode('utf-8', 'replace')
        for tag, attr in (('script', 'src'), ('link', 'href'), ('img', 'src'), ('iframe', 'src')):
            for v in re.findall(r'<%s\b[^>]*\s%s="([^"]+)"' % (tag, attr), page):
                v = htmlmod.unescape(v)
                if '/_wf/' in v or '/_img/' in v:  # look through our own signed links to the real host
                    m = re.search(r'/_(?:wf|img/[a-z]+)/[A-Za-z0-9_-]{16}/([^/]+)/', v)
                    if m: hosts.add(m.group(1))
                    continue
                if v.startswith('//'): v = 'https:' + v
                if v.startswith('http'):
                    hosts.add(urllib.parse.urlsplit(v).hostname or '')
        # Webflow runtime chunks: names change per publish, so record the PATTERN, not the hash
        for n in re.findall(r'/js/[a-z0-9-]+\.((?:schunk|achunk|[a-z0-9]{8}))\.[0-9a-f]+\.js', page):
            scripts.add('schunk' if n == 'schunk' else 'achunk' if n == 'achunk' else 'site-bundle')
    hosts.discard(urllib.parse.urlsplit(base).hostname)
    return sorted(h for h in hosts if h), sorted(scripts)


def cmd_drift():
    base = json.load(open(FINGERPRINT)) if os.path.exists(FINGERPRINT) else {}
    update = os.environ.get('MONITOR_UPDATE_FINGERPRINT') == '1'
    write = update or any(s['name'] not in base for s in SITES)
    for s in SITES:
        hosts, scripts = inventory(s)
        old = base.get(s['name'], {})
        new_hosts = sorted(set(hosts) - set(old.get('hosts', hosts)))
        gone_hosts = sorted(set(old.get('hosts', hosts)) - set(hosts))
        new_scripts = sorted(set(scripts) - set(old.get('scripts', scripts)))
        changed = new_hosts or gone_hosts or new_scripts
        report.append(f"### {s['name']} — {'⚠️ CHANGED' if changed else '✅ no change'} ({len(hosts)} external hosts)")
        if new_hosts: report.append(f'- NEW hosts on the page: {", ".join(new_hosts)} — classify: should the Worker proxy it, or leave it alone?')
        if gone_hosts: report.append(f'- hosts no longer on the page: {", ".join(gone_hosts)}')
        if new_scripts: report.append(f'- NEW Webflow runtime script type: {", ".join(new_scripts)}')
        if changed and not update:
            failures.append(f"{s['name']}: page inventory changed")
        if update or not old:
            base[s['name']] = {'hosts': hosts, 'scripts': scripts, 'recorded': datetime.now(timezone.utc).strftime('%Y-%m-%d')}
    if write:
        with open(FINGERPRINT, 'w') as f:
            json.dump(base, f, indent=2); f.write('\n')
        report.append('- baseline written to monitor/fingerprint.json')


def cf(path, body=None):
    tok = os.environ['CF_API_TOKEN']
    req = urllib.request.Request('https://api.cloudflare.com/client/v4' + path, method='POST' if body is not None else 'GET',
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(req, timeout=60))


ACCOUNT = os.environ.get('CF_ACCOUNT_ID') or CONFIG.get('account_id', '')
BAD_OUTCOMES = ('scriptThrewException', 'exceededResources', 'internalError', 'exceededCpu', 'exceededMemory')


def cmd_logs():
    """Last 24 h from Cloudflare analytics. Needs only Account Analytics: Read (the token the dashboard
    offers). Zone traffic (5xx / firewall challenges on signed paths) is added only if the token can
    read it — otherwise listed as not covered; the hourly live check still fetches signed files."""
    if not os.environ.get('CF_API_TOKEN'):
        report.append('### logs — ⏭️ skipped: CF_API_TOKEN not set (see docs/MONITORING-PLAN.md)')
        return
    end = datetime.now(timezone.utc).replace(microsecond=0)
    start = end - timedelta(hours=24)
    iso = lambda d: d.strftime('%Y-%m-%dT%H:%M:%SZ')
    q = ('{viewer{accounts(filter:{accountTag:"%s"}){w:workersInvocationsAdaptive(limit:1000,filter:{datetime_geq:"%s",'
         'datetime_leq:"%s"}){sum{requests errors} dimensions{scriptName status}}}}}') % (ACCOUNT, iso(start), iso(end))
    d = cf('/graphql', {'query': q})
    if d.get('errors'):
        report.append(f'### logs — ❌ Workers analytics query failed: {d["errors"][0]["message"][:200]}')
        failures.append('logs: Workers analytics query failed'); return
    rows = d['data']['viewer']['accounts'][0]['w']
    # Image transformations this month vs the 5,000 free (account-wide; after that new variants fall
    # back to the original image). Daily figures appear with a delay, so today may still read 0.
    month = end.strftime('%Y-%m-01')
    t = cf('/graphql', {'query': '{viewer{accounts(filter:{accountTag:"%s"}){t:imagesUniqueTransformations(limit:100,filter:{date_geq:"%s",date_leq:"%s"}){date transformations}}}}' % (ACCOUNT, month, end.strftime('%Y-%m-%d'))})
    if not t.get('errors'):
        used = sum(r['transformations'] for r in t['data']['viewer']['accounts'][0]['t'])
        free = int(os.environ.get('IMAGES_FREE_TRANSFORMATIONS', '5000'))
        report.append(f'### image transformations — {used:,} unique this month of {free:,} free ({100 * used / free:.0f}%)')
        if used > 0.7 * free:
            report.append('- ⚠️ over 70% of the free allowance: past it, new image variants fall back to the original until the month resets')
            failures.append(f'image transformations at {100 * used / free:.0f}% of the free allowance')
    for s in SITES:
        probs, info = [], []
        mine = [r for r in rows if r['dimensions']['scriptName'] == s['worker']]
        by = Counter()
        for r in mine: by[r['dimensions']['status']] += r['sum']['requests']
        total = sum(by.values()); errors = sum(r['sum']['errors'] for r in mine)
        info.append(f'Worker {s["worker"]}: {total} requests, outcomes {dict(by)}, errors {errors}')
        if total == 0:
            probs.append('Worker answered 0 requests in 24 h — route removed or Worker not running?')
        bad = {k: v for k, v in by.items() if k in BAD_OUTCOMES}
        if bad: probs.append(f'Worker crashed / ran out of resources: {bad}')
        if total and errors / total > 0.005: probs.append(f'Worker error rate {100 * errors / total:.2f}% (> 0.5%)')
        # Optional: zone traffic, only if this token may read it
        zq = ('{viewer{zones(filter:{zoneTag:"%s"}){g:httpRequestsAdaptiveGroups(limit:5000,filter:{datetime_geq:"%s",datetime_lt:"%s",'
              'clientRequestHTTPHost:"%s",clientRequestPath_like:"/_%%"}){count dimensions{edgeResponseStatus securityAction}}}}}')
        if s.get('zone_id'):
            z = cf('/graphql', {'query': zq % (s['zone_id'], iso(start), iso(end), urllib.parse.urlsplit(s['url']).hostname)})
            if z.get('errors'):
                info.append('zone traffic (5xx / firewall challenges on /_img + /_wf): not covered by this token')
            else:
                g = z['data']['viewer']['zones'][0]['g']
                n = sum(x['count'] for x in g); five = sum(x['count'] for x in g if x['dimensions']['edgeResponseStatus'] >= 500)
                chal = sum(x['count'] for x in g if x['dimensions']['securityAction'] in ('managed_challenge', 'challenge', 'js_challenge', 'block'))
                info.append(f'signed paths: {n} requests, {five} 5xx, {chal} firewall challenges/blocks')
                if n and five / n > 0.005: probs.append(f'signed paths 5xx rate {100 * five / n:.2f}%')
                if chal: probs.append(f'{chal} firewall challenges/blocks on signed paths (see OWASP note in the README)')
        report.append(f"### {s['name']} — {'❌ FAIL' if probs else '✅ ok'} (last 24 h)")
        report.extend(f'- {p}' for p in probs)
        report.extend(f'- {i}' for i in info)
        failures.extend(f"{s['name']}: {p}" for p in probs)


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'live'
    {'live': cmd_live, 'drift': cmd_drift, 'logs': cmd_logs}[mode]()
    stamp = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
    text = f'## Monitor `{mode}` — {stamp}\n\n' + '\n'.join(report) + '\n'
    open(os.environ.get('MONITOR_REPORT', 'monitor-report.md'), 'w').write(text)
    print(text)
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
