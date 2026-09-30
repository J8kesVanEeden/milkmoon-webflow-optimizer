// Reads just enough of the body to see the <html> tag (≤16 KB), then replays those bytes in front of
// the untouched rest of the stream. Only pages carrying Webflow's data-wf-site marker get rewritten, so
// attaching the Worker to a non-Webflow host (the 2026-07-16 outage) is harmless.
const LIMIT = 16384;
const MARKER = /<html\b[^>]*\bdata-wf-site="([0-9a-f]{24})"/i;
const HTML_TAG_DONE = /<html\b[^>]*>/i;
const stripComments = (t) => t.replace(/<!--[\s\S]*?(?:-->|$)/g, '');

export async function detectWebflow(response) {
  if (!response.body) return { isWebflow: false, siteId: null, response };

  const reader = response.body.getReader();
  const dec = new TextDecoder();
  const seen = [];
  let text = '';
  let size = 0;
  let ended = false;

  while (size < LIMIT) {
    const { value, done } = await reader.read();
    if (done) { ended = true; break; }
    seen.push(value);
    size += value.byteLength;
    text += dec.decode(value, { stream: true });
    // Stop at the first <html> tag that is NOT inside a comment (a leading comment can quote one).
    if (HTML_TAG_DONE.test(stripComments(text))) break;
  }

  const m = stripComments(text).match(MARKER);
  const body = new ReadableStream({
    start(c) {
      for (const chunk of seen) c.enqueue(chunk);
      if (ended) c.close();
    },
    async pull(c) {
      const { value, done } = await reader.read();
      if (done) c.close();
      else c.enqueue(value);
    },
    cancel(reason) { return reader.cancel(reason); },
  });

  return { isWebflow: !!m, siteId: m ? m[1].toLowerCase() : null, response: new Response(body, response) };
}
