// BetterCanvas-style enhancements on Canvas pages:
// - Dashboard sidebar: Due soon, Recent announcements (replaces Canvas's To Do), Recent grades
//   (replaces Recent Feedback), each with tabs and an Expand view that opens inside the Canvas tab
// - Course card chips (grade, due this week)
// - "Practice" buttons on lecture pages and modules
// Read-only and display-only. Never runs on quiz, exam or external-tool pages.
(() => {
  const PROTECTED = /\/quizzes(\/|$)|\/assessments?\/|quiz-lti|\/external_tools\/|lockdown|respondus|proctor/i;
  if (PROTECTED.test(location.href) || window.__studypilotEnhance) return;
  window.__studypilotEnhance = true;

  const DAY = 864e5;
  let settings = {}, snapshot = null, doneIds = [], seenGrades = [], colors = {};
  const view = { todo: "week", ann: null, grades: null };   // selected tab per card
  let expanded = null;                                      // { tab, course, q, ann: [...] }

  // ---------- helpers ----------
  const h = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    kids.flat(Infinity).forEach((k) => k != null && k !== false && n.append(k));
    return n;
  };

  function relDue(iso, a) {
    const d = new Date(iso), diff = d - Date.now();
    const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    // Work turned in on Gradescope or another outside site has no Canvas submission until it's graded.
    if (diff < 0 && a?.kind === "tool") return { text: `Turned in on ${String(a.kind_label || "").replace(/^submitted on /, "") || "the tool"}?`, tone: "later" };
    if (diff < 0 && a?.kind === "offline") return { text: "Past due", tone: "later", title: "Handed in on paper or elsewhere, so Canvas can't tell whether it's done." };
    if (diff < 0) return { text: "Overdue", tone: "late" };
    if (diff < 3 * 3600e3) { const m = Math.max(1, Math.round(diff / 60e3)); return { text: m >= 60 ? `in ${Math.round(m / 60)}h` : `in ${m} min`, tone: "now" }; }
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const days = Math.floor((d - today) / DAY);
    if (days === 0) return { text: `Today ${time}`, tone: "soon" };
    if (days === 1) return { text: `Tomorrow ${time}`, tone: "soon" };
    if (days < 7) return { text: `${d.toLocaleDateString([], { weekday: "short" })} ${time}`, tone: "week" };
    return { text: d.toLocaleDateString([], { month: "short", day: "numeric" }), tone: "later" };
  }

  function ago(iso) {
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 90) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < DAY / 1000) return `${Math.round(s / 3600)}h ago`;
    if (s < 7 * DAY / 1000) return `${Math.round(s / 86400)}d ago`;
    return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
  }

  const hiddenSet = () => new Set(settings.hiddenCourses || []);
  // Inside a course (/courses/123/…) the sidebar cards show just that course.
  const coursePageId = () => Number(location.pathname.match(/^\/courses\/(\d+)/)?.[1]) || null;
  const courses = () => {
    const only = coursePageId();
    return (snapshot?.courses || []).filter((c) => !hiddenSet().has(c.id) && (!only || c.id === only));
  };
  const courseById = (id) => snapshot?.courses.find((c) => c.id === id);
  const courseName = (id) => { const c = courseById(id); return c ? (c.code || c.name) : ""; };
  const colorOf = (id) => settings.look?.courseColors?.[id] || colors[id] || snapshot?.colors?.[id] || "#8a8a8a";
  const dot = (id) => h("span", { class: "sp-dot", style: `background:${colorOf(id)}`, "aria-hidden": "true" });

  function openWork() {
    const now = Date.now();
    return courses().flatMap((c) => c.assignments
      .filter((a) => a.due_at && !a.submitted)
      .map((a) => ({ ...a, course: c.code || c.name, course_id: c.id })))
      .filter((a) => Date.parse(a.due_at) > now - 7 * DAY)
      .sort((a, b) => Date.parse(a.due_at) - Date.parse(b.due_at));
  }

  function announcements() {
    const hid = hiddenSet();
    return (snapshot?.announcements || []).filter((a) => !hid.has(a.course_id))
      .sort((a, b) => Date.parse(b.posted_at) - Date.parse(a.posted_at));
  }

  function recentGrades() {
    const base = snapshot?.base_url || location.origin, uid = snapshot?.user_id;
    return courses().flatMap((c) => c.assignments
      .filter((a) => a.graded && a.score != null)
      .map((a) => ({
        ...a, course_id: c.id, course: c.code || c.name,
        when: a.graded_at || a.due_at,
        link: uid ? `${base}/courses/${c.id}/assignments/${a.id}/submissions/${uid}` : a.url,
      })))
      .sort((a, b) => Date.parse(b.when || 0) - Date.parse(a.when || 0));
  }

  function scorePill(a) {
    const pct = a.points ? (a.score / a.points) * 100 : null;
    const tone = pct == null ? "" : pct >= 90 ? "good" : pct >= 70 ? "mid" : "low";
    const text = a.points ? `${+a.score.toFixed(2)}/${a.points}` : (a.grade ?? `${a.score}`);
    return h("span", { class: `sp-score ${tone}`, title: pct != null ? `${pct.toFixed(1)}%` : "" }, text, pct != null ? h("small", {}, ` ${Math.round(pct)}%`) : null);
  }

  const isDashboard = () => location.pathname === "/" || location.pathname === "/dashboard";

  // Line icons (same drawings as the side panel)
  const ICON = {
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
    expand: '<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    quiz: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.4 1 1.1 1 1.8V16h5v-.3c0-.7.4-1.4 1-1.8A6 6 0 0 0 12 3z"/>',
  };
  function svg(name, size = 16) {
    const t = document.createElement("template");
    t.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON[name]}</svg>`;
    return t.content.firstChild;
  }

  // ---------- generic sidebar card ----------
  function card({ id, title, tabs, current, onTab, body, foot, expandTab }) {
    return h("section", { id, class: "sp-card", "aria-label": title },
      h("header", { class: "sp-head" },
        h("div", { class: "sp-title" }, title),
        h("div", { class: "sp-head-acts" },
          h("button", { class: "sp-icon", title: "Expand", "aria-label": `Expand ${title}`, onclick: () => openExpanded(expandTab) }, svg("expand", 15)),
          h("button", { class: "sp-icon", title: "Refresh", "aria-label": "Refresh", onclick: (e) => { e.currentTarget.classList.add("spin"); chrome.runtime.sendMessage({ type: "SYNC" }); } }, svg("refresh", 15)))),
      tabs ? h("div", { class: "sp-tabs", role: "tablist" }, tabs.map(([v, label, count]) => h("button", {
        class: "sp-tab" + (v === current ? " on" : ""), role: "tab", "aria-selected": String(v === current), onclick: () => onTab(v),
      }, label, count ? h("span", { class: "sp-count" }, count) : null))) : null,
      body,
      h("footer", { class: "sp-foot" }, foot,
        h("button", { class: "sp-link", onclick: () => openExpanded(expandTab) }, "See all →")));
  }

  // ---------- Due soon ----------
  function todoCard() {
    const v = view.todo;
    const horizon = { today: 1, week: 7, all: 60 }[v];
    const end = new Date(); end.setHours(23, 59, 59, 999);
    let items = openWork().filter((a) => Date.parse(a.due_at) <= end.getTime() + (horizon - 1) * DAY);
    const doneCount = items.filter((a) => doneIds.includes(a.id)).length;
    if (settings.hideDone) items = items.filter((a) => !doneIds.includes(a.id));
    const list = h("ul", { class: "sp-list" });
    if (!items.length) list.append(h("li", { class: "sp-empty" }, v === "today" ? "Nothing due today" : "You're all caught up"));
    items.slice(0, 8).forEach((a) => list.append(todoRow(a)));
    if (items.length > 8) list.append(h("li", { class: "sp-more" }, h("button", { class: "sp-link", onclick: () => openExpanded("todo") }, `+${items.length - 8} more`)));
    const synced = snapshot.fetched_at ? new Date(snapshot.fetched_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
    return card({
      id: "sp-todo", title: "Due soon", expandTab: "todo",
      tabs: [["today", "Today"], ["week", "This week"], ["all", "All"]], current: v,
      onTab: (t) => { view.todo = t; renderSidebar(); },
      body: list, foot: h("span", {}, `Updated ${synced}`, doneCount && settings.hideDone ? ` · ${doneCount} done` : ""),
    });
  }

  function todoRow(a, { details = false } = {}) {
    const due = relDue(a.due_at, a), done = doneIds.includes(a.id);
    const box = h("input", { type: "checkbox", class: "sp-check", title: "Mark done (only in StudyPilot)", "aria-label": `Mark ${a.name} done` });
    box.checked = done;
    box.addEventListener("change", async () => {
      doneIds = box.checked ? [...new Set([...doneIds, a.id])] : doneIds.filter((x) => x !== a.id);
      await chrome.storage.local.set({ doneIds });
      // Same "done" as the side panel: it leaves every to-do list (undo by unchecking right away, or in the panel's toast)
      chrome.runtime.sendMessage({ type: "MARK_DONE", payload: { courseId: a.course_id, assignmentId: a.id, done: box.checked } }).catch(() => {});
    });
    return h("li", { class: "sp-item" + (done ? " done" : "") },
      box, dot(a.course_id),
      h("div", { class: "sp-main" },
        h("a", { href: a.url, class: "sp-name", title: a.name }, a.name),
        h("div", { class: "sp-meta" },
          h("span", { class: `sp-due sp-${due.tone}` }, due.text),
          h("span", {}, a.course, a.points ? ` · ${a.points} pts` : ""),
          a.is_quiz ? h("span", { class: "sp-pill" }, "Quiz") : a.kind === "tool" ? h("span", { class: "sp-pill" }, a.kind_label.replace("submitted on ", "")) : null),
        details && a.details ? h("details", { class: "sp-details" }, h("summary", {}, "Instructions"), h("p", {}, a.details)) : null));
  }

  // ---------- Recent announcements ----------
  function annCard() {
    const all = announcements();
    const unread = all.filter((a) => a.unread);
    const week = all.filter((a) => Date.now() - Date.parse(a.posted_at) < 7 * DAY);
    const v = view.ann || (unread.length ? "unread" : "week");
    const items = v === "unread" ? unread : v === "week" ? week : all;
    const list = h("ul", { class: "sp-list" });
    if (!items.length) list.append(h("li", { class: "sp-empty" }, v === "unread" ? "No unread announcements" : "No announcements this week."));
    items.slice(0, 6).forEach((a) => list.append(annRow(a)));
    if (items.length > 6) list.append(h("li", { class: "sp-more" }, h("button", { class: "sp-link", onclick: () => openExpanded("ann") }, `+${items.length - 6} more`)));
    return card({
      id: "sp-ann", title: "Announcements", expandTab: "ann",
      tabs: [["unread", "Unread", unread.length || null], ["week", "This week"], ["all", "All"]], current: v,
      onTab: (t) => { view.ann = t; renderSidebar(); },
      body: list, foot: h("span", {}, `${all.length} in the last 3 weeks`),
    });
  }

  function annRow(a, { full = false } = {}) {
    const preview = (a.message || "").replace(/\s+/g, " ").trim();
    return h("li", { class: "sp-item sp-ann" + (a.unread ? " unread" : "") },
      dot(a.course_id),
      h("div", { class: "sp-main" },
        h("a", { href: a.url, class: "sp-name", title: a.title }, a.title, a.unread ? h("span", { class: "sp-sr" }, " (unread)") : null),
        h("div", { class: "sp-meta" }, h("span", {}, courseName(a.course_id)), h("span", {}, "· " + ago(a.posted_at)), a.author && full ? h("span", {}, "· " + a.author) : null),
        full
          ? (preview ? h("details", { class: "sp-details" }, h("summary", {}, "Read here"), h("p", {}, a.message), h("a", { class: "sp-link", href: a.url }, "Open in Canvas →")) : null)
          : (preview ? h("div", { class: "sp-preview" }, preview.slice(0, 110) + (preview.length > 110 ? "…" : "")) : null)),
      a.unread ? h("span", { class: "sp-new-dot", title: "Unread", "aria-hidden": "true" }) : null);
  }

  // ---------- Recent grades ----------
  function gradesCard() {
    const all = recentGrades();
    const fresh = all.filter((a) => !seenGrades.includes(a.id) && a.when && Date.now() - Date.parse(a.when) < 21 * DAY);
    const week = all.filter((a) => a.when && Date.now() - Date.parse(a.when) < 7 * DAY);
    const v = view.grades || (fresh.length ? "new" : "week");
    const items = v === "new" ? fresh : v === "week" ? week : all;
    const list = h("ul", { class: "sp-list" });
    if (!items.length) list.append(h("li", { class: "sp-empty" }, v === "new" ? "No new grades." : "No grades posted this week."));
    items.slice(0, 6).forEach((a) => list.append(gradeRow(a)));
    if (items.length > 6) list.append(h("li", { class: "sp-more" }, h("button", { class: "sp-link", onclick: () => openExpanded("grades") }, `+${items.length - 6} more`)));
    return card({
      id: "sp-grades", title: "Recent grades", expandTab: "grades",
      tabs: [["new", "New", fresh.length || null], ["week", "This week"], ["all", "All"]], current: v,
      onTab: (t) => { view.grades = t; renderSidebar(); },
      body: list,
      foot: fresh.length ? h("button", { class: "sp-link sp-muted", onclick: markGradesSeen }, "Mark all seen") : h("span", {}, `${all.length} graded so far`),
    });
  }

  async function markGradesSeen() {
    seenGrades = [...new Set([...seenGrades, ...recentGrades().map((a) => a.id)])].slice(-3000);
    view.grades = null;
    await chrome.storage.local.set({ seenGrades });
  }

  function gradeRow(a) {
    const isNew = !seenGrades.includes(a.id);
    // Name gets the full width; the score sits on the line below so narrow sidebars don't squeeze it.
    return h("li", { class: "sp-item sp-grade" + (isNew ? " is-new" : "") },
      dot(a.course_id),
      h("div", { class: "sp-main" },
        h("a", { href: a.link, class: "sp-name", title: a.name, onclick: () => { seenGrades = [...new Set([...seenGrades, a.id])]; chrome.storage.local.set({ seenGrades }); } },
          a.name, isNew ? h("span", { class: "sp-sr" }, " (new)") : null),
        h("div", { class: "sp-meta" }, scorePill(a), h("span", {}, a.course), a.when ? h("span", {}, "· " + ago(a.when)) : null)),
      isNew ? h("span", { class: "sp-new-dot", title: "New", "aria-hidden": "true" }) : null);
  }

  // ---------- Hide Canvas's own To Do and Recent Feedback, put ours in their place ----------
  function nativeSection(re) {
    const side = document.querySelector("#right-side");
    if (!side) return null;
    const isTodo = re.test("To Do");
    const known = isTodo
      ? side.querySelector(".Sidebar__TodoListContainer, .todo-list, [data-testid='ToDoSidebar']")
      : side.querySelector(".recent_feedback, .events_list.recent_feedback, [data-testid='RecentFeedback']");
    if (known) return known;
    const head = [...side.querySelectorAll("h2, h3, h4, .h2")].find((x) => re.test(x.textContent.trim()) && !x.closest(".sp-card"));
    if (!head) return null;
    // the heading's own block: climb while the parent only holds this section
    let el = head.parentElement;
    while (el && el.parentElement && el.parentElement !== side && el.parentElement.children.length === 1) el = el.parentElement;
    return el && el !== side ? el : head;
  }

  function setHidden(el, hide) {
    if (!el) return;
    if (hide) { el.dataset.spHidden = "1"; el.style.setProperty("display", "none", "important"); }
    else if (el.dataset.spHidden) { delete el.dataset.spHidden; el.style.removeProperty("display"); }
  }

  function renderSidebar() {
    ["sp-todo", "sp-ann", "sp-grades"].forEach((id) => document.getElementById(id)?.remove());
    if (!snapshot) return;
    const nativeTodo = nativeSection(/^to\s*do$/i);
    const nativeFeedback = nativeSection(/^recent feedback$/i);
    if (!isDashboard()) {
      // Course pages: swap Canvas's To Do and Recent Feedback for ours, in the same spots, for this course only.
      if (!coursePageId() || !courseById(coursePageId())) return;
      setHidden(nativeTodo, settings.replaceTodo !== false);
      setHidden(nativeFeedback, settings.replaceFeedback !== false);
      if (nativeTodo && settings.replaceTodo !== false) nativeTodo.before(todoCard());
      if (nativeFeedback && settings.replaceFeedback !== false) nativeFeedback.before(gradesCard());
      return;
    }
    const side = document.querySelector("#right-side") || document.querySelector("#dashboard") || document.querySelector("#content");
    if (!side) return;
    setHidden(nativeTodo, settings.replaceTodo !== false);
    setHidden(nativeFeedback, settings.replaceFeedback !== false);

    const todo = settings.dashTodo !== false ? todoCard() : null;
    const ann = settings.replaceTodo !== false ? annCard() : null;
    const grades = settings.replaceFeedback !== false ? gradesCard() : null;
    if (todo) side.prepend(todo);
    if (ann) { if (nativeTodo?.parentElement) nativeTodo.before(ann); else (todo ? todo.after(ann) : side.prepend(ann)); }
    if (grades) { if (nativeFeedback?.parentElement) nativeFeedback.before(grades); else (ann || todo ? (ann || todo).after(grades) : side.prepend(grades)); }
  }

  // ---------- Expanded view (inside the Canvas tab) ----------
  let lastFocus = null;
  function openExpanded(tab) {
    lastFocus = document.activeElement;
    expanded = { tab, course: "all", q: "", ann: expanded?.ann || null };
    if (tab === "grades") markGradesSeen();
    renderExpanded();
    document.documentElement.classList.add("sp-noscroll");
  }

  function closeExpanded() {
    expanded = null;
    document.getElementById("sp-expand")?.remove();
    document.documentElement.classList.remove("sp-noscroll");
    lastFocus?.focus?.();
  }

  let annLoading = false;
  async function loadFullAnnouncements() {
    if (annLoading) return;
    annLoading = true;
    let list = null;
    try {
      const r = await chrome.runtime.sendMessage({ type: "ANNOUNCEMENTS_FULL", payload: { days: 120 } });
      if (r?.ok && Array.isArray(r.data)) list = r.data;
    } catch { /* fall back below */ }
    annLoading = false;
    // Merge with what the sidebar already has, so nothing shown there is ever missing here
    const byId = new Map(announcements().map((a) => [a.id, a]));
    for (const a of list || []) byId.set(a.id, { ...byId.get(a.id), ...a });
    if (expanded) { expanded.ann = [...byId.values()].sort((a, b) => Date.parse(b.posted_at) - Date.parse(a.posted_at)); renderExpanded(); }
  }

  function renderExpanded() {
    const old = document.getElementById("sp-expand");
    const scroll = old?.querySelector(".sp-x-body")?.scrollTop || 0;
    const hadSearchFocus = document.activeElement?.id === "sp-x-search";
    old?.remove();
    if (!expanded) return;
    const E = expanded;
    const match = (txt) => !E.q || String(txt).toLowerCase().includes(E.q.toLowerCase());
    const inCourse = (id) => E.course === "all" || E.course === id;

    let body, count = 0;
    if (E.tab === "todo") {
      const items = openWork().filter((a) => inCourse(a.course_id) && match(a.name + " " + a.course + " " + (a.details || "")));
      count = items.length;
      const groups = new Map();
      for (const a of items) {
        const d = new Date(a.due_at); const key = Date.parse(a.due_at) < Date.now() ? (a.kind === "tool" || a.kind === "offline" ? "Past due (turned in elsewhere?)" : "Overdue") : d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(a);
      }
      body = groups.size ? [...groups].map(([k, list]) => h("section", { class: "sp-x-group" }, h("h3", {}, k), h("ul", { class: "sp-list" }, list.map((a) => todoRow(a, { details: true })))))
        : h("div", { class: "sp-empty" }, "Nothing due");
    } else if (E.tab === "ann") {
      if (!E.ann) { loadFullAnnouncements(); body = h("div", { class: "sp-empty" }, "Loading announcements…"); }
      else {
        const items = E.ann.filter((a) => inCourse(a.course_id) && match(a.title + " " + a.message + " " + a.author));
        count = items.length;
        body = items.length ? h("ul", { class: "sp-list" }, items.map((a) => annRow(a, { full: true }))) : h("div", { class: "sp-empty" }, "No announcements match.");
      }
    } else {
      const items = recentGrades().filter((a) => inCourse(a.course_id) && match(a.name + " " + a.course));
      count = items.length;
      const summary = courses().filter((c) => inCourse(c.id) && c.current_score != null && (c.assignments.some((a) => a.graded) || c.current_score > 0))
        .map((c) => h("div", { class: "sp-x-course" }, dot(c.id), h("b", {}, c.code || c.name), h("span", {}, `${c.current_score}%${c.current_grade ? ` · ${c.current_grade}` : ""}`)));
      body = [summary.length ? h("div", { class: "sp-x-summary" }, summary) : null,
        items.length ? h("ul", { class: "sp-list" }, items.map(gradeRow)) : h("div", { class: "sp-empty" }, "No grades match.")];
    }

    const tabs = [["todo", "Due soon"], ["ann", "Announcements"], ["grades", "Grades"]];
    const chips = [h("button", { class: "sp-x-chip" + (E.course === "all" ? " on" : ""), onclick: () => { E.course = "all"; renderExpanded(); } }, "All courses"),
      ...courses().map((c) => h("button", { class: "sp-x-chip" + (E.course === c.id ? " on" : ""), onclick: () => { E.course = c.id; renderExpanded(); } }, dot(c.id), c.code || c.name))];
    const search = h("input", { id: "sp-x-search", type: "search", placeholder: "Search…", value: E.q, "aria-label": "Search", oninput: (e) => { E.q = e.target.value; renderExpanded(); } });

    const panel = h("div", { class: "sp-x-panel", role: "dialog", "aria-modal": "true", "aria-label": "StudyPilot" },
      h("header", { class: "sp-x-head" },
        h("div", { class: "sp-x-tabs", role: "tablist" }, tabs.map(([v, l]) => h("button", { class: "sp-x-tab" + (E.tab === v ? " on" : ""), role: "tab", "aria-selected": String(E.tab === v), onclick: () => { E.tab = v; E.q = ""; if (v === "grades") markGradesSeen(); renderExpanded(); } }, l))),
        h("button", { class: "sp-icon sp-x-close", "aria-label": "Close", title: "Close (Esc)", onclick: closeExpanded }, svg("close", 16))),
      h("div", { class: "sp-x-tools" }, search, h("div", { class: "sp-x-chips" }, chips)),
      h("div", { class: "sp-x-body" }, body),
      h("footer", { class: "sp-x-foot" }, `${count} item${count === 1 ? "" : "s"}`, h("button", { class: "sp-link", onclick: () => chrome.runtime.sendMessage({ type: "OPEN_PANEL" }) }, "Open StudyPilot →")));

    const overlay = h("div", { id: "sp-expand", class: "sp-x", onclick: (e) => { if (e.target === overlay) closeExpanded(); } }, panel);
    document.body.append(overlay);
    overlay.querySelector(".sp-x-body").scrollTop = scroll;
    if (hadSearchFocus) { const s = document.getElementById("sp-x-search"); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
    else if (!old) overlay.querySelector(".sp-x-tab.on")?.focus();
  }

  document.addEventListener("keydown", (e) => {
    if (!expanded) return;
    if (e.key === "Escape") { e.preventDefault(); closeExpanded(); }
    if (e.key === "Tab") { // keep focus inside the dialog
      const f = [...document.querySelectorAll("#sp-expand button, #sp-expand a, #sp-expand input, #sp-expand summary")].filter((x) => x.offsetParent);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  });

  // ---------- Course card chips ----------
  // In the card body (under the course name), so they never cover Canvas's ⋮ card menu.
  function renderBadges() {
    document.querySelectorAll(".sp-chips").forEach((n) => n.remove());
    if (!settings.cardBadges || !isDashboard() || !snapshot) return;
    const look = settings.look || {};
    const showGrade = look.showGrade !== false, showDue = look.showDue !== false;
    if (!showGrade && !showDue) return;
    const weekEnd = Date.now() + 7 * DAY;
    document.querySelectorAll(".ic-DashboardCard").forEach((cardEl) => {
      const link = cardEl.querySelector("a[href*='/courses/']");
      const id = Number(link?.getAttribute("href").match(/courses\/(\d+)/)?.[1]);
      const course = courseById(id);
      if (!course) return;
      const open = course.assignments.filter((a) => a.due_at && !a.submitted && Date.parse(a.due_at) > Date.now() && Date.parse(a.due_at) < weekEnd);
      const graded = course.assignments.some((a) => a.graded) || (course.current_score ?? 0) > 0;
      const chips = h("div", { class: "sp-chips", "aria-label": "StudyPilot summary" });
      if (showGrade && course.current_score != null && graded) {
        chips.append(h("span", { class: "sp-chip", title: "Current grade in Canvas" },
          h("span", { class: "sp-chip-dot", style: `background:${colorOf(id)}` }),
          `${Math.round(course.current_score * 10) / 10}%`, course.current_grade ? h("b", {}, ` ${course.current_grade}`) : null));
      }
      if (showDue && open.length) {
        const soon = open.some((a) => Date.parse(a.due_at) - Date.now() < 2 * DAY);
        chips.append(h("span", { class: "sp-chip sp-chip-due" + (soon ? " soon" : ""), title: open.map((a) => a.name).join("\n") }, `${open.length} due this week`));
      }
      if (!chips.childElementCount) return;
      (cardEl.querySelector(".ic-DashboardCard__header_content") || cardEl.querySelector(".ic-DashboardCard__link") || cardEl).append(chips);
    });
  }

  // ---------- "Practice" buttons (lecture pages, files, and each module) ----------
  function currentLecture() {
    const p = location.pathname;
    let m = p.match(/^\/courses\/(\d+)\/pages\/([^/?#]+)/);
    if (m) return { courseId: Number(m[1]), lecture: { type: "Page", page_url: decodeURIComponent(m[2]), title: document.title.split(":")[0].trim(), module: "" } };
    m = p.match(/^\/courses\/(\d+)\/files\/(\d+)/);
    if (m) return { courseId: Number(m[1]), lecture: { type: "File", file_id: Number(m[2]), title: document.title.split(":")[0].trim(), module: "Files" } };
    return null;
  }

  function quizButton(label, payload, cls) {
    return h("button", {
      class: cls, type: "button", "aria-label": label,
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); chrome.runtime.sendMessage({ type: "OPEN_PANEL", payload }); },
    }, svg("quiz", 16), label);
  }

  function renderLectureButtons() {
    document.getElementById("sp-lecture-fab")?.remove();
    document.querySelectorAll(".sp-module-quiz").forEach((n) => n.remove());
    if (settings.lectureButtons === false) return;
    const lec = currentLecture();
    if (lec) {
      const fab = quizButton("Practice this lecture", { ...lec, action: "quiz" }, "sp-fab");
      fab.id = "sp-lecture-fab";
      document.body.append(fab);
    }
    const mm = location.pathname.match(/^\/courses\/(\d+)\/modules\/?$/);
    if (mm) {
      document.querySelectorAll(".context_module").forEach((mod) => {
        const name = mod.querySelector(".ig-header-title .name, .ig-header-title")?.textContent.trim();
        const header = mod.querySelector(".ig-header");
        if (!name || !header) return;
        header.append(quizButton("Practice", { courseId: Number(mm[1]), module: name, action: "quiz" }, "sp-module-quiz"));
      });
    }
  }

  // ---------- wiring ----------
  async function loadColors() {
    try {
      const r = await fetch("/api/v1/users/self/colors", { credentials: "include", headers: { Accept: "application/json" } });
      const body = await r.json();
      for (const [k, v] of Object.entries(body.custom_colors || {})) { const m = k.match(/^course_(\d+)$/); if (m) colors[m[1]] = v; }
    } catch { /* colors are optional */ }
  }

  let t;
  const renderAll = () => {
    clearTimeout(t);
    t = setTimeout(() => { renderSidebar(); renderBadges(); renderLectureButtons(); if (expanded) renderExpanded(); }, 120);
  };

  async function init() {
    const data = await chrome.storage.local.get(["settings", "snapshot", "doneIds", "seenGrades"]);
    settings = { dashTodo: true, cardBadges: true, hideDone: true, lectureButtons: true, replaceTodo: true, replaceFeedback: true, ...(data.settings || {}) };
    snapshot = data.snapshot || null;
    doneIds = data.doneIds || [];
    seenGrades = data.seenGrades || [];
    if (!settings.canvasUrl) return;
    if (!snapshot || Date.now() - Date.parse(snapshot.fetched_at) > 30 * 60e3) chrome.runtime.sendMessage({ type: "SYNC" });
    await loadColors();
    renderAll();

    // Canvas draws cards and the sidebar asynchronously (and redraws them); keep ours in place.
    if (isDashboard() || coursePageId()) {
      let pending = false;
      const obs = new MutationObserver(() => {
        if (pending) return;
        const side = document.querySelector("#right-side");
        const needCards = !document.querySelector(".sp-chips") && document.querySelector(".ic-DashboardCard") && settings.cardBadges;
        const needSide = side && ((isDashboard() && settings.dashTodo !== false && !document.getElementById("sp-todo"))
          || (settings.replaceTodo !== false && nativeSection(/^to\s*do$/i) && !nativeSection(/^to\s*do$/i).dataset.spHidden)
          || (settings.replaceFeedback !== false && nativeSection(/^recent feedback$/i) && !nativeSection(/^recent feedback$/i).dataset.spHidden));
        if (needCards || needSide) { pending = true; setTimeout(() => { pending = false; renderAll(); }, 150); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => obs.disconnect(), 60000);
    }
  }

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    if (ch.settings) settings = { ...settings, ...ch.settings.newValue };
    if (ch.snapshot) snapshot = ch.snapshot.newValue;
    if (ch.doneIds) doneIds = ch.doneIds.newValue || [];
    if (ch.seenGrades) seenGrades = ch.seenGrades.newValue || [];
    if (ch.settings || ch.snapshot || ch.doneIds || ch.seenGrades) renderAll();
  });

  init();
})();
