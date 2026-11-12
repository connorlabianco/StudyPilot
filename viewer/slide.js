// "Stuck?" opens this page: the lecture at the exact slide where the idea is taught.
// Reads the lecture file with the student's own Canvas login (read-only) and draws the page with pdf.js.
import * as pdfjs from "../vendor/pdfjs/pdf.mjs";
import { getDoc } from "../lib/library.js";
import { rich } from "../lib/rich.js";
pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdfjs/pdf.worker.mjs");

const $ = (s) => document.querySelector(s);
const P = new URLSearchParams(location.search);
const key = P.get("key") || "";
let page = Math.max(1, Number(P.get("page")) || 1);
let total = 1, pdf = null, textPages = null;

function showNote(note) {
  const el = $("#note");
  el.replaceChildren();
  el.hidden = !note;
  if (note) el.append(Object.assign(document.createElement("b"), { textContent: "This slide explains: " }), rich(note));
}
// Another question about this same lecture: jump here instead of opening another tab.
const channel = new BroadcastChannel("studypilot-viewer");
channel.onmessage = async (e) => {
  const m = e.data || {};
  if (m.type !== "goto" || m.key !== key) return;
  const tab = await chrome.tabs.getCurrent().catch(() => null);
  channel.postMessage({ type: "here", key, tabId: tab?.id ?? null });
  showNote(m.note || "");
  if (nbCells) { page = Number(m.page) || 1; drawCell(); return; }
  if (pdf || textPages) { page = Math.max(1, Math.min(total, Number(m.page) || 1)); draw(); }
};

async function main() {
  showNote(P.get("note"));
  const doc = await getDoc(key).catch(() => null);
  const { settings = {} } = await chrome.storage.local.get("settings");
  const base = String(settings.canvasUrl || "").replace(/\/$/, "");
  const [courseId, kind, id] = key.split(":");
  if (!doc?.key) return fail("StudyPilot hasn't read this lecture on this computer yet. Open its menu from the lecture list once, then try again.");
  document.title = `${doc.title} · StudyPilot`;
  $("#title").textContent = doc.title;
  if (kind === "F" && base) { const a = $("#canvas"); a.href = `${base}/courses/${courseId}/files/${id}`; a.hidden = false; }
  if (doc.kind === "notebook") return showNotebook(doc);
  if (doc.kind === "page" && !doc.video) { location.replace(doc.url || `${base}/courses/${courseId}/pages/${encodeURIComponent(id)}`); return; }
  if (doc.video) {
    const t = P.get("time"); const m = t && t.match(/(?:(\d+):)?(\d+):(\d{2})/);
    const sec = m ? Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
    const url = doc.url || "";
    location.replace(sec && /panopto/i.test(url) ? `${url}${url.includes("?") ? "&" : "?"}start=${sec}` : url);
    return;
  }
  const file = doc.file || {};
  const isPdf = /pdf/i.test(file.type || "") || /\.pdf$/i.test(file.name || "");
  if (isPdf) {
    try {
      const res = await fetch(file.url, { credentials: "include" });
      if (!res.ok) throw new Error(`Canvas said ${res.status}`);
      pdf = await pdfjs.getDocument({ data: new Uint8Array(await res.arrayBuffer()), isEvalSupported: false }).promise;
      total = pdf.numPages;
    } catch (e) { pdf = null; useText(doc, `Couldn't load the file (${e.message}). Showing its text instead.`); }
  } else useText(doc);
  page = Math.min(page, total);
  await draw();
}

function useText(doc, warn = "") {
  const text = doc.analysis?.text || "";
  const parts = text.split(/--- (?:Page|Slide|Sheet) \d+ ---\n/).slice(1);
  textPages = parts.length ? parts : [text];
  total = textPages.length;
  if (warn) $("#sub").textContent = warn;
}

