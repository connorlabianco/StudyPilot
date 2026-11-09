// Canvas LMS REST API client. Read-only: GET requests only.
// Auth: your logged-in browser session by default; optional personal access token.
import { BLOCKED_ITEM_TYPES, isBlockedAssignment, isLocked, safeAssignmentContent, assignmentKind } from "./safety.js";

export class CanvasClient {
  constructor({ baseUrl, token }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token || null;
  }

  async get(path, params = {}, { all = true, maxPages = 20 } = {}) {
    const url = new URL(this.baseUrl + "/api/v1" + path);
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
      else if (v != null) url.searchParams.set(k, v);
    }
    if (all && !url.searchParams.has("per_page")) url.searchParams.set("per_page", "100");

    let out = [], next = url.toString(), pages = 0;
    while (next && pages < maxPages) {
      const res = await fetch(next, {
        method: "GET",
        headers: { Accept: "application/json", ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
        credentials: this.token ? "omit" : "include",
      });
      if (res.status === 401) throw new CanvasError(401, "Not signed in to Canvas. Open Canvas in a tab and log in, then try again.");
      if (!res.ok) throw new CanvasError(res.status, `Canvas returned ${res.status} for ${path}`);
      const body = await res.json();
      if (!Array.isArray(body)) return body;
      out = out.concat(body);
      next = all ? parseNextLink(res.headers.get("Link")) : null;
      pages++;
    }
    return out;
  }

  // Many course areas are hidden for students; treat 401/403/404 as "not available" rather than errors.
  async optional(path, params, opts) {
    try { return await this.get(path, params, opts); }
    catch (e) { if (e instanceof CanvasError && [401, 403, 404].includes(e.status)) return null; throw e; }
  }

  self() { return this.get("/users/self", {}, { all: false }); }

  courses() {
    return this.get("/courses", { enrollment_state: "active", "include[]": ["term", "total_scores", "course_image"] });
  }

  course(id) { return this.get(`/courses/${id}`, { "include[]": ["syllabus_body", "term"] }, { all: false }); }

  assignments(courseId) {
    return this.get(`/courses/${courseId}/assignments`, { "include[]": ["submission"], order_by: "due_at" });
  }

  modules(courseId) { return this.optional(`/courses/${courseId}/modules`, { "include[]": ["items", "content_details"] }); }
  pagesList(courseId) { return this.optional(`/courses/${courseId}/pages`, { published: true }); }
  page(courseId, url) { return this.optional(`/courses/${courseId}/pages/${encodeURIComponent(url)}`, {}, { all: false }); }
  discussions(courseId) { return this.optional(`/courses/${courseId}/discussion_topics`, {}); }
  files(courseId) { return this.optional(`/courses/${courseId}/files`, {}); }
  folders(courseId) { return this.optional(`/courses/${courseId}/folders`, {}); }
  file(fileId) { return this.optional(`/files/${fileId}`, {}, { all: false }); }

  // Assignment groups with weights and the student's own scores (for the grade calculator).
  async gradeData(courseId) {
    const [course, groups] = await Promise.all([
      this.get(`/courses/${courseId}`, { "include[]": ["syllabus_body", "total_scores"] }, { all: false }),
      this.get(`/courses/${courseId}/assignment_groups`, { "include[]": ["assignments", "submission"] }).catch(() => []),
    ]);
    return {
      weighted: !!course.apply_assignment_group_weights,
      current_score: course.enrollments?.[0]?.computed_current_score ?? null,
      syllabus: stripHtml(course.syllabus_body || "").slice(0, 60000),
      syllabusHtml: course.syllabus_body || "",
      groups: (groups || []).map((g) => ({
        name: g.name, weight: g.group_weight || 0, drop_lowest: g.rules?.drop_lowest || 0,
        assignments: (g.assignments || []).filter((a) => a.published !== false).map((a) => ({
          name: a.name, points: a.points_possible || 0, omit: !!a.omit_from_final_grade,
          score: a.submission?.score ?? null, excused: !!a.submission?.excused,
          graded: a.submission?.score != null && a.submission?.workflow_state === "graded",
        })),
      })),
    };
  }

