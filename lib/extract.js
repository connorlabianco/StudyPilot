// Reads lecture files and works out, page by page, what's text and what's visual
// (diagrams, photos, handwritten or scanned pages). Works in the extension's offscreen page and in Node tests.
import { listZip, readEntry } from "./unzip.js";

// Page classification thresholds
const NO_TEXT = 25;          // fewer characters than this = scanned / handwritten / image-only
const FIGURE_PATHS = 120;    // many vector drawing operations = a drawn diagram or chart
const TEXT_WITH_FIGURE = 500; // a figure on a page with little text means the figure carries the content

// Kinds: "text", "text+figure", "figure" (diagram/photo/chart carries the content),
// "notext" (no typed text at all: handwriting, a scan or a photo), "blank".
function classify({ chars, images, paths }) {
  if (chars === 0) return images > 0 || paths > 20 ? "notext" : "blank";
  if (chars < NO_TEXT) return images > 0 || paths > 20 ? "figure" : "text";
  const figure = images > 0 || paths > FIGURE_PATHS;
  if (figure && chars < TEXT_WITH_FIGURE) return "figure";
  return figure ? "text+figure" : "text";
}

const firstLine = (t) => (t.split(/\n/).map((s) => s.trim()).find((s) => s.length > 2) || "").slice(0, 90);

// ---------- Boilerplate (course headers, "Page 14", footers) ----------
// A deck where every page only says "BIO 101 Fall Page 14" over a picture has no real text: those pages are visual.
const normLine = (l) => l.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
const PAGE_ONLY = /^(?:(?:page|slide|p\.?)\s*)?#+(?:\s*(?:of|\/)\s*#+)?$/;
const MEANINGFUL = 25; // characters of real text below which a page counts as having no typed text

/** pages: [{ n, text, kind, ... }] → same pages with boilerplate removed from text and kinds corrected */
export function stripBoilerplate(pages) {
  const seen = new Map();
  pages.forEach((p) => new Set(String(p.text || "").split("\n").map(normLine).filter(Boolean)).forEach((l) => seen.set(l, (seen.get(l) || 0) + 1)));
  const minRepeat = Math.max(3, Math.ceil(pages.length * 0.6));
  // Headers and footers are short and on most pages; a slide title repeated across one section isn't.
  const boiler = (l) => { const k = normLine(l); return !k || PAGE_ONLY.test(k) || (pages.length >= 3 && k.length <= 60 && (seen.get(k) || 0) >= minRepeat); };
  return pages.map((p) => {
    const lines = String(p.text || "").split("\n").map((l) => l.trim()).filter((l) => l && !boiler(l));
    const text = lines.join("\n");
    const chars = text.replace(/\s/g, "").length;
    let kind = p.kind;
    const pictured = ["figure", "text+figure", "notext"].includes(p.kind) || (p.images || 0) > 0;
    if (chars < MEANINGFUL) kind = pictured ? "notext" : "blank";
    return { ...p, text, chars, kind, title: lines.find((l) => l.length > 2)?.slice(0, 90) || "" };
  });
}

// Older library entries were saved before boilerplate was removed: fix them when they're read.
export function refineAnalysis(a) {
  if (!a || a.refined || !a.pages?.length || !a.text) return a;
  const unit = a.unit || "Page";
  const texts = new Map();
  const re = new RegExp(`--- ${unit} (\\d+) ---\\n([\\s\\S]*?)(?=\\n\\n--- ${unit} \\d+ ---|$)`, "g");
  for (const m of a.text.matchAll(re)) texts.set(Number(m[1]), m[2]);
  const pages = stripBoilerplate(a.pages.map((p) => ({ ...p, text: texts.get(p.n) || "" })));
  const { format, error, unreadable, notes } = a;
  return summarize(pages, { unit, format, ...(error ? { error } : {}), ...(unreadable ? { unreadable } : {}), ...(notes ? { notes } : {}), _skipStrip: true });
}

function summarize(rawPages, extra = {}) {
  const { _skipStrip, ...rest } = extra;
  extra = rest;
  const pages = _skipStrip ? rawPages : stripBoilerplate(rawPages);
  const visualKinds = new Set(["notext", "figure", "text+figure"]);
  const visual = pages.filter((p) => visualKinds.has(p.kind)).map((p) => p.n);
  const noText = pages.filter((p) => p.kind === "notext").map((p) => p.n);
  const text = pages.map((p) => (p.text ? `--- ${extra.unit || "Page"} ${p.n} ---\n${p.text}` : "")).filter(Boolean).join("\n\n");
  return {
    pageCount: pages.length,
    unit: extra.unit || "Page",
    pages: pages.map(({ n, chars, kind, title }) => ({ n, chars, kind, title })),
    visualPages: visual,
    noTextPages: noText,
    scanned: pages.length > 0 && noText.length / pages.length > 0.5,
    visual: visual.length > 0,
    text,
    contentChars: pages.reduce((n, p) => n + (p.chars || 0), 0),
    // Too little typed text to work from: the AI must see the file itself.
    needsFile: pages.length > 0 && (noText.length / pages.length > 0.3 || pages.reduce((n, p) => n + (p.chars || 0), 0) < 60 * Math.min(pages.length, 10)),
    refined: true,
    ...extra,
  };
}