async function draw() {
  $("#pos").textContent = `Slide ${page} of ${total}`;
  $("#prev").disabled = page <= 1; $("#next").disabled = page >= total;
  const stage = $("#stage");
  if (pdf) {
    const p = await pdf.getPage(page);
    const width = Math.min(1100, stage.clientWidth - 32);
    const v1 = p.getViewport({ scale: 1 });
    const scale = (width / v1.width) * (window.devicePixelRatio || 1);
    const vp = p.getViewport({ scale });
    const c = document.createElement("canvas");
    c.width = vp.width; c.height = vp.height;
    c.style.width = `${vp.width / (window.devicePixelRatio || 1)}px`;
    c.setAttribute("role", "img"); c.setAttribute("aria-label", `Slide ${page}`);
    await p.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    stage.replaceChildren(c);
  } else {
    const d = document.createElement("div"); d.className = "textslide";
    d.textContent = (textPages[page - 1] || "").trim() || "(No text on this slide.)";
    stage.replaceChildren(d);
  }
  history.replaceState(null, "", `?${new URLSearchParams({ ...Object.fromEntries(P), page })}`);
  $("#stage").focus({ preventScroll: true });
}
// A JupyterHub notebook: every cell in order (code, outputs, plots), scrolled to the cell the question is about.
let nbCells = null;
function showNotebook(doc) {
  const a = $("#canvas"); a.href = doc.url; a.textContent = "Open in JupyterHub"; a.hidden = !doc.url;
  const lead = $("#note b"); if (lead) lead.textContent = "This cell explains: ";
  const figs = new Map((doc.figures || []).map((f) => [f.name, f.url]));
  const text = String(doc.text || "").split("\n--- Data files used ---\n")[0];
  const parts = text.split(/--- Cell (\d+) ---\n/);
  nbCells = new Map();
  const list = document.createElement("div"); list.className = "nb";
  for (let i = 1; i < parts.length; i += 2) {
    const n = Number(parts[i]);
    const cell = document.createElement("section"); cell.className = "nb-cell"; cell.id = `cell-${n}`;
    const head = document.createElement("div"); head.className = "nb-n"; head.textContent = `Cell ${n}`;
    const body = document.createElement("div"); body.className = "nb-body";
    // Plots: the figure markers become the pictures themselves.
    for (const chunk of (parts[i + 1] || "").split(/(\[Figure: "[^"]+" \(attached\)\])/)) {
      const m = chunk.match(/^\[Figure: "([^"]+)" \(attached\)\]$/);
      if (m && figs.has(m[1])) { const img = document.createElement("img"); img.src = figs.get(m[1]); img.alt = `Plot from cell ${n}`; body.append(img); }
      else if (chunk.trim()) {
        // Markdown headings become headings; everything else goes through the usual text/code/math renderer.
        for (const piece of chunk.trim().split(/^(#{1,6} [^\n]+)$/m)) {
          const hd = piece.match(/^#{1,6} (.+)$/);
          if (hd) body.append(Object.assign(document.createElement("div"), { className: "nb-h", textContent: hd[1] }));
          else if (piece.trim()) body.append(rich(piece.trim()));
        }
      }
    }
    cell.append(head, body);
    list.append(cell);
    nbCells.set(n, cell);
  }
  total = Math.max(...nbCells.keys(), 1);
  $("#stage").replaceChildren(list);
  drawCell();
}
function drawCell() {
  const ns = [...nbCells.keys()].sort((x, y) => x - y);
  if (!nbCells.has(page)) page = ns.find((n) => n >= page) || ns[ns.length - 1] || 1;
  $("#pos").textContent = `Cell ${page} of ${total}`;
  $("#prev").disabled = page <= ns[0]; $("#next").disabled = page >= ns[ns.length - 1];
  for (const [n, el] of nbCells) el.classList.toggle("here", n === page);
  nbCells.get(page)?.scrollIntoView({ block: "start", behavior: "smooth" });
  history.replaceState(null, "", `?${new URLSearchParams({ ...Object.fromEntries(P), page })}`);
}
const stepCell = (dir) => { const ns = [...nbCells.keys()].sort((x, y) => x - y); const i = ns.indexOf(page); const n = ns[i + dir]; if (n != null) { page = n; drawCell(); } };

function fail(msg) { $("#title").textContent = "Couldn't open the lecture"; $("#stage").replaceChildren(Object.assign(document.createElement("p"), { className: "error", textContent: msg })); }

$("#prev").onclick = () => { if (nbCells) return stepCell(-1); if (page > 1) { page--; draw(); } };
$("#next").onclick = () => { if (nbCells) return stepCell(1); if (page < total) { page++; draw(); } };
document.addEventListener("keydown", (e) => {
  if (nbCells) { if (e.key === "ArrowLeft") stepCell(-1); if (e.key === "ArrowRight") stepCell(1); return; }
  if (e.key === "ArrowLeft" && page > 1) { page--; draw(); }
  if (e.key === "ArrowRight" && page < total) { page++; draw(); }
});
let rt = null;
window.addEventListener("resize", () => { if (nbCells) return; clearTimeout(rt); rt = setTimeout(() => draw(), 150); });
main().catch((e) => fail(e.message));
