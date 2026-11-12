import { signInError } from "./sync.js";
// Google Calendar via chrome.identity (oauth2.client_id in manifest.json).
// Every event StudyPilot creates is tagged, so it can be replaced or removed without touching your other events.

const API = "https://www.googleapis.com/calendar/v3";
const TAG = "studypilot";

// Calendar access is asked for separately from sign-in/sync (only when the student turns Calendar on).
// Only events: StudyPilot adds, replaces and removes its own (tagged) events and never reads the rest of the calendar.
export const CAL_SCOPES = ["https://www.googleapis.com/auth/calendar.events"];
export async function getToken(interactive) {
  let r;
  try { r = await chrome.identity.getAuthToken({ interactive, scopes: CAL_SCOPES }); }
  catch (e) { throw new Error(interactive ? signInError(e) : "Not connected to Google Calendar."); }
  const token = typeof r === "string" ? r : r?.token;
  if (!token) throw new Error("Google sign-in was cancelled.");
  return token;
}

export async function isConnected() {
  try { await getToken(false); return true; } catch { return false; }
}

export async function connect() {
  await getToken(true);
  return { email: null };
}

export async function disconnect() {
  try {
    const token = await getToken(false);
    await fetch(`https://oauth2.googleapis.com/revoke?token=${token}`, { method: "POST" });
    await chrome.identity.removeCachedAuthToken({ token });
  } catch { /* already disconnected */ }
}

async function gfetch(path, opts = {}, retry = true) {
  const token = await getToken(false).catch(() => { throw new Error("Connect Google Calendar first."); });
  const res = await fetch(API + path, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", ...(opts.headers || {}) },
  });
  if (res.status === 401 && retry) {
    await chrome.identity.removeCachedAuthToken({ token });
    return gfetch(path, opts, false);
  }
  if (!res.ok) throw new Error(`Google Calendar error ${res.status}`);
  return res.status === 204 ? null : res.json();
}

// kind: "session" (study plan) or "deadline" (Canvas due dates). Replaces existing future events of the same kind.
export async function replaceEvents(kind, events, timeZone) {
  await removeEvents(kind);
  let n = 0;
  for (const e of events) {
    await gfetch("/calendars/primary/events", {
      method: "POST",
      body: JSON.stringify({
        summary: e.summary,
        description: (e.description || "") + "\n\nAdded by StudyPilot",
        start: { dateTime: e.start, timeZone },
        end: { dateTime: e.end, timeZone },
        ...(e.location ? { location: e.location } : {}),
        colorId: e.colorId || (kind === "deadline" ? "11" : "9"),
        extendedProperties: { private: { [TAG]: kind } },
        reminders: { useDefault: false, overrides: e.quiet ? [] : kind === "deadline" ? [{ method: "popup", minutes: 1440 }] : [{ method: "popup", minutes: 10 }] },
      }),
    });
    n++;
  }
  return n;
}

export async function removeEvents(kind) {
  const filter = encodeURIComponent(`${TAG}=${kind}`);
  const list = await gfetch(`/calendars/primary/events?privateExtendedProperty=${filter}&timeMin=${encodeURIComponent(new Date().toISOString())}&maxResults=500`);
  for (const ev of list.items || []) await gfetch(`/calendars/primary/events/${ev.id}`, { method: "DELETE" });
  return (list.items || []).length;
}
