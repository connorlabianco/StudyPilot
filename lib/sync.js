// "Sign in with Google" → everything syncs between computers through ONE file in a private app folder
// in the student's own Google Drive (Drive's appDataFolder: only StudyPilot can see it; it never shows in their Drive).
// Permission used: drive.appdata only (non-sensitive). No StudyPilot server is involved.
import { allQuestions, putQuestions, allQuizzes, putQuizzes, allSessions, putSessions, deleteQuestions, deleteQuiz } from "./quiz.js";

export const SYNC_SCOPES = ["https://www.googleapis.com/auth/drive.appdata"];
const FILE = "studypilot-sync.json";
const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
// Settings that stay on this computer only (secrets and per-device choices).
const LOCAL_ONLY = new Set(["canvasToken", "settingsUpdatedAt"]);
const TOMB_DAYS = 60;

export const oauthReady = () => !chrome.runtime.getManifest().oauth2?.client_id?.startsWith("YOUR_");

// Turns Chrome's sign-in errors into something a student (or the developer) can act on.
export function signInError(e) {
  const m = String(e?.message || e || "");
  const id = chrome.runtime.id;
  if (/not supported/i.test(m)) return "This browser doesn't support Chrome sign-in. Use Google Chrome to sync.";
  if (/bad client id|invalid_client|client id|OAuth2 request failed|redirect_uri/i.test(m))
    return `Google doesn't recognize this copy of StudyPilot (ID ${id}). Sign-in only works in a copy whose ID matches the one registered with Google. (${m})`;
  if (/did not approve|cancel|closed/i.test(m))
    return `Google sign-in didn't finish. If Google showed "Access blocked" or "app not verified", the app is still in testing: add your Google account as a test user, or publish the app (Google Cloud › Audience). (${m})`;
  if (/not signed in|sign in to chrome|turned off|disabled/i.test(m)) return `Sign in to Chrome itself first (the profile button, top right), then try again. (${m})`;
  return `Google sign-in failed: ${m}`;
}

export async function token(interactive) {
  if (!oauthReady()) throw new Error("Google sign-in isn't set up in this copy of StudyPilot yet (see the setup guide).");
  let r;
  try { r = await chrome.identity.getAuthToken({ interactive, scopes: SYNC_SCOPES }); }
  catch (e) {
    if (!interactive) throw new Error("Not signed in.");
    throw new Error(signInError(e));
  }
  const t = typeof r === "string" ? r : r?.token;
  if (!t) throw new Error("Google sign-in was cancelled.");
  return t;
}

async function gfetch(url, opts = {}, retry = true) {
  const t = await token(false);
  const res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${t}`, ...(opts.headers || {}) } });
  if (res.status === 401 && retry) { await chrome.identity.removeCachedAuthToken({ token: t }); return gfetch(url, opts, false); }
  if (!res.ok) throw new Error(`Google Drive error ${res.status}`);
  return res;
}

export async function signIn() {
  await token(true);
  const about = await (await gfetch(`${DRIVE}/about?fields=user(emailAddress,displayName)`)).json().catch(() => ({}));
  const account = { email: about.user?.emailAddress || "", name: about.user?.displayName || "", since: Date.now() };
  await chrome.storage.local.set({ syncAccount: account });
  return account;
}

export async function signOut() {
  try {
    const t = await token(false);
    // Keep Google Calendar working if it's on (revoking would end that too).
    const { gcalEmail, gcalOff } = await chrome.storage.local.get(["gcalEmail", "gcalOff"]);
    if (!gcalEmail || gcalOff) await fetch(`https://oauth2.googleapis.com/revoke?token=${t}`, { method: "POST" }).catch(() => {});
    await chrome.identity.removeCachedAuthToken({ token: t });
  } catch { /* not signed in */ }
  await chrome.storage.local.remove(["syncAccount", "syncState"]);
}

async function findFile() {
  const q = encodeURIComponent(`name='${FILE}'`);
  const r = await (await gfetch(`${DRIVE}/files?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)&pageSize=5`)).json();
  return r.files?.[0] || null;
}
async function download(id) { return (await gfetch(`${DRIVE}/files/${id}?alt=media`)).json().catch(() => null); }
async function upload(id, data) {
  const body = JSON.stringify(data);
  if (id) return (await gfetch(`${UPLOAD}/files/${id}?uploadType=media`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body })).json();
  const boundary = "sp" + Math.random().toString(36).slice(2);
  const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: FILE, parents: ["appDataFolder"] })}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
  return (await gfetch(`${UPLOAD}/files?uploadType=multipart`, { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body: multipart })).json();
}