  // Where a course keeps its grading breakdown, in the order to try: files and pages linked from the Syllabus tab,
  // then syllabus files/pages in modules (by title, or anything in a "Syllabus" / "Start here" module), then search.
  // Files an instructor hides from the Files list but links in a page or module are fine to read (that's how they're
  // shared); only items locked for the student are skipped. Returns { sources, notes } (notes: what was skipped and why).
  async syllabusSources(courseId, syllabusHtml = "") {
    const out = [], notes = [], seenFiles = new Set(), seenPages = new Set();
    const getFile = async (id) => (await this.optional(`/courses/${courseId}/files/${id}`, {}, { all: false }).catch(() => null))
      || (await this.optional(`/files/${id}`, {}, { all: false }).catch(() => null));
    const addFile = (f, via, label = "") => {
      if (!f) { if (label) notes.push({ name: label, error: "not available to students" }); return; }
      if (seenFiles.has(f.id)) return;
      seenFiles.add(f.id);
      if (f.locked_for_user) { notes.push({ name: f.display_name, error: "locked" }); return; }
      if (!/pdf|word|officedocument|msword|text\/plain|rtf/i.test(f["content-type"] || "") && !/\.(pdf|docx?|txt|rtf)$/i.test(f.display_name || "")) return;
      out.push({ kind: "file", name: f.display_name, via, file: { id: f.id, name: f.display_name, url: f.url, size: f.size, type: f["content-type"] || "" } });
    };
    const addPage = async (url, via) => {
      if (!url || seenPages.has(url)) return;
      seenPages.add(url);
      const p = await this.optional(`/courses/${courseId}/pages/${encodeURIComponent(url)}`, {}, { all: false }).catch(() => null);
      if (!p) return;
      if (p.locked_for_user) { notes.push({ name: p.title, error: "locked" }); return; }
      if (p.body) out.push({ kind: "page", name: p.title, via, text: stripHtml(p.body) });
    };

    // 1. Linked from the Syllabus tab (file links look like /courses/1/files/2, /files/2 or data-api-endpoint=".../files/2")
    const fileIds = [...new Set([...syllabusHtml.matchAll(/\/files\/(\d+)/g)].map((m) => Number(m[1])))].slice(0, 8);
    for (const id of fileIds) addFile(await getFile(id), "linked from the Syllabus page", `File ${id} on the Syllabus page`);
    for (const m of [...syllabusHtml.matchAll(/\/courses\/\d+\/pages\/([\w%.-]+)/g)].slice(0, 4)) await addPage(decodeURIComponent(m[1]), "linked from the Syllabus page");

    // 2. Modules: items titled like a syllabus, or files/pages inside a syllabus-type module
    const ITEM = /syllab|grading|course (info|information|policies|outline|overview)|course guide/i;
    const MODULE = /syllab|start here|getting started|course (info|information|overview|materials|resources)|welcome|orientation|week 0|introduction/i;
    const modules = await this.optional(`/courses/${courseId}/modules`, { "include[]": "items", per_page: 50 }).catch(() => null);
    for (const m of modules || []) {
      let items = m.items;
      if (!items && m.items_url) items = await this.optional(`/courses/${courseId}/modules/${m.id}/items`, { per_page: 100 }).catch(() => null);
      const inSyllabusModule = MODULE.test(m.name || "");
      for (const i of (items || []).slice(0, 60)) {
        if (!ITEM.test(i.title || "") && !(inSyllabusModule && ["File", "Page"].includes(i.type))) continue;
        if (i.content_details?.locked_for_user) { notes.push({ name: i.title, error: "locked" }); continue; }
        if (i.type === "Page") await addPage(i.page_url, `in the module “${m.name}”`);
        if (i.type === "File") addFile(await getFile(i.content_id), `in the module “${m.name}”`, i.title);
      }
    }

    // 3. Search Pages and Files (often hidden from students; that's fine)
    const pages = await this.optional(`/courses/${courseId}/pages`, { search_term: "syllab", per_page: 10 }).catch(() => null);
    for (const p of pages || []) await addPage(p.url, "in Pages");
    const files = await this.optional(`/courses/${courseId}/files`, { search_term: "syllab", per_page: 10 }).catch(() => null);
    for (const f of files || []) addFile(f, "in Files");
    return { sources: out, notes };
  }

