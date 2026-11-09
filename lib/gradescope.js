// Gradescope: read the student's own courses, assignments and submitted work through their normal
// Gradescope login (a background tab on gradescope.com, same-origin requests). No password or token is
// stored. Read-only: only GET requests, and only submissions that already exist are opened. Assignments
// with no submission are never opened, because opening a timed assignment can start its timer.
import { waitFor, run, pageChunk, pageFree } from "./jupyterhub.js";

export const GS = "https://www.gradescope.com";
export const GS_ORIGINS = [`${GS}/*`];
export const hasGsPermission = () => chrome.permissions.contains({ origins: GS_ORIGINS }).catch(() => false);

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

async function withGs(fn) {
  if (!(await hasGsPermission())) throw Object.assign(new Error("Connect Gradescope first (Courses › Files or Settings › Connections)."), { code: "permission" });
  const existing = (await chrome.tabs.query({ url: `${GS}/*` }))[0];
  let tabId, created = false;
  if (existing) tabId = existing.id;
  else {
    const t = await chrome.tabs.create({ url: `${GS}/robots.txt`, active: false });
    tabId = t.id; created = true;
    await waitFor(tabId, () => true, 45e3).catch(() => {});
  }
  try { return await fn(tabId); }
  finally { if (created) chrome.tabs.remove(tabId).catch(() => {}); }
}

// ---------- injected into gradescope.com (self-contained) ----------
async function pageCourses() {
  const r = await fetch("/account", { credentials: "same-origin" });
  const html = await r.text();
  if (!/\/account/.test(r.url) || /name="session\[email\]"|id="login-form"/i.test(html) && !/courseBox/.test(html)) return { login: true };
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out = [];
  for (const a of doc.querySelectorAll("a[href^='/courses/']")) {
    const m = a.getAttribute("href").match(/^\/courses\/(\d+)\/?$/);
    if (!m || out.some((c) => c.id === m[1])) continue;
    const short = (a.querySelector(".courseBox--shortname")?.textContent || a.querySelector("h3,h4")?.textContent || a.textContent || "").trim().replace(/\s+/g, " ");
    const name = (a.querySelector(".courseBox--name")?.textContent || "").trim().replace(/\s+/g, " ");
    const termEl = a.closest(".courseList--coursesForTerm")?.previousElementSibling;
    out.push({ id: m[1], short, name, term: (termEl?.textContent || "").trim() });
  }
  return { courses: out };
}

async function pageAssignments(courseId) {
  const r = await fetch(`/courses/${courseId}`, { credentials: "same-origin" });
  if (!r.ok) return { error: r.status };
  const doc = new DOMParser().parseFromString(await r.text(), "text/html");
  const title = (doc.querySelector(".courseHeader--title, h1")?.textContent || "").trim();
  const rows = doc.querySelectorAll("#assignments-student-table tbody tr, table.table tbody tr");
  const list = [];
  for (const row of rows) {
    const head = row.querySelector("th") || row.cells[0];
    if (!head) continue;
    const name = head.textContent.trim().replace(/\s+/g, " ");
    // Only links to an existing submission count; buttons (upload dialogs) and links to unsubmitted assignments are ignored.
    const link = head.querySelector("a[href*='/submissions/']")?.getAttribute("href") || null;
    const cells = [...row.querySelectorAll("td")].map((td) => td.textContent.trim().replace(/\s+/g, " "));
    const statusText = (row.querySelector(".submissionStatus--text")?.textContent || cells[0] || "").trim();
    const score = (row.querySelector(".submissionStatus--score")?.textContent || (cells[0]?.match(/\d+(\.\d+)?\s*\/\s*\d+(\.\d+)?/) || [""])[0]).trim();
    if (name) list.push({ name, submissionPath: link, status: score ? "Graded" : statusText || (link ? "Submitted" : "No Submission"), score });
  }
  return { title, assignments: list };
}

