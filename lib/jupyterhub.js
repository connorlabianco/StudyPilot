// Talks to JupyterHub through a tab on the hub, so requests use the student's own logged-in session
// (same-origin, with Jupyter's XSRF cookie). No API token is ever needed or stored.
import { encodePath } from "./jupyter.js";

// ---------- tab plumbing ----------
export function waitFor(tabId, test, timeoutMs) {
  return new Promise((resolve, reject) => {
    const done = (fn, v) => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); fn(v); };
    const check = (tab) => { if (tab && tab.status === "complete" && test(tab.url || "")) done(resolve, tab); };
    const listener = (id, _info, tab) => { if (id === tabId) check(tab); };
    const timer = setTimeout(() => chrome.tabs.get(tabId).then((t) => done(reject, Object.assign(new Error("timeout"), { url: t.url }))).catch(() => done(reject, new Error("tab closed"))), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(check).catch(() => done(reject, new Error("tab closed")));
  });
}

export async function navigate(tabId, url, test = () => true, timeoutMs = 60e3) {
  await chrome.tabs.update(tabId, { url });
  await new Promise((r) => setTimeout(r, 300)); // let the navigation start
  return waitFor(tabId, test, timeoutMs);
}

export async function run(tabId, func, args = []) {
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return result;
}

// Opens (or reuses) a background tab on the hub for one operation, and closes it afterwards if we opened it.
export async function withHub(hubBase, fn) {
  const origin = new URL(hubBase).origin;
  if (!(await chrome.permissions.contains({ origins: [origin + "/*"] }))) {
    throw new Error("StudyPilot needs permission for your JupyterHub. Connect it again in the Notebooks tab.");
  }
  const existing = (await chrome.tabs.query({ url: origin + "/*" })).find((t) => (t.url || "").startsWith(hubBase));
  let tabId, created = false;
  if (existing) tabId = existing.id;
  else {
    const t = await chrome.tabs.create({ url: hubBase + "/hub/home", active: false });
    tabId = t.id; created = true;
    await waitFor(tabId, () => true, 60e3).catch(() => {});
  }
  const ctx = { tabId, hubBase, origin, created, keepOpen: false };
  try { return await fn(ctx); }
  finally { if (created && !ctx.keepOpen) chrome.tabs.remove(tabId).catch(() => {}); }
}

// ---------- functions injected into the hub page (must be self-contained) ----------
function pageFetchJson(url) {
  const m = document.cookie.match(/(?:^|;\s*)_xsrf=([^;]+)/);
  const headers = { Accept: "application/json" };
  if (m) headers["X-XSRFToken"] = decodeURIComponent(m[1]);
  return fetch(url, { headers, credentials: "same-origin" }).then(async (r) => ({ status: r.status, body: r.ok ? await r.json().catch(() => null) : null }));
}

async function pageList(serverBase, maxFiles) {
  const SKIP = new Set([".ipynb_checkpoints", "__pycache__", "node_modules", ".git", ".cache", ".local", ".config", ".jupyter", ".ipython", "venv", ".venv", "env", "lost+found"]);
  const m = document.cookie.match(/(?:^|;\s*)_xsrf=([^;]+)/);
  const headers = { Accept: "application/json" };
  if (m) headers["X-XSRFToken"] = decodeURIComponent(m[1]);
  const enc = (p) => p.split("/").map(encodeURIComponent).join("/");
  const files = [], queue = [""];
  let dirs = 0;
  while (queue.length && files.length < maxFiles && dirs < 2000) {
    const path = queue.shift(); dirs++;
    const r = await fetch(`${serverBase}/api/contents/${enc(path)}?content=1`, { headers, credentials: "same-origin" });
    if (!r.ok) { if (path === "") return { error: r.status }; continue; }
    const body = await r.json();
    for (const item of body.content || []) {
      if (item.name.startsWith(".") || SKIP.has(item.name)) continue;
      if (item.type === "directory") queue.push(item.path);
      else files.push({ path: item.path, size: item.size ?? null, type: item.type, last_modified: item.last_modified });
    }
  }
  return { files, truncated: files.length >= maxFiles };
}

