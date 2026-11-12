import { QUIZ_RULES } from "./packs.js";

// JupyterHub / Jupyter server helpers. Pure functions (testable in Node).

// Folders and files never worth exporting.
const SKIP_NAMES = new Set([".ipynb_checkpoints", "__pycache__", "node_modules", ".git", ".cache", ".local", ".config", ".jupyter", ".ipython", "venv", ".venv", "env", "lost+found"]);
export const TEXT_EXT = /\.(ipynb|py|r|R|jl|md|txt|tex|csv|tsv|json|ya?ml|sql|sh|java|c|cpp|h|js|ts|html)$/;
export const NOTEBOOKISH = /\.(ipynb|py|r|R|jl|md|txt|tex)$/;

export function isSkipped(name) {
  return name.startsWith(".") || SKIP_NAMES.has(name);
}

// "Course 2/Lab 1.ipynb" → "Course%202/Lab%201.ipynb" (keep slashes)
export const encodePath = (p) => p.split("/").map(encodeURIComponent).join("/");

// Normalize what the user typed into a hub base URL (origin + optional prefix, no trailing slash).
// Accepts links into the hub like https://datahub.x.edu/hub/home or https://school.edu/jupyter/user/<name>/lab
export function normalizeHubUrl(input) {
  const u = new URL(input.trim());
  let path = u.pathname.replace(/\/+$/, "");
  const cut = path.search(/\/(hub|user|lab|tree|notebooks|git-pull)(\/|$)/);
  if (cut >= 0) path = path.slice(0, cut);
  return u.origin + path;
}

export function isGitPullLink(url, hubBase) {
  try {
    const u = new URL(url), hub = new URL(hubBase);
    return u.host === hub.host && /git-pull/.test(u.pathname + u.search) && /repo=/.test(u.search);
  } catch { return false; }
}

// The hub a Jupyter link points to: a nbgitpuller link (…/hub/user-redirect/git-pull?repo=…) or any link into a hub.
export function hubFromLink(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return null;
    const isPull = /git-pull/.test(u.pathname + u.search) && /repo=/.test(u.search);
    const isHub = /\/(hub\/(login|home|spawn|user-redirect)|user\/[^/]+\/(lab|tree|notebooks))(\/|$)/.test(u.pathname);
    return isPull || isHub ? normalizeHubUrl(url) : null;
  } catch { return null; }
}

// Every hub the student connected: one per course, plus the older single setting.
export function knownHubs(s) {
  const out = new Set(Object.values(s.jupyterHubs || {}).filter((h) => h && h !== "none"));
  if (s.jupyterUrl) out.add(s.jupyterUrl);
  return [...out];
}

// This course's hub ("" = not set yet, "none" = the course doesn't use Jupyter).
export function hubForCourse(s, courseId) {
  const h = (s.jupyterHubs || {})[courseId];
  if (h) return h;
  // Older setup: one hub for everything, used by the courses that already had folders picked.
  return s.jupyterUrl && (s.jupyterCourseFolders || {})[courseId]?.length ? s.jupyterUrl : "";
}

// Group scanned files by top-level folder for the picker.
export function groupByTopFolder(files) {
  const groups = new Map();
  for (const f of files) {
    const top = f.path.includes("/") ? f.path.split("/")[0] : "(home folder)";
    if (!groups.has(top)) groups.set(top, { name: top, files: 0, notebooks: 0, bytes: 0, unknownSize: 0, latest: null });
    const g = groups.get(top);
    g.files++;
    if (/\.ipynb$/.test(f.path)) g.notebooks++;
    if (f.size == null) g.unknownSize++; else g.bytes += f.size;
    if (f.last_modified && (!g.latest || f.last_modified > g.latest)) g.latest = f.last_modified;
  }
  return [...groups.values()].sort((a, b) => (b.latest || "").localeCompare(a.latest || ""));
}

export function filesInGroups(files, groupNames, { onlyText = false } = {}) {
  const set = new Set(groupNames);
  return files.filter((f) => {
    const top = f.path.includes("/") ? f.path.split("/")[0] : "(home folder)";
    return set.has(top) && (!onlyText || TEXT_EXT.test(f.path));
  });
}

