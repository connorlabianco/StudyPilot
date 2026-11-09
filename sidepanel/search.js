// Search everything: slides (by page), lecture recordings (by time), assignments, announcements, syllabi, exams, your questions.
import { h, $, send, state, toast, courseColor, plural, openCourse, go } from "./core.js";
import { handToAI } from "./aiflow.js";
import { snippet, askPrompt } from "../lib/search.js";
import { icon } from "../lib/icons.js";

// Filters: each groups one or more kinds of result. Always shown, so you can narrow before typing.
const FILTERS = [
  { id: "all", label: "All", kinds: null },
  { id: "lectures", label: "Lectures & modules", kinds: ["Slides", "Page", "Video", "Module"] },
  { id: "assignments", label: "Assignments", kinds: ["Assignment", "Exam"] },
  { id: "announcements", label: "Announcements", kinds: ["Announcement"] },
  { id: "syllabus", label: "Syllabus", kinds: ["Syllabus"] },
  { id: "questions", label: "My questions", kinds: ["Question"] },
];
const inFilter = (r, f) => !f.kinds || f.kinds.includes(r.kind);
const KIND_LABEL = { Module: "Module item", Slides: "Slides", Page: "Page", Video: "Recording", Assignment: "Assignment", Announcement: "Announcement", Syllabus: "Syllabus", Exam: "Exam", Question: "Your question" };
const KIND_ICON = { Module: "folder", Slides: "slides", Page: "file", Video: "play", Assignment: "pen", Announcement: "bell", Syllabus: "book", Exam: "calendar", Question: "quiz" };

