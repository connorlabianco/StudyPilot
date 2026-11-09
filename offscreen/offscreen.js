// Hidden page that reads lecture files (pdf.js needs a page context; the service worker can't host it).
import * as pdfjs from "../vendor/pdfjs/pdf.mjs";
import { analyzeFile } from "../lib/extract.js";
import { ZipWriter } from "../lib/zipwrite.js";

pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdfjs/pdf.worker.mjs");
const MAX_BYTES = 150e6;

// ---------- zip building (one archive per course / folder) ----------
const zips = new Map();      // id → { zip, pending: Map(path → [chunks]) }
const blobUrls = new Set();

const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

const zipHandlers = {
  ZIP_START({ id }) { zips.set(id, { zip: new ZipWriter(), pending: new Map() }); return { ok: true }; },

  // Add a file fetched by URL (Canvas files). Returns { ok:false } if it couldn't be fetched, so the caller can fall back.
  async ZIP_ADD_URL({ id, path, url, date }) {
    const z = zips.get(id);
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const type = res.headers.get("content-type") || "";
    if (/text\/html/.test(type) && !/\.html?$/i.test(path)) throw new Error("got a web page instead of the file");
    const name = await z.zip.add(path, new Uint8Array(await res.arrayBuffer()), { date: date || new Date() });
    return { ok: true, name };
  },

  async ZIP_ADD_TEXT({ id, path, text, date }) {
    const name = await zips.get(id).zip.add(path, text, { date: date || new Date() });
    return { ok: true, name };
  },

  // Large files (e.g. from Jupyter) arrive in base64 chunks, then are committed.
  ZIP_CHUNK({ id, path, b64 }) {
    const z = zips.get(id);
    if (!z.pending.has(path)) z.pending.set(path, []);
    z.pending.get(path).push(b64ToBytes(b64));
    return { ok: true };
  },
  async ZIP_COMMIT({ id, path, date }) {
    const z = zips.get(id);
    const chunks = z.pending.get(path) || [];
    z.pending.delete(path);
    const total = chunks.reduce((a, c) => a + c.length, 0);
    const bytes = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) { bytes.set(c, o); o += c.length; }
    const name = await z.zip.add(path, bytes, { date: date || new Date() });
    return { ok: true, name };
  },

  ZIP_FINISH({ id }) {
    const z = zips.get(id);
    const blob = z.zip.finish();
    zips.delete(id);
    const url = URL.createObjectURL(blob);
    blobUrls.add(url);
    return { ok: true, url, size: blob.size, count: z.zip.count };
  },
  ZIP_REVOKE({ url }) { URL.revokeObjectURL(url); blobUrls.delete(url); return { ok: true }; },
  ZIP_ABORT({ id }) { zips.delete(id); return { ok: true }; },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return false;
  if (zipHandlers[msg.type]) {
    Promise.resolve().then(() => zipHandlers[msg.type](msg.payload || {}))
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  }
  if (msg.type !== "EXTRACT") return false;
  (async () => {
    const { url, name, mime } = msg.payload;
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const type = res.headers.get("content-type") || "";
    if (/text\/html/.test(type) && !/\.html?$/i.test(name)) throw new Error("got a web page instead of the file (are you logged in?)");
    const len = Number(res.headers.get("content-length") || 0);
    if (len > MAX_BYTES) throw new Error("file is too large to pre-read");
    const buf = await res.arrayBuffer();
    return analyzeFile(buf, { name, mime: mime || type }, pdfjs);
  })()
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
  return true;
});
