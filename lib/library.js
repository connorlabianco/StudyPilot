// The lecture library: what StudyPilot has read from each lecture (text, slide guide, which pages are visual).
// Stored in the extension's own IndexedDB (shared by the background, side panel and offscreen page).
// Original files are not stored here; they're downloaded fresh into the bundle you hand to your AI.

import { refineAnalysis } from "./extract.js";

const DB = "studypilot-library", VERSION = 1;
let dbp = null;

function db() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("docs")) {
        const s = d.createObjectStore("docs", { keyPath: "key" });
        s.createIndex("course", "course_id");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

const tx = async (mode, fn) => {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction("docs", mode);
    const out = fn(t.objectStore("docs"));
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
  });
};

const refineDoc = (d) => (d?.analysis ? { ...d, analysis: refineAnalysis(d.analysis), visual: d.visual || !!refineAnalysis(d.analysis)?.visual } : d);
export const getDoc = async (key) => refineDoc(await tx("readonly", (s) => s.get(key)));
export const putDoc = (doc) => tx("readwrite", (s) => { s.put({ ...doc, saved_at: Date.now() }); });
export const deleteDoc = (key) => tx("readwrite", (s) => { s.delete(key); });
export const clearLibrary = () => tx("readwrite", (s) => { s.clear(); });

export async function docsForCourse(courseId) {
  return (await tx("readonly", (s) => s.index("course").getAll(courseId))).map(refineDoc);
}

export async function libraryStats() {
  const all = await tx("readonly", (s) => s.getAll());
  const by = {};
  for (const d of all) {
    const c = (by[d.course_id] ??= { docs: 0, visual: 0, noText: 0, chars: 0, last: 0 });
    c.docs++;
    if (d.visual) c.visual++;
    if (d.analysis?.noTextPages?.length) c.noText++;
    c.chars += (d.text || d.analysis?.text || "").length;
    c.last = Math.max(c.last, d.saved_at || 0);
  }
  return { total: all.length, byCourse: by };
}