// ---------- gather / merge / apply ----------
export async function gatherLocal() {
  const st = await chrome.storage.local.get(["settings", "ledger", "gl", "examEdits", "seenGrades", "seenLectures", "syncTombstones", "lectureTopics", "studyLog", "checklists", "itemStats", "week", ...PLAN_KEYS, "syncStamps"]);
  const settings = Object.fromEntries(Object.entries(st.settings || {}).filter(([k]) => !LOCAL_ONLY.has(k)));
  return {
    v: 1,
    settings: { data: settings, at: st.settings?.settingsUpdatedAt || 0 },
    ledger: st.ledger || {},
    gl: st.gl || [],
    examEdits: st.examEdits || {},
    seenGrades: st.seenGrades || [],
    seenLectures: st.seenLectures || [],
    lectureTopics: st.lectureTopics || {},
    checklists: st.checklists || {},
    itemStats: st.itemStats || {},
    week: st.week || null,
    // Study plan and the AI list (the plan and its day carry their own time; the rest are stamped when they change)
    plan: Object.fromEntries(PLAN_KEYS.map((k) => [k, st[k] ?? null])),
    stamps: st.syncStamps || {},
    studyLog: st.studyLog || [],
    questions: Object.fromEntries((await allQuestions()).map((q) => [q.id, q])),
    quizzes: Object.fromEntries((await allQuizzes()).map((z) => [z.id, z])),
    sessions: (await allSessions()).map(({ id, ...x }) => x),
    tombstones: st.syncTombstones || { q: {}, z: {} },
  };
}

// ---------- study plan, AI list, My week ----------
export const PLAN_KEYS = ["plan", "planSelection", "planSizes", "planDone", "planDay", "aiQueue", "aiQueueSkip", "planChat"];
export const STAMPED = ["planSelection", "aiQueue", "planSizes", "planDone", "aiQueueSkip", "planChat"];
// Set while a sync writes, so its own writes aren't stamped as new local changes.
let applyingUntil = 0;
export const isApplying = () => Date.now() < applyingUntil;

/** Pure: My week from two computers. Class times newest per course; study time and picks from the newer copy. */
export function mergeWeek(a, b) {
  if (!a || !b) return a || b || null;
  const base = (b.at || 0) > (a.at || 0) ? b : a;
  const classes = {};
  for (const id of new Set([...Object.keys(a.classes || {}), ...Object.keys(b.classes || {})])) {
    const x = a.classes?.[id], y = b.classes?.[id];
    classes[id] = !x ? y : !y ? x : ((y.at || 0) > (x.at || 0) ? y : x);
  }
  return { ...base, classes };
}
/** Pure: plan pieces from two computers. */
export function mergePlan(a = {}, b = {}, sa = {}, sb = {}) {
  const out = {};
  const by = (k, at) => ((at(b) || 0) > (at(a) || 0) ? b[k] : a[k] ?? b[k] ?? null);
  out.plan = by("plan", (x) => x?.plan?.at);
  out.planDay = by("planDay", (x) => x?.planDay?.at);
  out.planSelection = (sb.planSelection || 0) > (sa.planSelection || 0) ? b.planSelection ?? null : a.planSelection ?? b.planSelection ?? null;
  out.aiQueue = (sb.aiQueue || 0) > (sa.aiQueue || 0) ? b.aiQueue ?? null : a.aiQueue ?? b.aiQueue ?? null;
  out.planChat = (sb.planChat || 0) > (sa.planChat || 0) ? b.planChat ?? null : a.planChat ?? b.planChat ?? null;
  // estimates: newest per assignment; time done: the larger count per piece of work; skipped lectures: both
  out.planSizes = { ...(a.planSizes || {}) };
  for (const [ref, v] of Object.entries(b.planSizes || {})) if (!out.planSizes[ref] || (v.at || 0) > (out.planSizes[ref].at || 0)) out.planSizes[ref] = v;
  const samePlan = (a.plan?.at || 0) === (b.plan?.at || 0);
  out.planDone = samePlan ? { ...(a.planDone || {}) } : { ...((by("plan", (x) => x?.plan?.at) === b.plan ? b.planDone : a.planDone) || {}) };
  if (samePlan) for (const [ref, m] of Object.entries(b.planDone || {})) out.planDone[ref] = Math.max(out.planDone[ref] || 0, m);
  out.aiQueueSkip = [...new Set([...(a.aiQueueSkip || []), ...(b.aiQueueSkip || [])])].slice(-500);
  const stamps = { ...sa };
  for (const [k, v] of Object.entries(sb)) stamps[k] = Math.max(stamps[k] || 0, v);
  return { plan: out, stamps };
}

