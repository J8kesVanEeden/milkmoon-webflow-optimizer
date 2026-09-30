// Signed proxy URLs.
//   files:  /_wf/<sig>/<host><path><search>
//   images: /_img/<preset>/<sig>/<host><path><search>
// Canonical signed strings: `wf|<host><path><search>` and `img|<preset>|<host><path><search>`.
// <path> is the Webflow URL's pathname as the URL parser gives it (never decoded), so filenames with
// literal %xx, commas or parentheses round-trip byte-exactly.
import { isWebflowAssetHost } from './webflow.js';

export const PRESETS = Object.freeze(['img', 'og']);
const SIG = '([A-Za-z0-9_-]{16})';
const WF = new RegExp(`^/_wf/${SIG}/([a-z0-9.-]+)(/[^?#]*)$`);
const IMG = new RegExp(`^/_img/([a-z0-9]+)/${SIG}/([a-z0-9.-]+)(/[^?#]*)$`);
// '.', '..' and their percent-encoded forms — a URL parser resolves all of them as dot-segments.
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

const tailOf = (url) => url.host + url.pathname + url.search;

export async function wfPath(url, signer) {
  const tail = tailOf(url);
  return `/_wf/${await signer.sign('wf|' + tail)}/${tail}`;
}

export async function imgPath(preset, url, signer) {
  const tail = tailOf(url);
  return `/_img/${preset}/${await signer.sign(`img|${preset}|${tail}`)}/${tail}`;
}

// Real Webflow asset paths are well under this; anything longer is not something we wrote.
const MAX_SIGNED_LENGTH = 2048;

export async function parseSigned(pathname, search, signer) {
  if (pathname.length + (search || '').length > MAX_SIGNED_LENGTH) return null;
  let m, kind, preset, sig, host, path;
  if ((m = pathname.match(WF))) [kind, sig, host, path] = ['wf', m[1], m[2], m[3]];
  else if ((m = pathname.match(IMG))) [kind, preset, sig, host, path] = ['img', m[1], m[2], m[3], m[4]];
  else return null;

  if (kind === 'img' && !PRESETS.includes(preset)) return null;
  if (!isWebflowAssetHost(host)) return null;
  if (path.split('/').some((seg) => DOT_SEGMENT.test(seg))) return null;

  const tail = host + path + (search || '');
  const signed = kind === 'wf' ? 'wf|' + tail : `img|${preset}|${tail}`;
  if (!(await signer.verify(signed, sig))) return null;
  return { kind, preset, url: new URL('https://' + tail) };
}
