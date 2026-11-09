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
