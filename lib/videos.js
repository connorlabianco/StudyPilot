// Lecture videos → transcripts, so recorded lectures work like slides (practice, flashcards, study guides).
// Two sources:
//  1. Canvas's own media (videos uploaded into Canvas pages): captions through the Canvas API.
//  2. Panopto (often under a school-specific name): the student's own Panopto login, in a background tab,
//     lists the recordings they can watch and reads their captions. Read-only.
// Recordings without captions can't be turned into text here; they're listed as "no captions".
import { waitFor, run } from "./jupyterhub.js";

// ---------- captions → text ----------
export function captionsToText(raw) {
  const lines = String(raw || "").replace(/\r/g, "").split("\n");
  const out = []; // [{ t: text, at: seconds }]
  let last = "", at = null;
  for (const l of lines) {
    const t = l.trim();
    const cue = t.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,]\d+\s*-->/);
    if (cue) { at = Number(cue[1] || 0) * 3600 + Number(cue[2]) * 60 + Number(cue[3]); continue; }
    if (!t || /^WEBVTT/.test(t) || /^\d+$/.test(t) || /-->/.test(t) || /^(NOTE|STYLE|REGION)\b/.test(t)) continue;
    const clean = t.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (clean && clean !== last) out.push({ t: clean, at });
    last = clean;
  }
  // Join caption fragments into readable paragraphs (~every 8 lines), each starting with its time, like [12:34].
  const stamp = (s) => s == null ? "" : `[${s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}` : Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}] `;
  const paras = [];
  for (let i = 0; i < out.length; i += 8) paras.push(stamp(out[i].at) + out.slice(i, i + 8).map((x) => x.t).join(" "));
  return paras.join("\n\n");
}

// ---------- Canvas media inside a page ----------
// <iframe src="/media_objects_iframe/m-abc123">, data-media-id="m-abc", media_comment_m-abc, /media_attachments_iframe/123
export function canvasMediaIn(html) {
  const ids = new Set(), attachments = new Set();
  for (const m of String(html || "").matchAll(/media_objects_iframe\/(m-[\w]+)|data-media-id="(m-[\w]+)"|media_comment_(m-[\w]+)/g)) ids.add(m[1] || m[2] || m[3]);
  for (const m of String(html || "").matchAll(/media_attachments_iframe\/(\d+)/g)) attachments.add(m[1]);
  return { mediaIds: [...ids].slice(0, 10), attachmentIds: [...attachments].slice(0, 10) };
}

// ---------- Panopto ----------
export const PANOPTO_LINK = /https?:\/\/([a-z0-9.-]*panopto\.(?:com|eu|ca|com\.au))\/Panopto\/Pages\/(?:Embed|Viewer)\.aspx\?[^"'\s<>]*?\bid=([0-9a-f-]{36})/gi;
export function panoptoLinksIn(html) {
  const out = [];
  for (const m of String(html || "").matchAll(PANOPTO_LINK)) if (!out.some((x) => x.id === m[2])) out.push({ host: m[1].toLowerCase(), id: m[2] });
  return out;
}
export const normalizeHost = (input) => {
  let s = String(input || "").trim();
  if (!s) return "";
  if (!/^https?:/.test(s)) s = "https://" + s;
  return new URL(s).host.toLowerCase();
};
export const panoptoOrigins = (host) => [`https://${host}/*`];

async function withPanopto(host, fn) {
  const origin = `https://${host}`;
  if (!(await chrome.permissions.contains({ origins: panoptoOrigins(host) }).catch(() => false))) throw new Error("Connect your video site first (Settings › Connections › Lecture videos).");
  const existing = (await chrome.tabs.query({ url: `${origin}/*` }))[0];
  let tabId, created = false;
  if (existing) tabId = existing.id;
  else {
    const t = await chrome.tabs.create({ url: `${origin}/Panopto/Pages/Home.aspx`, active: false });
    tabId = t.id; created = true;
    await waitFor(tabId, () => true, 45e3).catch(() => {});
  }
  try { return await fn(tabId); }
  finally { if (created) chrome.tabs.remove(tabId).catch(() => {}); }
}