async function pageRead(serverBase, paths, maxChars) {
  const m = document.cookie.match(/(?:^|;\s*)_xsrf=([^;]+)/);
  const headers = { Accept: "application/json" };
  if (m) headers["X-XSRFToken"] = decodeURIComponent(m[1]);
  const enc = (p) => p.split("/").map(encodeURIComponent).join("/");
  const out = [];
  let total = 0;
  for (const p of paths) {
    if (total > maxChars) { out.push({ path: p, skipped: "size limit" }); continue; }
    const isNb = /\.ipynb$/.test(p);
    const r = await fetch(`${serverBase}/api/contents/${enc(p)}?content=1&type=${isNb ? "notebook" : "file"}${isNb ? "" : "&format=text"}`, { headers, credentials: "same-origin" });
    if (!r.ok) { out.push({ path: p, skipped: `error ${r.status}` }); continue; }
    const body = await r.json();
    const content = isNb ? body.content : String(body.content || "");
    total += isNb ? JSON.stringify(content).length / 3 : content.length;
    out.push({ path: p, notebook: isNb, content, last_modified: body.last_modified });
  }
  return out;
}

// ---------- operations ----------
const isLogin = (url, hubBase) => !url.startsWith(new URL(hubBase).origin) || /\/hub\/(login|oauth_login)/.test(url);

export async function status(hubBase) {
  return withHub(hubBase, async (ctx) => {
    let tab = await chrome.tabs.get(ctx.tabId);
    if (!tab.url.startsWith(hubBase + "/hub")) tab = await navigate(ctx.tabId, hubBase + "/hub/home").catch(() => tab);
    if (isLogin(tab.url, hubBase)) return { state: "login" };

    const r = await run(ctx.tabId, pageFetchJson, [hubBase + "/hub/api/user"]);
    if (r.status === 200 && r.body) {
      const server = r.body.server ? ctx.origin + r.body.server.replace(/\/$/, "") : null;
      return { state: server ? "running" : "stopped", name: r.body.name, serverBase: server || `${hubBase}/user/${encodeURIComponent(r.body.name)}` };
    }
    if (r.status === 401 || r.status === 403) return { state: "login" };
    // Not a hub: maybe a single Jupyter server at this address.
    const s = await run(ctx.tabId, pageFetchJson, [hubBase + "/api/status"]);
    if (s.status === 200) return { state: "running", name: null, serverBase: hubBase, singleServer: true };
    return { state: "unknown", error: `Hub answered ${r.status}` };
  });
}

// Opens the login page in a visible tab for the student.
export async function openLogin(hubBase) {
  await chrome.tabs.create({ url: hubBase + "/hub/login", active: true });
}