  // Canvas's end_date defaults to start_date + 28 days, so always ask up to now
  // (otherwise a 120-day window only returns announcements from 3–4 months ago).
  announcements(courseIds, days = 21) {
    return this.get("/announcements", {
      "context_codes[]": courseIds.map((id) => `course_${id}`),
      start_date: new Date(Date.now() - days * 864e5).toISOString(),
      end_date: new Date(Date.now() + 864e5).toISOString(),
    });
  }

  // ---------- Light snapshot: drives the side panel, dashboard widgets and plans ----------
  // onlyFavorites: use the student's starred courses. Canvas returns their dashboard courses
  // from the same endpoint when nothing is starred, which is exactly the fallback we want.
  async snapshot({ onlyFavorites = true } = {}) {
    let courses = (await this.courses()).filter((c) => c.name && !c.access_restricted_by_date);
    let course_source = "all";
    if (onlyFavorites) {
      const fav = await this.get("/users/self/favorites/courses", {}).catch(() => null);
      const ids = new Set((fav || []).map((f) => f.id));
      const picked = courses.filter((c) => ids.has(c.id));
      if (picked.length) { courses = picked; course_source = "favorites"; }
    }
    const perCourse = await Promise.all(courses.map(async (c) => {
      const assignments = await this.assignments(c.id).catch(() => []);
      return {
        id: c.id,
        name: c.name,
        code: c.course_code,
        term: c.term?.name || "",
        image: c.image_download_url || null,
        current_score: c.enrollments?.[0]?.computed_current_score ?? null,
        current_grade: c.enrollments?.[0]?.computed_current_grade ?? null,
        assignments: assignments.map((a) => ({
          id: a.id,
          name: a.name,
          due_at: a.due_at,
          points: a.points_possible,
          types: a.submission_types,
          is_quiz: assignmentKind(a).kind === "quiz",
          blocked: isBlockedAssignment(a),
          kind: assignmentKind(a).kind,
          kind_label: assignmentKind(a).label,
          // Instructions text from the assignment itself (never from a quiz or tool page), so the AI can size the work.
          details: assignmentKind(a).kind === "quiz" ? "" : stripHtml(a.description || "").slice(0, 900),
          graded: a.submission?.score != null && a.submission?.workflow_state === "graded",
          graded_at: a.submission?.graded_at || null,
          grade: a.submission?.grade ?? null,
          excused: !!a.submission?.excused,
          locked: isLocked(a),
          submitted: !!a.submission?.submitted_at,
          missing: !!a.submission?.missing,
          late: !!a.submission?.late,
          score: a.submission?.score ?? null,
          url: a.html_url,
        })),
      };
    }));
    const announcements = await this.announcements(courses.map((c) => c.id), 21).catch(() => []);
    const me = await this.self().catch(() => null);
    // The student's own Canvas course colors (used as defaults in "Canvas look")
    const colorRes = await this.get("/users/self/colors", {}, { all: false }).catch(() => null);
    const colors = Object.fromEntries(Object.entries(colorRes?.custom_colors || {})
      .map(([k, v]) => [k.replace(/^course_/, ""), v]).filter(([k]) => /^\d+$/.test(k)));
    return {
      fetched_at: new Date().toISOString(),
      base_url: this.baseUrl,
      colors,
      course_source,
      user_id: me?.id ?? null,
      courses: perCourse,
      announcements: announcements.slice(0, 40).map((a) => ({
        id: a.id,
        course_id: Number(String(a.context_code).replace("course_", "")),
        title: a.title, posted_at: a.posted_at, message: stripHtml(a.message || "").slice(0, 500), url: a.html_url,
        unread: a.read_state === "unread", author: a.author?.display_name || a.user_name || "",
      })),
    };
  }

