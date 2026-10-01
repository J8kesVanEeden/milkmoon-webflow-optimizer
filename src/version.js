// Shown in the x-edge-worker header. Kept out of src/index.js: workerd treats every named export of
// the entry module as a handler, so a plain constant there breaks `wrangler dev`.
export const VERSION = '6.0.2';