// Notebook JSON → readable Markdown for an AI. Keeps markdown + code, short text outputs, notes images.
// figure(cellNo, outputNo, mime, data) → a file name to reference, or null to just say "[image output]".
export function nbToMarkdown(nb, { maxOutput = 1500, figure = null } = {}) {
  const lang = nb?.metadata?.kernelspec?.language || nb?.metadata?.language_info?.name || "python";
  const src = (s) => (Array.isArray(s) ? s.join("") : s || "");
  const parts = [];
  let cellNo = 0;
  for (const cell of nb?.cells || []) {
    cellNo++;
    const text = src(cell.source).trim();
    if (cell.cell_type === "markdown") { if (text) parts.push(text); continue; }
    if (cell.cell_type === "raw") { if (text) parts.push("```\n" + text + "\n```"); continue; }
    if (cell.cell_type !== "code") continue;
    if (text) parts.push("```" + lang + "\n" + text + "\n```");
    const outs = [];
    let outNo = 0;
    for (const o of cell.outputs || []) {
      outNo++;
      if (o.output_type === "stream") outs.push(src(o.text));
      else if (o.output_type === "error") outs.push(`${o.ename}: ${o.evalue}`);
      else if (o.data) {
        if (o.data["text/plain"]) outs.push(src(o.data["text/plain"]));
        const mime = ["image/png", "image/jpeg", "image/svg+xml"].find((m) => o.data[m]);
        if (mime) {
          const name = figure ? figure(cellNo, outNo, mime, src(o.data[mime])) : null;
          outs.push(name ? `[Figure: "${name}" (attached)]` : "[image output]");
        }
      }
    }
    const out = outs.join("\n").trim();
    if (out) parts.push("Output:\n```\n" + (out.length > maxOutput ? out.slice(0, maxOutput) + "\n… (truncated)" : out) + "\n```");
  }
  return parts.join("\n\n");
}

const GOALS = {
  study: "These are my course notebooks from JupyterHub. Summarize what each one covers, the key concepts and techniques, then ask what I want to focus on. Explain code clearly and check my understanding.",
  quiz: "Quiz me on these course notebooks. Mix concept questions with \"what does this code do / what would it output\" questions (always include the code in the question).\n\n" + QUIZ_RULES,
  context: "These are my course notebooks from JupyterHub. Keep them as context and answer my questions about them, citing the notebook and section.",
};

export function notebooksPack(docs, { goal = "study", hub = "", update = false, figures = 0 } = {}) {
  const label = (d) => (update && d.status ? (d.status === "new" ? " (New)" : " (Updated)") : "");
  const body = docs.map((d) => `# ${d.path}${label(d)}${d.last_modified ? `\n_Last saved ${new Date(d.last_modified).toLocaleString()}_` : ""}\n\n${d.text}`).join("\n\n---\n\n");
  const intro = (update ? "This is an **update**: only notebooks that are new or changed since I last shared them. Updated ones replace the earlier version.\n\n" : "")
    + (figures ? `I've attached ${figures} plot/figure image${figures === 1 ? "" : "s"} from the notebook outputs; each is referenced where it appears as [Figure: "name"]. Look at them when they matter.\n\n` : "");
  return `# Course notebooks${update ? " (update)" : ""}\n_Exported from ${hub || "JupyterHub"} by StudyPilot_\n\n## What I want\n${intro}${GOALS[goal] || GOALS.study}\nFor graded assignments, help me understand and debug, but let me write the solutions myself.\n\n${body}`;
}