// ---------- PDF ----------
export async function analyzePdf(buf, pdfjs) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false }).promise;
  const OPS = pdfjs.OPS;
  const imageOps = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintImageXObjectRepeat, OPS.paintInlineImageXObjectGroup].filter((x) => x != null));
  const pathOps = new Set([OPS.constructPath, OPS.fill, OPS.stroke, OPS.eoFill].filter((x) => x != null));
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const tc = await page.getTextContent();
    let text = "";
    for (const it of tc.items) text += (it.str || "") + (it.hasEOL ? "\n" : " ");
    text = text.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
    let images = 0, paths = 0;
    try {
      const ops = await page.getOperatorList();
      for (const fn of ops.fnArray) { if (imageOps.has(fn)) images++; else if (pathOps.has(fn)) paths++; }
    } catch { /* operator list is best-effort */ }
    const chars = text.replace(/\s/g, "").length;
    pages.push({ n, text, chars, images, paths, kind: classify({ chars, images, paths }), title: firstLine(text) });
    page.cleanup();
  }
  await doc.destroy();
  return summarize(pages, { format: "pdf", unit: "Page" });
}

// ---------- PowerPoint (.pptx) ----------
const xmlText = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, "g"))].map((m) => decodeXml(m[1]));
const decodeXml = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export async function analyzePptx(buf) {
  const zip = listZip(buf);
  const slideNames = [...zip.entries.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]));
  const pages = [];
  for (const name of slideNames) {
    const n = Number(name.match(/(\d+)\.xml$/)[1]);
    const xml = await readEntry(zip, name);
    // Paragraph-aware text: join runs inside <a:p>, one line per paragraph
    const paras = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map((m) => xmlText(m[1], "a:t").join("")).filter((s) => s.trim());
    let text = paras.join("\n");
    const notesXml = await readEntry(zip, `ppt/notesSlides/notesSlide${n}.xml`);
    const notes = notesXml ? xmlText(notesXml, "a:t").join(" ").replace(/\s+/g, " ").trim() : "";
    if (notes && !/^\d+$/.test(notes)) text += `\n[Speaker notes] ${notes}`;
    const images = (xml.match(/<p:pic>/g) || []).length + (xml.match(/<a:blip\b/g) || []).length / 2;
    const graphics = (xml.match(/<c:chart\b|<dgm:|<p:graphicFrame>/g) || []).length;
    const shapes = (xml.match(/<a:custGeom>|<p:cxnSp>/g) || []).length;
    const chars = paras.join("").replace(/\s/g, "").length;
    pages.push({ n, text, chars, images: Math.ceil(images) + graphics, paths: shapes * 30, kind: classify({ chars, images: Math.ceil(images) + graphics, paths: shapes * 30 }), title: firstLine(text) });
  }
  return summarize(pages, { format: "pptx", unit: "Slide" });
}

// ---------- Word (.docx) ----------
export async function analyzeDocx(buf) {
  const zip = listZip(buf);
  const xml = await readEntry(zip, "word/document.xml");
  if (!xml) throw new Error("Not a Word document");
  const paras = [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((m) => xmlText(m[0], "w:t").join("")).filter((s) => s.trim());
  const text = paras.join("\n");
  const images = (xml.match(/<w:drawing>|<w:pict>/g) || []).length;
  const chars = text.replace(/\s/g, "").length;
  // Treat the whole document as one "page" for classification purposes
  const page = { n: 1, text, chars, images, paths: 0, kind: classify({ chars, images, paths: 0 }), title: firstLine(text) };
  const res = summarize([page], { format: "docx", unit: "Document" });
  res.figures = images;
  return res;
}

// ---------- dispatcher ----------
export function formatOf(name = "", mime = "") {
  const n = name.toLowerCase();
  if (mime === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if (n.endsWith(".pptx") || /presentationml/.test(mime)) return "pptx";
  if (n.endsWith(".docx") || /wordprocessingml/.test(mime)) return "docx";
  if (/^image\//.test(mime) || /\.(png|jpe?g|gif|webp|heic)$/.test(n)) return "image";
  if (/^text\//.test(mime) || /\.(txt|md|csv|tsv|py|r|tex|qmd|rmd|ipynb|sql|java|c|cpp|h|js|ts|m|jl|json|sas|do|stan)$/.test(n)) return "text";
  return "other";
}

export async function analyzeFile(buf, { name, mime }, pdfjs) {
  const fmt = formatOf(name, mime);
  if (fmt === "pdf") return analyzePdf(buf, pdfjs);
  if (fmt === "pptx") return analyzePptx(buf);
  if (fmt === "docx") return analyzeDocx(buf);
  if (fmt === "image") return { format: "image", pageCount: 1, unit: "Image", pages: [{ n: 1, chars: 0, kind: "notext" }], visualPages: [1], noTextPages: [1], scanned: true, visual: true, text: "" };
  if (fmt === "text") {
    const text = new TextDecoder().decode(buf).slice(0, 500000);
    return { format: "text", pageCount: 1, unit: "File", pages: [{ n: 1, chars: text.length, kind: "text" }], visualPages: [], noTextPages: [], scanned: false, visual: false, text };
  }
  return { format: "other", pageCount: 0, unit: "File", pages: [], visualPages: [], noTextPages: [], scanned: false, visual: false, text: "", unreadable: true };
}