  // ---------- Scan: what's available per course and how big (no content downloaded) ----------
  async scanCourse(courseId) {
    const [course, assignments, modules, pages, discussions, files] = await Promise.all([
      this.course(courseId), this.assignments(courseId).catch(() => []), this.modules(courseId),
      this.pagesList(courseId), this.discussions(courseId), this.collectFiles(courseId),
    ]);
    const mine = myAttachments(assignments);
    return {
      syllabus: !!stripHtml(course.syllabus_body || ""),
      assignments: assignments.length,
      quizzes_skipped: assignments.filter(isBlockedAssignment).length,
      modules: modules?.length ?? 0,
      pages: pages ? pages.filter((p) => !isLocked(p)).length : 0,
      discussions: discussions ? discussions.filter((d) => !d.is_announcement && !isLocked(d)).length : 0,
      files: files.list.length,
      files_bytes: files.list.reduce((s, f) => s + (f.size || 0), 0),
      files_source: files.source,
      my_files: mine.length,
      my_files_bytes: mine.reduce((s, f) => s + (f.size || 0), 0),
    };
  }

  // Course Files tab if students can see it; otherwise files linked from modules.
  async collectFiles(courseId) {
    const [files, folders] = await Promise.all([this.files(courseId), this.folders(courseId)]);
    if (files) {
      const folderPath = Object.fromEntries((folders || []).map((f) => [f.id, f.full_name.replace(/^course files\/?/, "")]));
      return {
        source: "files",
        list: files.filter((f) => !f.locked_for_user).map((f) => ({
          id: f.id, name: f.display_name, size: f.size, url: f.url, type: f["content-type"], folder: folderPath[f.folder_id] || "",
          key: `f:${f.id}`, version: `${f.modified_at || f.updated_at || ""}|${f.size}`,
        })),
      };
    }
    const modules = (await this.modules(courseId)) || [];
    const items = modules.flatMap((m) => (m.items || []).filter((i) => i.type === "File" && !isLocked(i.content_details)).map((i) => ({ ...i, module: m.name })));
    const list = (await Promise.all(items.map(async (i) => {
      const f = await this.file(i.content_id).catch(() => null);
      return f && !f.locked_for_user ? { id: f.id, name: f.display_name, size: f.size, url: f.url, type: f["content-type"], folder: i.module, key: `f:${f.id}`, version: `${f.modified_at || f.updated_at || ""}|${f.size}` } : null;
    }))).filter(Boolean);
    return { source: "modules", list };
  }

  // ---------- Full backup: everything in the course, laid out like Canvas ----------
  // Returns { items: [{path, url} | {path, text}], skipped: ["what wasn't included and why"] }.
  // Modules become numbered folders; text headers inside a module ("Week 3 — Readings") become subfolders.
  // Quizzes, external tools and locked items are never opened; they're listed in _Not included.txt.
  async backupPlan(courseId, root, onProgress = () => {}) {
    const clean = (s) => String(s || "untitled").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "").slice(0, 90) || "untitled";
    const num = (i) => String(i + 1).padStart(2, "0");
    const base = this.baseUrl;
    const html = (title, body, meta = "") => `<!doctype html><html><head><meta charset="utf-8"><base href="${base}/"><title>${title.replace(/</g, "&lt;")}</title>`
      + `<style>body{font:16px/1.55 system-ui,sans-serif;max-width:820px;margin:32px auto;padding:0 16px}img{max-width:100%}.meta{color:#666}</style></head>`
      + `<body><h1>${title.replace(/</g, "&lt;")}</h1>${meta ? `<p class="meta">${meta}</p>` : ""}${body || ""}</body></html>`;
    const fileMeta = (f) => ({ id: f.id, name: f.display_name, url: f.url, size: f.size, date: f.modified_at || f.updated_at });

