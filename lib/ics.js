// .ics calendar of Canvas deadlines (imports into Google, Apple or Outlook calendar).
import { openWork } from "./packs.js";

const stamp = (d) => new Date(d).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const esc = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
function fold(line) {
  const out = [];
  while (line.length > 74) { out.push(line.slice(0, 74)); line = " " + line.slice(74); }
  out.push(line);
  return out.join("\r\n");
}

export function deadlinesIcs(snapshot, { now = Date.now() } = {}) {
  const events = openWork(snapshot, { now }).filter((a) => !a.overdue).map((a) => {
    const due = new Date(a.due_at);
    return [
      "BEGIN:VEVENT",
      `UID:canvas-assignment-${a.id}@studypilot`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART:${stamp(due.getTime() - 30 * 60e3)}`,
      `DTEND:${stamp(due)}`,
      `SUMMARY:${esc(`Due: ${a.course}: ${a.name}`)}`,
      `DESCRIPTION:${esc(`${a.points ?? "?"} pts\n${a.url}`)}`,
      `URL:${a.url}`,
      "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-P1D", `DESCRIPTION:${esc(a.name + " due tomorrow")}`, "END:VALARM",
      "END:VEVENT",
    ].map(fold).join("\r\n");
  });
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//StudyPilot//Canvas Deadlines//EN", "CALSCALE:GREGORIAN",
    "X-WR-CALNAME:Canvas deadlines", ...events, "END:VCALENDAR"].join("\r\n") + "\r\n";
}

// Study sessions from a plan (when Google Calendar isn't connected): open the file to add them to any calendar.
export function sessionsIcs(sessions, { now = Date.now() } = {}) {
  const events = sessions.map((s, i) => [
    "BEGIN:VEVENT",
    `UID:studypilot-session-${Date.parse(s.start)}-${i}@studypilot`,
    `DTSTAMP:${stamp(now)}`,
    `DTSTART:${stamp(s.start)}`,
    `DTEND:${stamp(s.end)}`,
    `SUMMARY:${esc(`Study: ${s.title}`)}`,
    s.goal ? `DESCRIPTION:${esc(s.goal)}` : null,
    "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT10M", `DESCRIPTION:${esc(s.title)}`, "END:VALARM",
    "END:VEVENT",
  ].filter(Boolean).map(fold).join("\r\n"));
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//StudyPilot//Study plan//EN", "CALSCALE:GREGORIAN",
    "X-WR-CALNAME:Study plan", ...events, "END:VCALENDAR"].join("\r\n") + "\r\n";
}