const t = (x) => x?.updatedAt || x?.last || x?.createdAt || 0;
const newer = (a, b) => (!a ? b : !b ? a : t(b) > t(a) ? b : a);

/** Pure: combines two copies. Newer item wins per question/quiz/course; lists are unioned; deletions win over older copies. */
export function merge(a, b) {
  if (!b) return a;
  if (!a) return b;
  const now = Date.now(), cutoff = now - TOMB_DAYS * 864e5;
  const tomb = { q: {}, z: {} };
  for (const k of ["q", "z"]) for (const src of [a.tombstones?.[k], b.tombstones?.[k]]) for (const [id, at] of Object.entries(src || {})) if (at > cutoff) tomb[k][id] = Math.max(tomb[k][id] || 0, at);
  const byId = (x, y, kind, combine = newer) => {
    const out = {};
    for (const id of new Set([...Object.keys(x || {}), ...Object.keys(y || {})])) {
      const v = combine(x?.[id], y?.[id]);
      if (tomb[kind]?.[id] && tomb[kind][id] >= t(v)) continue;
      out[id] = v;
    }
    return out;
  };
  const quizCombine = (p, q) => {
    if (!p || !q) return p || q;
    const base = newer(p, q);
    const seen = new Set();
    const attempts = [...(p.attempts || []), ...(q.attempts || [])].filter((x) => !seen.has(x.at) && seen.add(x.at)).sort((m, n) => m.at - n.at).slice(-30);
    return { ...base, attempts };
  };
  const ledger = {};
  for (const id of new Set([...Object.keys(a.ledger || {}), ...Object.keys(b.ledger || {})])) {
    const x = a.ledger?.[id], y = b.ledger?.[id];
    ledger[id] = !x ? y : !y ? x : ((y.edited || y.at || 0) > (x.edited || x.at || 0) ? y : x);
  }
  const examEdits = {};
  for (const id of new Set([...Object.keys(a.examEdits || {}), ...Object.keys(b.examEdits || {})])) {
    const x = a.examEdits?.[id], y = b.examEdits?.[id];
    examEdits[id] = !x ? y : !y ? x : ((y.at || 0) > (x.at || 0) ? y : x);
  }
  const lectureTopics = {};
  for (const id of new Set([...Object.keys(a.lectureTopics || {}), ...Object.keys(b.lectureTopics || {})])) {
    const x = a.lectureTopics?.[id], y = b.lectureTopics?.[id];
    lectureTopics[id] = !x ? y : !y ? x : ((y.at || 0) > (x.at || 0) ? y : x);
  }
  // Checklists: newest per lecture. Item history: every answer from both computers, in order.
  const checklists = {};
  for (const id of new Set([...Object.keys(a.checklists || {}), ...Object.keys(b.checklists || {})])) {
    const x = a.checklists?.[id], y = b.checklists?.[id];
    checklists[id] = !x ? y : !y ? x : ((y.at || 0) > (x.at || 0) ? y : x);
  }
  const itemStats = {};
  for (const lk of new Set([...Object.keys(a.itemStats || {}), ...Object.keys(b.itemStats || {})])) {
    const A = a.itemStats?.[lk] || {}, B = b.itemStats?.[lk] || {};
    itemStats[lk] = {};
    for (const it of new Set([...Object.keys(A), ...Object.keys(B)])) {
      const seen = new Map([...(A[it] || []), ...(B[it] || [])].map((r) => [`${r.at}|${r.qid}`, r]));
      itemStats[lk][it] = [...seen.values()].sort((m, n) => m.at - n.at).slice(-12);
    }
  }
  const studyLog = [...new Map([...(a.studyLog || []), ...(b.studyLog || [])].map((r) => [r.id, r])).values()].sort((m, n) => m.at - n.at).slice(-3000);
  const sessKey = (s) => `${s.at}|${s.title}`;
  const sessions = [...new Map([...(a.sessions || []), ...(b.sessions || [])].map((s) => [sessKey(s), s])).values()].sort((m, n) => m.at - n.at).slice(-500);
  const gl = [...new Map([...(a.gl || []), ...(b.gl || [])].map((r) => [r.id, r])).values()];
  return {
    v: 1, updatedAt: now,
    settings: (b.settings?.at || 0) > (a.settings?.at || 0) ? b.settings : a.settings,
    ledger, examEdits, gl, sessions, lectureTopics, studyLog, checklists, itemStats,
    week: mergeWeek(a.week, b.week),
    ...mergePlan(a.plan, b.plan, a.stamps, b.stamps),
    seenLectures: [...new Set([...(a.seenLectures || []), ...(b.seenLectures || [])])].slice(-5000),
    seenGrades: [...new Set([...(a.seenGrades || []), ...(b.seenGrades || [])])].slice(-2000),
    questions: byId(a.questions, b.questions, "q"),
    quizzes: byId(a.quizzes, b.quizzes, "z", quizCombine),
    tombstones: tomb,
  };
}