    onProgress("Reading the course outline");
    const [course, modules, files, folders, assignments, discussions, pagesList] = await Promise.all([
      this.course(courseId), this.modules(courseId), this.files(courseId), this.folders(courseId),
      this.assignments(courseId).catch(() => []), this.discussions(courseId).catch(() => []), this.pagesList(courseId),
    ]);
    const items = [], skipped = [], usedPaths = new Set();
    const put = (path, data) => {
      let p = `${root}/${path}`, i = 2;
      while (usedPaths.has(p.toLowerCase())) p = `${root}/${path}`.replace(/(\.[^./]+)?$/, ` (${i++})$1`);
      usedPaths.add(p.toLowerCase());
      items.push({ path: p, ...data });
    };
    const fileById = new Map((files || []).map((f) => [f.id, f]));
    const asgById = new Map((assignments || []).map((a) => [a.id, a]));
    const discById = new Map((discussions || []).map((d) => [d.id, d]));
    const placedFiles = new Set(), placedPages = new Set(), placedAsg = new Set(), placedDisc = new Set();

    const addPage = async (url, dir) => {
      if (!url || placedPages.has(url)) return;
      placedPages.add(url);
      const pg = await this.page(courseId, url).catch(() => null);
      if (!pg || isLocked(pg)) { skipped.push(`Page "${url}": locked or hidden`); return; }
      put(`${dir}/${clean(pg.title)}.html`, { text: html(pg.title, pg.body) });
    };
    const addAssignment = (a, dir) => {
      if (!a || placedAsg.has(a.id)) return;
      placedAsg.add(a.id);
      const due = a.due_at ? `Due ${new Date(a.due_at).toLocaleString()}` : "No due date";
      if (isBlockedAssignment(a)) { skipped.push(`"${a.name}": quiz or outside tool (never opened; ${due})`); return; }
      if (isLocked(a)) { skipped.push(`"${a.name}": locked`); return; }
      put(`${dir}/${clean(a.name)} (assignment).html`, { text: html(a.name, a.description, `${due}${a.points_possible ? ` · ${a.points_possible} points` : ""} · <a href="${a.html_url}">Open in Canvas</a>`) });
    };
    const addDiscussion = (d, dir) => {
      if (!d || placedDisc.has(d.id)) return;
      placedDisc.add(d.id);
      if (isLocked(d)) { skipped.push(`Discussion "${d.title}": locked`); return; }
      put(`${dir}/${clean(d.title)} (discussion).html`, { text: html(d.title, d.message, `<a href="${d.html_url}">Open in Canvas</a>`) });
    };
    const addFile = async (id, dir) => {
      if (placedFiles.has(id)) return;
      const f = fileById.get(id) || (await this.optional(`/courses/${courseId}/files/${id}`, {}, { all: false }).catch(() => null)) || (await this.file(id).catch(() => null));
      if (!f) { skipped.push(`File ${id}: not available to students`); return; }
      if (f.locked_for_user) { skipped.push(`"${f.display_name}": locked`); return; }
      placedFiles.add(id);
      const m = fileMeta(f);
      put(`${dir}/${clean(m.name)}`, { url: m.url, date: m.date, size: m.size });
    };