export function openSearch(initial = "") {
  const dlg = $("#sheet");
  const S = state.search ||= { q: "", filter: "all", courseId: null, results: [], stats: null };
  S.filter ||= "all";
  const cur = () => FILTERS.find((f) => f.id === S.filter) || FILTERS[0];
  if (initial) S.q = initial;
  const input = h("input", { type: "search", placeholder: "Search slides, recordings, assignments…", "aria-label": "Search everything", value: S.q, autocomplete: "off" });
  const list = h("div", { class: "sr-list", role: "list", "aria-live": "polite" });
  const filters = h("div", { class: "sr-filters" });
  const courseSel = h("select", { "aria-label": "Course", onchange: (e) => { S.courseId = e.target.value ? Number(e.target.value) : null; run(); } },
    h("option", { value: "" }, "All courses"),
    (state.snapshot?.courses || []).filter((c) => !(state.settings.hiddenCourses || []).includes(c.id)).map((c) => h("option", { value: c.id, selected: S.courseId === c.id }, c.code || c.name)));
  const foot = h("div", { class: "sr-foot" });
  let timer = null, seq = 0;

  const drawFilters = () => {
    filters.replaceChildren(...FILTERS.map((f) => {
      const n = S.results.filter((r) => inFilter(r, f)).length;
      return h("button", { class: "chip" + (S.filter === f.id ? " on" : ""), "aria-pressed": S.filter === f.id,
        onclick: () => { S.filter = f.id; drawFilters(); draw(); } }, S.q.trim() ? `${f.label} ${n}` : f.label);
    }));
  };
  const draw = () => {
    const shown = S.results.filter((r) => inFilter(r, cur()));
    if (!S.q.trim()) {
      list.replaceChildren(h("div", { class: "muted sr-empty" }, "Try a concept (", h("i", {}, "bootstrap"), "), a phrase in quotes (", h("i", {}, "\"null hypothesis\""), "), or a word from an announcement."));
    } else if (!shown.length) {
      list.replaceChildren(h("div", { class: "muted sr-empty" }, `Nothing found for “${S.q}”.`));
    } else list.replaceChildren(...shown.map((r) => row(r)));
    const st = S.stats;
    foot.replaceChildren(
      st ? h("small", { class: "hint" }, `Looked inside ${plural(st.docs, "lecture")}${st.syllabi ? `, ${plural(st.syllabi, "syllabus", "syllabi")}` : ""}, plus assignments, announcements and your questions.`) : null,
      st?.unread ? h("button", { class: "btn small soft block", onclick: readAll },
        icon("download", 14), ` Read the other ${plural(st.unread, "module item")} so search can look inside them`) : null,
      S.results.some((r) => r.kind !== "Module") ? h("button", { class: "btn small block", onclick: ask }, icon("spark", 14), " Ask my AI using these results") : null);
  };
  const readAll = async (e) => {
    e.currentTarget.disabled = true;
    toast("Reading your lectures. This can take a few minutes; you can keep using StudyPilot.", { ms: 7000 });
    const ids = (state.snapshot?.courses || []).filter((c) => !(state.settings.hiddenCourses || []).includes(c.id)).map((c) => S.courseId ?? c.id);
    try { await send("LIBRARY_SYNC", { courseIds: [...new Set(ids)] }); } catch (err) { toast(err.message, { error: true, ms: 8000 }); }
    S.stats = null;
    if (dlg.open) { const r = await send("SEARCH", { q: S.q || "x", courseId: S.courseId, limit: 60, fresh: true }); if (S.q.trim()) S.results = r.results; S.stats = r.stats; drawFilters(); draw(); }
  };
  const row = (r) => {
    const open = () => {
      if (r.kind === "Question") { dlg.close(); go("practice"); return; }
      if (r.kind === "Module" && r.courseId) { dlg.close(); openCourse(r.courseId, "lectures"); return; }
      if (r.url) window.open(r.url, "_blank");
      else if (r.courseId) { dlg.close(); openCourse(r.courseId, r.kind === "Slides" || r.kind === "Page" || r.kind === "Video" ? "lectures" : "overview"); }
    };
    return h("button", { class: "sr-item", role: "listitem", onclick: open },
      h("span", { class: "sr-ico", style: `color:${courseColor(r.courseId)}` }, icon(KIND_ICON[r.kind] || "file", 16)),
      h("span", { class: "grow" },
        h("b", {}, r.title), h("small", { class: "sr-where" }, [r.course, KIND_LABEL[r.kind], r.where].filter(Boolean).join(" · ")),
        h("span", { class: "sr-snip" }, snippet(r.text, S.q).map((p) => p.hit ? h("mark", {}, p.t) : p.t))));
  };
  const run = async () => {
    const my = ++seq;
    if (!S.q.trim()) { S.results = []; drawFilters(); draw(); return; }
    list.classList.add("busy");
    try {
      const r = await send("SEARCH", { q: S.q, courseId: S.courseId, limit: 60 });
      if (my !== seq) return;
      S.results = r.results; S.stats = r.stats;
    } catch (e) { toast(e.message, { error: true }); }
    finally { list.classList.remove("busy"); }
    drawFilters(); draw();
  };
  const ask = async () => {
    const top = S.results.filter((r) => inFilter(r, cur()) && r.kind !== "Module").slice(0, 10);
    dlg.close();
    await handToAI(askPrompt(S.q, top), { title: `Search: ${S.q}` });
  };
  input.addEventListener("input", () => { S.q = input.value; clearTimeout(timer); timer = setTimeout(run, 220); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { clearTimeout(timer); run(); } });

  dlg.replaceChildren(h("div", { class: "sheet-in search" },
    h("div", { class: "sheet-head" }, h("span", { class: "sr-glass" }, icon("search", 18)), input,
      h("button", { class: "ghost", "aria-label": "Close", onclick: () => dlg.close() }, icon("close", 18))),
    h("div", { class: "sr-bar" }, filters, courseSel),
    list, foot));
  if (!dlg.open) dlg.showModal();
  input.focus(); input.select();
  drawFilters(); draw();
  if (S.q.trim()) run();
}

// "/" anywhere in the panel opens search (not while typing).
document.addEventListener("keydown", (e) => {
  if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
  if (!$("#runner").hidden || $("#sheet").open) return;
  e.preventDefault(); openSearch();
});