// ---------- notebooks as lectures ----------
// A notebook's text with "--- Cell N ---" markers (like slides), so checklists, coverage checks and links work by cell.
export function nbCellsText(nb, { maxOutput = 1500, figure = null } = {}) {
  const lang = nb?.metadata?.kernelspec?.language || nb?.metadata?.language_info?.name || "python";
  const src = (s) => (Array.isArray(s) ? s.join("") : s || "");
  const parts = [];
  let n = 0;
  for (const cell of nb?.cells || []) {
    n++;
    const text = src(cell.source).trim();
    const bits = [];
    if (cell.cell_type === "markdown") { if (text) bits.push(text); }
    else if (cell.cell_type === "raw") { if (text) bits.push("```\n" + text + "\n```"); }
    else if (cell.cell_type === "code") {
      if (text) bits.push("```" + lang + "\n" + text + "\n```");
      const outs = [], pics = [];
      let k = 0;
      for (const o of cell.outputs || []) {
        k++;
        if (o.output_type === "stream") outs.push(src(o.text));
        else if (o.output_type === "error") outs.push(`${o.ename}: ${o.evalue}`);
        else if (o.data) {
          const mime = ["image/png", "image/jpeg"].find((m) => o.data[m]);
          // A plot's text/plain is only "<Figure size ...>": the picture stands in for it.
          if (mime) { const name = figure ? figure(n, k, mime, src(o.data[mime])) : null; pics.push(name ? `[Figure: "${name}" (attached)]` : "[figure]"); }
          else if (o.data["text/plain"]) outs.push(src(o.data["text/plain"]));
        }
      }
      const out = outs.join("\n").trim();
      if (out) bits.push("Output:\n```\n" + (out.length > maxOutput ? out.slice(0, maxOutput) + "\n… (truncated)" : out) + "\n```");
      if (pics.length) bits.push((out ? "" : "Output:\n") + pics.join("\n"));
    }
    if (bits.length) parts.push(`--- Cell ${n} ---\n${bits.join("\n\n")}`);
  }
  return { text: parts.join("\n\n"), cells: n };
}

// The problem text of a homework notebook: its markdown cells only (the questions). The student's own code
// and outputs are never included.
export function nbProblemText(nb, { max = 20000 } = {}) {
  const src = (s) => (Array.isArray(s) ? s.join("") : s || "");
  const md = (nb?.cells || []).filter((c) => c.cell_type === "markdown").map((c) => src(c.source).trim()).filter(Boolean);
  const code = (nb?.cells || []).filter((c) => c.cell_type === "code").length;
  return `${md.join("\n\n").slice(0, max)}\n\n(${code} code cells for the answers; not included.)`;
}