export async function startServer(hubBase) {
  return withHub(hubBase, async (ctx) => {
    try {
      await navigate(ctx.tabId, hubBase + "/hub/spawn", (u) => /\/user\/[^/]+\//.test(u) && !/spawn-pending/.test(u), 180e3);
      return { started: true };
    } catch (e) {
      // Hubs with a "choose your environment" form need the student to click Start.
      ctx.keepOpen = true;
      await chrome.tabs.update(ctx.tabId, { active: true });
      return { started: false, needsUser: true };
    }
  });
}

// nbgitpuller links pull the latest course materials into the student's server.
// nbgitpuller merges carefully and keeps the student's own changes.
export async function pullLatest(hubBase, links, onProgress = () => {}) {
  return withHub(hubBase, async (ctx) => {
    const results = [];
    for (let i = 0; i < links.length; i++) {
      onProgress(i, links.length);
      try {
        const tab = await navigate(ctx.tabId, links[i], (u) => /\/user\/[^/]+\//.test(u) && !/git-pull/.test(u), 240e3);
        results.push({ link: links[i], ok: true, landed: tab.url });
      } catch (e) {
        results.push({ link: links[i], ok: false, error: /timeout/.test(e.message) ? "took too long (open the link yourself to see what happened)" : e.message });
      }
    }
    return results;
  });
}

// The Jupyter XSRF cookie lives under the server's path, so run file operations from a page there.
async function toServerPage(ctx, serverBase) {
  const tab = await chrome.tabs.get(ctx.tabId);
  if (tab.url.startsWith(serverBase + "/")) return;
  await navigate(ctx.tabId, serverBase + "/tree", (u) => u.startsWith(serverBase) || isLogin(u, ctx.hubBase), 120e3);
}

export async function scan(hubBase, serverBase, maxFiles = 4000) {
  return withHub(hubBase, async (ctx) => {
    await toServerPage(ctx, serverBase);
    const res = await run(ctx.tabId, pageList, [serverBase, maxFiles]);
    if (res?.error) throw new Error(res.error === 403 || res.error === 401 ? "Jupyter wouldn't share your files. Make sure you're logged in and your server is running." : `Jupyter returned ${res.error}.`);
    return res;
  });
}

export async function readFiles(hubBase, serverBase, paths, maxChars = 1_500_000) {
  return withHub(hubBase, async (ctx) => {
    await toServerPage(ctx, serverBase);
    return run(ctx.tabId, pageRead, [serverBase, paths, maxChars]);
  });
}

// The first few kilobytes of each file (data previews). The download stops there, so big datasets aren't fetched whole.
async function pageHeads(serverBase, paths, bytes) {
  const enc = (p) => p.split("/").map(encodeURIComponent).join("/");
  const out = {};
  for (const p of paths) {
    try {
      const r = await fetch(`${serverBase}/files/${enc(p)}`, { credentials: "same-origin" });
      if (!r.ok || !r.body) { out[p] = ""; continue; }
      const reader = r.body.getReader();
      const chunks = []; let got = 0;
      while (got < bytes) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; }
      reader.cancel().catch(() => {});
      const all = new Uint8Array(Math.min(got, bytes)); let o = 0;
      for (const c of chunks) { const take = Math.min(c.length, all.length - o); all.set(c.subarray(0, take), o); o += take; if (o >= all.length) break; }
      out[p] = new TextDecoder("utf-8", { fatal: false }).decode(all);
    } catch { out[p] = ""; }
  }
  return out;
}
export async function readHeads(hubBase, serverBase, paths, bytes = 4096) {
  if (!paths.length) return {};
  return withHub(hubBase, async (ctx) => {
    await toServerPage(ctx, serverBase);
    return run(ctx.tabId, pageHeads, [serverBase, paths, bytes]);
  });
}

// ---------- reading file bytes for zips (through the hub tab, in chunks) ----------
async function pageLoadFile(url) {
  const m = document.cookie.match(/(?:^|;\s*)_xsrf=([^;]+)/);
  const headers = m ? { "X-XSRFToken": decodeURIComponent(m[1]) } : {};
  const r = await fetch(url, { headers, credentials: "same-origin" });
  if (!r.ok) return { error: r.status };
  globalThis.__spBlob = await r.blob();
  return { size: globalThis.__spBlob.size };
}

export async function pageChunk(start, end) {
  const buf = new Uint8Array(await globalThis.__spBlob.slice(start, end).arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(s);
}

export function pageFree() { globalThis.__spBlob = null; return true; }

// addChunk(path, b64) / commit(path) are provided by the caller (they forward to the zip builder).
export async function streamFiles(hubBase, serverBase, paths, { addChunk, commit, onProgress = () => {}, maxBytes = 1e9 }) {
  const CHUNK = 8 * 1024 * 1024;
  return withHub(hubBase, async (ctx) => {
    await toServerPage(ctx, serverBase);
    const failed = [];
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      await onProgress(i, paths.length);
      try {
        const info = await run(ctx.tabId, pageLoadFile, [fileUrl(serverBase, p)]);
        if (info?.error) throw new Error(`Jupyter returned ${info.error}`);
        if (info.size > maxBytes) throw new Error("larger than 1 GB");
        for (let off = 0; off < info.size || (off === 0 && info.size === 0); off += CHUNK) {
          await addChunk(p, await run(ctx.tabId, pageChunk, [off, Math.min(info.size, off + CHUNK)]));
          if (info.size === 0) break;
        }
        await commit(p);
      } catch (e) {
        failed.push({ path: p, error: e.message });
      } finally {
        await run(ctx.tabId, pageFree).catch(() => {});
      }
    }
    return { failed };
  });
}

export const fileUrl = (serverBase, path) => `${serverBase}/files/${encodePath(path)}?download=1`;
