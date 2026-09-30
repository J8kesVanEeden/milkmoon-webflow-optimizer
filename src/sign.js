// HMAC-SHA256 link signatures. The Worker signs every proxy URL it writes; the proxy routes serve only
// validly signed URLs. This replaces per-site ID allowlists: nothing to configure, nothing to maintain,
// and the proxy can never be used as an open relay for other tenants on Webflow's shared CDN.
const enc = new TextEncoder();
const SIG_RE = /^[A-Za-z0-9_-]{16}$/;
const MEMO_MAX = 5000;

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

export async function makeSigner(key) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  // 16 base64url chars = 96 bits — far beyond brute-force range, short enough for tidy URLs.
  const compute = async (s) => b64url(await crypto.subtle.sign('HMAC', k, enc.encode(s))).slice(0, 16);

  // Per-isolate memo: the same page URLs are signed on every HTML request. Only sign() — i.e. URLs
  // the Worker itself wrote — may fill it; verify() handles attacker-supplied strings and must never
  // grow it (memory exhaustion via huge made-up paths).
  const memo = new Map();

  async function sign(s) {
    let v = memo.get(s);
    if (!v) {
      v = await compute(s);
      if (memo.size >= MEMO_MAX) memo.clear();
      memo.set(s, v);
    }
    return v;
  }

  async function verify(s, sig) {
    if (typeof sig !== 'string' || !SIG_RE.test(sig)) return false;
    const want = memo.get(s) ?? (await compute(s));
    let diff = 0; // constant-time compare
    for (let i = 0; i < 16; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
    return diff === 0;
  }

  return { sign, verify, memoSize: () => memo.size };
}