const DATA_EXT = /\.(csv|tsv|txt|json|geojson|xlsx?|parquet|feather|npy|npz|pkl|pickle|h5|hdf5|zip|gz|dta|sav|rds|rdata)$/i;
export const isDataFile = (p) => DATA_EXT.test(p);
const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
function joinPath(dir, rel) {
  const out = dir ? dir.split("/") : [];
  for (const seg of rel.replace(/^\.\//, "").split("/")) { if (seg === "..") out.pop(); else if (seg && seg !== ".") out.push(seg); }
  return out.join("/");
}
/**
 * The data files a notebook uses: paths in its code that point at files in the hub (relative to the notebook,
 * or by file name), plus data files right next to it. Capped so a lecture stays small.
 */
export function notebookData(nb, nbPath, files, { max = 8 } = {}) {
  const src = (s) => (Array.isArray(s) ? s.join("") : s || "");
  const code = (nb?.cells || []).filter((c) => c.cell_type === "code").map((c) => src(c.source)).join("\n");
  const all = files.filter((f) => isDataFile(f.path));
  const byPath = new Map(all.map((f) => [f.path, f]));
  const dir = dirOf(nbPath);
  const out = [];
  const add = (f) => { if (f && !out.includes(f) && out.length < max) out.push(f); };
  for (const m of code.matchAll(/["'`]([^"'`\n]{1,200}\.(?:csv|tsv|txt|json|geojson|xlsx?|parquet|feather|npy|npz|pkl|pickle|h5|hdf5|zip|gz|dta|sav|rds|rdata))["'`]/gi)) {
    const rel = m[1].replace(/^~\//, "");
    add(byPath.get(joinPath(dir, rel)) || byPath.get(rel) || all.find((f) => f.path.endsWith("/" + rel.split("/").pop())));
  }
  for (const f of all) if (dirOf(f.path) === dir || dirOf(f.path) === joinPath(dir, "data")) add(f);
  return out;
}

/** A short description of a data file from its first few kilobytes: columns, a guess at their types, sample rows. */
export function summarizeData(file, head = "") {
  const name = file.path.split("/").pop();
  const size = file.size ? (file.size > 1e6 ? `${(file.size / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(file.size / 1e3))} KB`) : "";
  const label = `${file.path}${size ? ` (${size})` : ""}`;
  if (/\.(csv|tsv|txt)$/i.test(name) && head) {
    const lines = head.split(/\r?\n/).filter(Boolean);
    if (head.length >= 4000 && lines.length > 1) lines.pop(); // the last line may be cut off
    const sep = /\.tsv$/i.test(name) || (lines[0] || "").split("\t").length > (lines[0] || "").split(",").length ? "\t" : ",";
    const split = (l) => l.split(sep).map((x) => x.trim().replace(/^"(.*)"$/, "$1"));
    const header = split(lines[0] || "");
    const rows = lines.slice(1, 6).map(split);
    if (header.length > 1) {
      const type = (i) => { const v = lines.slice(1, 40).map((l) => split(l)[i]).filter((x) => x != null && x !== ""); return !v.length ? "?" : v.every((x) => /^-?\d+(\.\d+)?(e-?\d+)?$/i.test(x)) ? "number" : v.every((x) => /^\d{4}-\d{2}-\d{2}/.test(x)) ? "date" : "text"; };
      const est = file.size && head.length ? Math.round((file.size / head.length) * Math.max(1, lines.length - 1)) : null;
      return [`${label}: about ${est ? est.toLocaleString("en-US") : "?"} rows, columns: ${header.map((c, i) => `${c} (${type(i)})`).join(", ")}`,
        "First rows:", "```", [header, ...rows].map((r) => r.join(sep === "\t" ? "\t" : ", ")).join("\n"), "```"].join("\n");
    }
  }
  if (/\.(json|geojson)$/i.test(name) && head) {
    const keys = [...new Set([...head.matchAll(/"([A-Za-z_][\w ]{0,40})"\s*:/g)].map((m) => m[1]))].slice(0, 25);
    return `${label}: JSON${keys.length ? `, fields include: ${keys.join(", ")}` : ""}`;
  }
  return `${label}: a data file (contents not read)`;
}

// Folder kinds for a course's hub: lecture material is quizzed; assignments only help the study plan; skip is ignored.
export function guessKind(dir) {
  const d = dir.toLowerCase();
  if (/(^|[\/_\-\s])(hw|homework|assignments?|labs?|projects?|exams?|midterms?|finals?|quiz(zes)?|psets?|problem.?sets?|solutions?)(\d|[\/_\-\s]|$)/.test(d)) return "assignment";
  if (/(^|[\/_\-\s])(lec(ture)?s?|notes|demos?|slides|examples|class|week|module|chapter|ch|section|discussion|sec)(\d|[\/_\-\s]|$)/.test(d)) return "lecture";
  if (/(^|\/)(\.|_)|checkpoints|__pycache__|scratch|tmp|old|archive/.test(d)) return "skip";
  return "lecture";
}
/** Notebook folders for the course's picked top-level folders: { dir: { notebooks, kind } }. */
export function notebookDirs(files, folders, kinds = {}) {
  const out = {};
  for (const f of files) {
    if (!/\.ipynb$/i.test(f.path) || /\.ipynb_checkpoints\//.test(f.path)) continue;
    if (!folders.some((t) => f.path === t || f.path.startsWith(t + "/"))) continue;
    const dir = dirOf(f.path) || "(top)";
    (out[dir] ||= { notebooks: [], kind: kinds[dir] || guessKind(dir === "(top)" ? f.path : dir) }).notebooks.push(f);
  }
  return out;
}
export const prettyNotebook = (p) => p.split("/").pop().replace(/\.ipynb$/i, "").replace(/[_-]+/g, " ").replace(/\b(lec|lecture)\s*0*(\d+)/i, "Lecture $2").replace(/\s+/g, " ").trim();