// Injected into the Panopto site
async function pageSessions(maxPages) {
  const all = [];
  for (let page = 0; page < maxPages; page++) {
    const r = await fetch("/Panopto/Services/Data.svc/GetSessions", {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ queryParameters: { query: null, sortColumn: 1, sortAscending: false, maxResults: 100, page, startDate: null, endDate: null,
        folderID: null, bookmarked: false, getFolderData: true, isSharedWithMe: false, isSubscriptionsPage: false, includeArchived: true,
        includeArchivedStateCount: true, sessionListOnlyArchived: false, includePlaylists: false } }),
    }).catch(() => null);
    if (!r) return { error: "network" };
    if (r.status === 401 || r.status === 403 || /login/i.test(r.url)) return { login: true };
    const j = await r.json().catch(() => null);
    if (!j?.d) return page === 0 ? { login: true } : { sessions: all };
    const list = j.d.Results || [];
    for (const s of list) {
      const ms = Number(String(s.StartTime || "").match(/\d+/)?.[0]) || null;
      all.push({ id: s.DeliveryID, title: s.SessionName, folder: s.FolderName, folderId: s.FolderID, date: ms ? new Date(ms).toISOString() : null,
        minutes: s.Duration ? Math.round(s.Duration / 60) : null, url: s.ViewerUrl || `/Panopto/Pages/Viewer.aspx?id=${s.DeliveryID}` });
    }
    if (list.length < 100 || all.length >= (j.d.TotalNumber || 0)) break;
  }
  return { sessions: all };
}

async function pageCaptions(ids) {
  const out = {};
  for (const id of ids) {
    const r = await fetch(`/Panopto/Pages/Transcription/GenerateSRT.ashx?id=${id}&language=0`, { credentials: "same-origin" }).catch(() => null);
    const text = r && r.ok ? await r.text() : "";
    out[id] = /-->/.test(text) ? text : "";
  }
  return out;
}

export async function panoptoSessions(host) {
  return withPanopto(host, async (tabId) => {
    const r = await run(tabId, pageSessions, [10]);
    if (r.login) return { state: "login" };
    if (r.error) throw new Error("Couldn't reach your video site.");
    return { state: "ok", sessions: r.sessions };
  });
}
export async function panoptoCaptions(host, ids) {
  return withPanopto(host, (tabId) => run(tabId, pageCaptions, [ids]));
}
export const openPanoptoLogin = (host) => chrome.tabs.create({ url: `https://${host}/Panopto/Pages/Auth/Login.aspx`, active: true });

// Which Panopto folder belongs to a Canvas course (folders are usually named after the course).
export function matchFolder(course, folders) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const code = norm(course.code), name = norm(course.name);
  const num = (course.code || "").match(/[A-Z]{2,}\s*\d+[A-Z]?/i)?.[0];
  return folders.find((f) => norm(f.name) === code || norm(f.name) === name)
    || folders.find((f) => code && norm(f.name).includes(code))
    || folders.find((f) => name && (norm(f.name).includes(name) || name.includes(norm(f.name))))
    || (num ? folders.find((f) => norm(f.name).includes(norm(num))) : null)
    || null;
}

// ---------- downloads (only when the instructor allows them) ----------
export const podcastUrl = (host, id) => `https://${host}/Panopto/Podcast/Download/${id}.mp4?mediaTargetType=videoPodcast`;
async function pageCanDownloadAll(ids) {
  const out = {};
  for (const id of ids) {
    try {
      const r = await fetch(`/Panopto/Podcast/Download/${id}.mp4?mediaTargetType=videoPodcast`, { method: "HEAD", credentials: "same-origin", redirect: "manual" });
      out[id] = r.type === "opaqueredirect" || (r.ok && /video|audio|octet-stream/.test(r.headers.get("content-type") || ""));
    } catch { out[id] = false; }
  }
  return out;
}
// Which recordings the instructor allows to be downloaded: { id: true/false }
export async function panoptoDownloadable(host, ids) {
  return withPanopto(host, (tabId) => run(tabId, pageCanDownloadAll, [ids]));
}