async function applyLocal(local, merged) {
  // Questions and quizzes: write what changed, remove what was deleted elsewhere.
  const qChanged = Object.values(merged.questions).filter((q) => t(q) !== t(local.questions[q.id]));
  if (qChanged.length) await putQuestions(qChanged, { touch: false });
  const qGone = Object.keys(local.questions).filter((id) => !merged.questions[id]);
  if (qGone.length) await deleteQuestions(qGone);
  const zChanged = Object.values(merged.quizzes).filter((z) => t(z) !== t(local.quizzes[z.id]) || (z.attempts || []).length !== (local.quizzes[z.id]?.attempts || []).length);
  if (zChanged.length) await putQuizzes(zChanged);
  for (const id of Object.keys(local.quizzes).filter((id) => !merged.quizzes[id])) await deleteQuiz(id);
  const have = new Set(local.sessions.map((s) => `${s.at}|${s.title}`));
  const addS = merged.sessions.filter((s) => !have.has(`${s.at}|${s.title}`));
  if (addS.length) await putSessions(addS);

  const { settings: cur = {} } = await chrome.storage.local.get("settings");
  const patch = {
    ledger: merged.ledger, gl: merged.gl, examEdits: merged.examEdits, seenGrades: merged.seenGrades, syncTombstones: merged.tombstones,
    seenLectures: merged.seenLectures, lectureTopics: merged.lectureTopics || {}, studyLog: merged.studyLog || [], checklists: merged.checklists || {}, itemStats: merged.itemStats || {},
  };
  if (merged.week) patch.week = merged.week;
  for (const k of PLAN_KEYS) if (merged.plan?.[k] != null) patch[k] = merged.plan[k];
  if (merged.stamps) patch.syncStamps = merged.stamps;
  applyingUntil = Date.now() + 3000;
  if ((merged.settings?.at || 0) > (cur.settingsUpdatedAt || 0)) {
    const keep = Object.fromEntries(Object.entries(cur).filter(([k]) => LOCAL_ONLY.has(k)));
    patch.settings = { ...cur, ...merged.settings.data, ...keep, settingsUpdatedAt: merged.settings.at };
  }
  await chrome.storage.local.set(patch);
}

let running = null;
export function syncNow() {
  if (running) return running;
  running = (async () => {
    const { syncAccount } = await chrome.storage.local.get("syncAccount");
    if (!syncAccount) return { skipped: "signed out" };
    const local = await gatherLocal();
    const file = await findFile();
    const remote = file ? await download(file.id) : null;
    const merged = merge(local, remote);
    await applyLocal(local, merged);
    await upload(file?.id || null, merged);
    const stats = { at: Date.now(), questions: Object.keys(merged.questions).length, quizzes: Object.keys(merged.quizzes).length };
    await chrome.storage.local.set({ syncState: stats });
    return stats;
  })().finally(() => { running = null; });
  return running;
}