    // Modules
    const mods = modules || [];
    for (let mi = 0; mi < mods.length; mi++) {
      const m = mods[mi];
      onProgress(`Module ${mi + 1} of ${mods.length}`);
      const mdir = `Modules/${num(mi)} ${clean(m.name)}`;
      if (isLocked(m) || m.state === "locked") { skipped.push(`Module "${m.name}": locked`); continue; }
      let dir = mdir, section = 0;
      const links = [];
      for (const it of m.items || []) {
        if (it.type === "SubHeader") { section++; dir = `${mdir}/${num(section - 1)} ${clean(it.title)}`; continue; }
        if (isLocked(it.content_details)) { skipped.push(`"${it.title}" in ${m.name}: locked`); continue; }
        if (it.type === "File") await addFile(it.content_id, dir);
        else if (it.type === "Page") await addPage(it.page_url, dir);
        else if (it.type === "Assignment") addAssignment(asgById.get(it.content_id), dir);
        else if (it.type === "Discussion") addDiscussion(discById.get(it.content_id), dir);
        else if (it.type === "ExternalUrl") links.push(`- [${it.title}](${it.external_url})`);
        else if (it.type === "Quiz") skipped.push(`"${it.title}" in ${m.name}: quiz (never opened)`);
        else if (it.type === "ExternalTool") skipped.push(`"${it.title}" in ${m.name}: outside tool (never opened)`);
      }
      if (links.length) put(`${mdir}/Links.md`, { text: `# Links in ${m.name}\n\n${links.join("\n")}\n` });
    }

    // Everything not in a module, in its own place
    onProgress("Files, pages and assignments");
    const folderPath = Object.fromEntries((folders || []).map((f) => [f.id, f.full_name.replace(/^course files\/?/, "")]));
    for (const f of files || []) if (!placedFiles.has(f.id)) await addFile(f.id, ["Files", ...(folderPath[f.folder_id] || "").split("/").filter(Boolean).map(clean)].join("/"));
    if (!files) skipped.push("The Files area is hidden for students, so only files shown in modules are included.");
    for (const pg of pagesList || []) if (!placedPages.has(pg.url)) await addPage(pg.url, "Pages");
    for (const a of assignments || []) addAssignment(a, "Assignments");
    for (const d of discussions || []) addDiscussion(d, "Discussions");

    if (course?.syllabus_body) put("Syllabus.html", { text: html(`${course.name}: Syllabus`, course.syllabus_body) });
    const anns = await this.announcements([courseId], 3650).catch(() => []);
    if (anns?.length) put("Announcements.html", { text: html(`${course?.name || ""}: Announcements`, anns.map((a) => `<h2>${(a.title || "").replace(/</g, "&lt;")}</h2><p class="meta">${a.posted_at ? new Date(a.posted_at).toLocaleString() : ""}</p>${a.message || ""}`).join("<hr>")) });

    // My submissions: uploaded files and typed answers
    for (const a of assignments || []) {
      const sub = a.submission;
      if (!sub) continue;
      const dir = `My submissions/${clean(a.name)}`;
      for (const f of sub.attachments || []) put(`${dir}/${clean(f.display_name)}`, { url: f.url, date: f.modified_at || f.updated_at, size: f.size });
      if (sub.body) put(`${dir}/My answer.html`, { text: html(`${a.name}: my answer`, sub.body, sub.submitted_at ? `Submitted ${new Date(sub.submitted_at).toLocaleString()}` : "") });
      if (sub.url) put(`${dir}/Submitted link.md`, { text: `[${sub.url}](${sub.url})\n` });
    }