// Finds the download links on a submission page: "Download Graded Copy" (PDF with marks and comments)
// and "Download Submission" (what was turned in). Falls back to links embedded in the page's data.
async function pageSubmissionFiles(path) {
  const r = await fetch(path, { credentials: "same-origin" });
  if (!r.ok) return { error: r.status };
  const html = await r.text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  const found = [];
  const add = (href, label) => {
    if (!href) return;
    const url = new URL(href.replace(/&amp;/g, "&"), location.origin).href;
    if (!found.some((f) => f.url === url)) found.push({ url, label: (label || "").trim().replace(/\s+/g, " ") });
  };
  for (const a of doc.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href"), text = a.textContent || "";
    if (/download/i.test(text) || /\.pdf(\?|$)|zip_download|\/download(\?|$)/.test(href)) add(href, text);
  }
  for (const m of html.matchAll(/"((?:\\\/|\/)courses\/\d+\/assignments\/\d+\/submissions\/\d+[^"]*?(?:\.pdf|zip_download|download)[^"]*)"/g)) add(m[1].replace(/\\\//g, "/"), "");
  const base = path.replace(/[?#].*$/, "").replace(/\/$/, "");
  // "Download Graded Copy" is the submission's address + ".pdf" (e.g. /courses/1/assignments/2/submissions/3.pdf)
  const graded = found.find((f) => /graded/i.test(f.label)) || found.find((f) => f.url.split("?")[0].endsWith(`${base}.pdf`))
    || (/\/submissions\/\d+$/.test(base) && !/online|programming|autograder/i.test(doc.body?.className || "") ? { url: new URL(`${base}.pdf`, location.origin).href, label: "graded copy (direct)" } : null);
  const original = found.find((f) => f !== graded && /submission|original/i.test(f.label)) || found.find((f) => f !== graded && /zip_download|\/download/.test(f.url));
  return { graded: graded || null, original: original || null, all: found };
}

async function pageLoad(url) {
  let r;
  // A cross-site redirect (files kept on cloud storage) can't be followed from the page; the caller then fetches it directly.
  try { r = await fetch(url, { credentials: "same-origin" }); } catch { return { error: "redirect" }; }
  if (!r.ok) return { error: r.status };
  const type = r.headers.get("content-type") || "";
  if (/text\/html/.test(type)) return { error: "not a file" };
  // Before grading, ".pdf" answers with the submission's details (JSON) instead of a file;
  // the PDF that was turned in is linked inside it (pdf_attachment.url, on Gradescope's file storage).
  if (/json/.test(type)) {
    const j = await r.json().catch(() => null);
    const att = j?.pdf_attachment;
    if (att?.url) return { follow: att.url, fname: att.filename || "", ready: j.pdf_ready !== false };
    return { error: j?.pdf_ready === false ? "Gradescope is still preparing this PDF; try again later" : "no file in Gradescope's answer" };
  }
  const disp = r.headers.get("content-disposition") || "";
  const fname = decodeURIComponent((disp.match(/filename\*=UTF-8''([^;]+)/i) || disp.match(/filename="?([^";]+)"?/i) || [])[1] || "");
  globalThis.__spBlob = await r.blob();
  return { size: globalThis.__spBlob.size, type, fname };
}

// ---------- operations ----------
export async function status() {
  return withGs(async (tabId) => {
    const r = await run(tabId, pageCourses);
    return r.login ? { state: "login" } : { state: "ok", courses: r.courses };
  });
}

export const openLogin = () => chrome.tabs.create({ url: `${GS}/login`, active: true });

export async function assignments(gsCourseId) {
  return withGs(async (tabId) => {
    const r = await run(tabId, pageAssignments, [gsCourseId]);
    if (r.error) throw new Error(r.error === 401 || r.error === 403 ? "Gradescope wants you to log in again." : `Gradescope answered ${r.error}.`);
    return r;
  });
}

// ---------- "turned in on Gradescope" (Canvas often shows nothing until it's graded) ----------
// "Homework 3" / "HW3" / "hw 3 - due Friday" all become "hw 3".
export const workKey = (s) => norm(s).replace(/\bhomework\b/g, "hw").replace(/\bproblem set\b|\bpset\b/g, "ps")
  .replace(/\bassignment\b/g, "a").replace(/\blab(oratory)?\b/g, "lab").replace(/([a-z])(\d)/g, "$1 $2").replace(/\s+/g, " ").trim();
export const turnedIn = (list) => (list || []).filter((a) => a.submissionPath || /^(submitted|graded)/i.test(a.status || "")).map((a) => workKey(a.name));
export function matchesTurnedIn(name, keys) {
  const k = workKey(name);
  if (!k || !keys?.length) return false;
  const nums = (s) => (s.match(/\d+/g) || []).join(",");
  return keys.some((g) => g === k || ((g.startsWith(k + " ") || k.startsWith(g + " ")) && nums(g.split(" ").slice(0, 3).join(" ")) === nums(k.split(" ").slice(0, 3).join(" "))));
}
// Mark Canvas assignments turned in on Gradescope as submitted (Canvas usually has no submission until grades are posted).
export function applyTurnedIn(snapshot, gsSubmitted = {}) {
  for (const c of snapshot?.courses || []) {
    const keys = gsSubmitted[c.id]?.keys;
    if (!keys?.length) continue;
    for (const a of c.assignments) {
      if (a.submitted) continue;
      // "HW3" = "Homework 3" = "hw 3 (due Fri)", but never "HW 30"
      const hit = matchesTurnedIn(a.name, keys);
      if (hit) { a.submitted = true; a.submitted_via = "Gradescope"; a.missing = false; }
    }
  }
  return snapshot;
}

// Items you marked done yourself ("Mark done" in the to-do lists): settings.doneItems { "courseId:assignmentId": at }.
export function applyMarked(snapshot, doneItems = {}) {
  for (const c of snapshot?.courses || []) for (const a of c.assignments) {
    const marked = !!doneItems[`${c.id}:${a.id}`];
    if (marked && !a.submitted) { a.submitted = true; a.submitted_via = "marked"; a.missing = false; }
    else if (!marked && a.submitted_via === "marked") { a.submitted = false; delete a.submitted_via; }
  }
  return snapshot;
}

// Match Canvas courses to Gradescope courses by course code or name ("BIO 101 F26").
export function matchCourse(canvasCourse, gsCourses) {
  const code = norm(canvasCourse.code), name = norm(canvasCourse.name);
  return gsCourses.find((g) => norm(g.short) === code || norm(g.name) === name)
    || gsCourses.find((g) => code && (norm(g.short).startsWith(code) || code.startsWith(norm(g.short))))
    || gsCourses.find((g) => name && norm(g.name) && (name.includes(norm(g.name)) || norm(g.name).includes(name)))
    || null;
}

const safe = (s) => String(s || "file").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "").slice(0, 90) || "file";
const extFor = (type, url, fname) => (fname.match(/\.[a-z0-9]{1,6}$/i)?.[0])
  || (/pdf/.test(type) ? ".pdf" : /zip/.test(type) ? ".zip" : (url.split("?")[0].match(/\.[a-z0-9]{1,6}$/i)?.[0]) || "");

/**
 * Streams the student's Gradescope work for one course into a zip being built (addChunk/commit from the caller).
 * prefix: folder inside the zip ("" or "<course>/My submissions/Gradescope"). Graded copies when available,
 * otherwise what was turned in. Returns { added, failed: [{path,error}], skipped: [names without a submission] }.
 */
export async function streamCourse(gsCourseId, { prefix = "", addChunk, commit, addUrl = null, onProgress = () => {} }) {
  const CHUNK = 8 * 1024 * 1024;
  return withGs(async (tabId) => {
    const r = await run(tabId, pageAssignments, [gsCourseId]);
    if (r.error) throw new Error(`Gradescope answered ${r.error}.`);
    const submitted = r.assignments.filter((a) => a.submissionPath);
    const failed = [], skipped = r.assignments.filter((a) => !a.submissionPath).map((a) => a.name);
    let added = 0;
    for (let i = 0; i < submitted.length; i++) {
      const a = submitted[i];
      await onProgress(i, submitted.length, a.name);
      const dir = [prefix, safe(a.name)].filter(Boolean).join("/");
      try {
        const links = await run(tabId, pageSubmissionFiles, [a.submissionPath]);
        if (links.error) throw new Error(`Gradescope answered ${links.error}`);
        const picks = [];
        const isGraded = a.status === "Graded" || !!a.score;
        if (links.graded) picks.push({ ...links.graded, as: isGraded ? "graded" : "submission", direct: /direct/.test(links.graded.label) });
        // The graded copy already contains the pages you turned in; add the original only for code/zip submissions.
        if (links.original && (!links.graded || /zip|code|program/i.test(`${links.original.url} ${links.original.label}`))) picks.push({ ...links.original, as: "submission" });
        if (!picks.length) {
          // No download buttons (online assignments): save a link to the graded page instead.
          const p = `${dir}/Open on Gradescope.url`;
          await addChunk(p, btoa(`[InternetShortcut]\r\nURL=${GS}${a.submissionPath}\r\n`));
          await commit(p);
          added++;
          continue;
        }
        for (const pick of picks) {
          let info = await run(tabId, pageLoad, [pick.url]);
          // Follow the file link from a JSON answer (ungraded submissions); if the page can't fetch it, fetch it directly.
          if (info?.follow) {
            const fname = info.fname;
            const next = await run(tabId, pageLoad, [info.follow]);
            if (next?.error === "redirect" || next?.error) {
              if (!addUrl) throw new Error("couldn't download the submitted file");
              await addUrl(`${dir}/${safe(a.name)} (${pick.as})${extFor("", info.follow, fname) || ".pdf"}`, info.follow);
              added++;
              continue;
            }
            info = { ...next, fname: next.fname || fname };
          }
          // The direct graded-copy address doesn't exist for every assignment type: fall back to the original.
          if (info?.error && pick.direct && links.original && !picks.some((x) => x.url === links.original.url)) { picks.push({ ...links.original, as: "submission" }); continue; }
          if (info?.error === "redirect" && addUrl) {
            await addUrl(`${dir}/${safe(a.name)} (${pick.as})${extFor("", pick.url, "") || ".pdf"}`, pick.url);
            added++;
            continue;
          }
          if (info?.error) throw new Error(info.error === "not a file" ? "download link didn't return a file" : `Gradescope answered ${info.error}`);
          const p = `${dir}/${safe(a.name)} (${pick.as})${extFor(info.type, pick.url, info.fname)}`;
          for (let off = 0; off < info.size || off === 0; off += CHUNK) {
            await addChunk(p, await run(tabId, pageChunk, [off, Math.min(info.size, off + CHUNK)]));
            if (info.size === 0) break;
          }
          await commit(p);
          await run(tabId, pageFree).catch(() => {});
          added++;
        }
      } catch (e) {
        failed.push({ path: `${dir}`, error: e.message });
      }
    }
    return { added, failed, skipped, title: r.title };
  });
}

// For tests
export const _page = { pageCourses, pageAssignments, pageSubmissionFiles, pageLoad };