    // Grades at a glance
    const rows = (assignments || []).filter((a) => a.submission && (a.submission.score != null || a.submission.excused));
    if (rows.length) put("My grades.csv", { text: "Assignment,Score,Points possible,Due,Graded\n" + rows.map((a) => [a.name, a.submission.excused ? "excused" : a.submission.score, a.points_possible ?? "", a.due_at || "", a.submission.graded_at || ""]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n") + "\n" });
    return { items, skipped, name: course?.name || String(courseId) };
  }

  // ---------- Full content for export ----------
  // `prev` is the fingerprint map from this course's last export ({} = export everything).
  // Unchanged items are skipped, and unchanged pages aren't even downloaded.
  // Returns content plus `fp` (fingerprints of everything seen now) and `changes` counts.
  async courseContent(courseId, want, onProgress = () => {}, prev = {}) {
    const out = { id: courseId, fp: {}, changes: { new: 0, changed: 0, same: 0 } };
    const course = await this.course(courseId);
    out.name = course.name; out.code = course.course_code;

    // Records the fingerprint and says whether this item should be included.
    const fresh = (key, version) => {
      out.fp[key] = version;
      if (!(key in prev)) { out.changes.new++; return "new"; }
      if (prev[key] !== version) { out.changes.changed++; return "changed"; }
      out.changes.same++; return null;
    };

    if (want.syllabus) {
      const text = stripHtml(course.syllabus_body || "");
      if (text && fresh("syllabus", hash(text))) out.syllabus = text;
    }

    if (want.assignments) {
      onProgress("assignments");
      const list = await this.assignments(courseId);
      out.assignments = list.map((a) => {
        const details = safeAssignmentContent(a) ?? stripHtml(a.description || "");
        const status = fresh(`a:${a.id}`, hash([a.updated_at, a.due_at, details, a.submission?.submitted_at, a.submission?.score].join("|")));
        if (!status) return null;
        return {
          status,
          name: a.name,
          due_at: a.due_at,
          points: a.points_possible,
          submitted: !!a.submission?.submitted_at,
          score: a.submission?.score ?? null,
          url: a.html_url,
          details,
          rubric: !isBlockedAssignment(a) && a.rubric ? a.rubric.map((r) => `${r.description} (${r.points} pts)${r.long_description ? `: ${r.long_description}` : ""}`) : [],
        };
      }).filter(Boolean);
    }

    if (want.modules) {
      onProgress("modules");
      const modules = (await this.modules(courseId)) || [];
      const outline = modules.map((m) => ({
        name: m.name,
        items: (m.items || []).map((i) => `${i.title} (${BLOCKED_ITEM_TYPES.has(i.type) ? "quiz/tool, not opened" : i.type})`),
      }));
      // The outline is small and gives context, so send it whole whenever anything in it changed.
      if (fresh("modules", hash(JSON.stringify(outline)))) out.modules = outline;
    }

    if (want.pages) {
      onProgress("pages");
      const list = ((await this.pagesList(courseId)) || []).filter((p) => !isLocked(p));
      const changed = list.map((p) => ({ p, status: fresh(`p:${p.page_id ?? p.url}`, p.updated_at || "") })).filter((x) => x.status);
      out.pages = (await Promise.all(changed.slice(0, 60).map(async ({ p, status }) => {
        const full = await this.page(courseId, p.url).catch(() => null);
        return full && !isLocked(full) ? { status, title: full.title, text: stripHtml(full.body || "") } : null;
      }))).filter((p) => p?.text);
    }

    if (want.discussions) {
      onProgress("discussions");
      const list = ((await this.discussions(courseId)) || []).filter((d) => !d.is_announcement && !isLocked(d));
      out.discussions = list.map((d) => {
        const prompt = stripHtml(d.message || "");
        const status = fresh(`d:${d.id}`, hash(d.title + prompt + (d.assignment?.due_at || "")));
        return status ? { status, title: d.title, due_at: d.assignment?.due_at || null, prompt } : null;
      }).filter(Boolean);
    }

    if (want.announcements) {
      onProgress("announcements");
      const list = await this.announcements([courseId], 120).catch(() => []);
      out.announcements = list.map((a) => {
        const message = stripHtml(a.message || "");
        const status = fresh(`n:${a.id}`, hash(a.title + message));
        return status ? { status, title: a.title, posted_at: a.posted_at, message } : null;
      }).filter(Boolean);
    }
    return out;
  }

  // ---------- Lectures: every readable page/file in modules, as its own item, newest first ----------
  async lectures(courseId) {
    const [modules, pages, files] = await Promise.all([
      this.modules(courseId), this.pagesList(courseId), this.files(courseId),
    ]);
    const pageDate = Object.fromEntries((pages || []).map((p) => [p.url, p.created_at || p.updated_at]));
    const fileInfo = Object.fromEntries((files || []).map((f) => [f.id, f]));
    const out = [];
    (modules || []).forEach((m, mi) => {
      (m.items || []).forEach((i, ii) => {
        if (BLOCKED_ITEM_TYPES.has(i.type) || !["Page", "File"].includes(i.type)) return;
        if (isLocked(i.content_details)) return;
        const f = i.type === "File" ? fileInfo[i.content_id] : null;
        out.push({
          key: `${courseId}:${i.id}`,
          course_id: courseId,
          module: m.name,
          module_index: mi,
          title: i.title,
          type: i.type,
          page_url: i.page_url || null,
          file_id: i.type === "File" ? i.content_id : null,
          file_type: f?.["content-type"] || null,
          url: i.html_url,
          doc_key: i.type === "Page" ? `${courseId}:P:${i.page_url}` : `${courseId}:F:${i.content_id}`,
          date: i.type === "Page" ? pageDate[i.page_url] || null : f?.created_at || null,
          order: mi * 1000 + ii,
          is_lecture: LECTURE_WORDS.test(i.title) || LECTURE_WORDS.test(m.name),
        });
      });
    });
    // Newest first when dates exist; otherwise latest module first.
    return out.sort((a, b) => (Date.parse(b.date || 0) - Date.parse(a.date || 0)) || (b.order - a.order));
  }

  // Text of one lecture (Page) or the downloadable file info (File).
  async lectureContent(courseId, { type, page_url, file_id }) {
    if (type === "Page") {
      const p = await this.page(courseId, page_url);
      if (!p || isLocked(p)) throw new Error("This page is locked or hidden.");
      return { title: p.title, text: stripHtml(p.body || "") };
    }
    const f = await this.file(file_id);
    if (!f || f.locked_for_user) throw new Error("This file is locked.");
    return { title: f.display_name, file: { id: f.id, name: f.display_name, url: f.url, size: f.size, type: f["content-type"], key: `f:${f.id}`, version: `${f.modified_at || f.updated_at || ""}|${f.size}` } };
  }

  // nbgitpuller links ("open in DataHub") that point at the student's own hub, from modules and assignment instructions.
  // Only reads the link URLs; nothing is opened here.
  async gitPullLinks(courseId, isMatch) {
    const [modules, assignments] = await Promise.all([this.modules(courseId), this.assignments(courseId).catch(() => [])]);
    const found = new Map();
    for (const m of modules || []) for (const i of m.items || []) {
      if (i.external_url && isMatch(i.external_url)) found.set(i.external_url, `${m.name} › ${i.title}`);
    }
    for (const a of assignments) {
      if (isBlockedAssignment(a)) continue;
      for (const [, href] of String(a.description || "").matchAll(/href="([^"]+)"/g)) {
        const url = href.replace(/&amp;/g, "&");
        if (isMatch(url) && !found.has(url)) found.set(url, a.name);
      }
    }
    return [...found].map(([url, title]) => ({ url, title }));
  }

  async myFiles(courseId) {
    return myAttachments(await this.assignments(courseId).catch(() => []));
  }
}

// Files the student uploaded with their own submissions.
function myAttachments(assignments) {
  return assignments.flatMap((a) => (a.submission?.attachments || []).map((f) => ({
    id: f.id, name: f.display_name, size: f.size, url: f.url, folder: `My submissions/${a.name}`,
    key: `m:${f.id}`, version: `${f.modified_at || f.updated_at || ""}|${f.size}`,
  })));
}

const LECTURE_WORDS = /\b(lecture|lec\.?\s*\d|class\s*\d|slides?|notes|week\s*\d|session\s*\d|chapter|ch\.?\s*\d|unit\s*\d|topic)\b/i;

export class CanvasError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

// Small, fast string hash (djb2) for change detection; not for security.
export function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function parseNextLink(header) {
  if (!header) return null;
  const m = header.split(",").find((p) => p.includes('rel="next"'));
  return m ? m.match(/<([^>]+)>/)[1] : null;
}

export function stripHtml(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/(p|div|h\d|li|tr)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n").replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*/g, "\n\n").trim();
}
