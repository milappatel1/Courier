// Dates as the web client shows them, plus snooze and schedule-send presets. All take `now` for tests.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LONG_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "8:06 PM" */
export function timeOfDay(d: Date): string {
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h % 12 || 12}:${m}\u202f${h < 12 ? "AM" : "PM"}`;
}

/** Thread list date: today → time, this year → "Oct 12", earlier → "10/12/24". */
export function listDate(ms: number, now = new Date()): string {
  const d = new Date(ms);
  if (sameDay(d, now)) return timeOfDay(d);
  if (d.getFullYear() === now.getFullYear()) return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(-2)}`;
}

/** "(9 minutes ago)" part of the conversation header; null once it's more than ~a month old. */
export function relativeAgo(ms: number, now = new Date()): string | null {
  const s = Math.max(0, Math.round((now.getTime() - ms) / 1000));
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const days = Math.floor(h / 24);
  if (days <= 31) return `${days} day${days === 1 ? "" : "s"} ago`;
  return null;
}

/** Conversation header: "8:06 PM (9 minutes ago)", "Fri, Oct 16, 3:04 PM (2 days ago)", "Oct 12, 2024, 3:04 PM". */
export function headerDate(ms: number, now = new Date()): string {
  const d = new Date(ms);
  const rel = relativeAgo(ms, now);
  let base: string;
  if (sameDay(d, now)) base = timeOfDay(d);
  else if (d.getFullYear() === now.getFullYear()) base = `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${timeOfDay(d)}`;
  else base = `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}, ${timeOfDay(d)}`;
  return rel && d.getFullYear() === now.getFullYear() ? `${base} (${rel})` : base;
}

/** Tooltip / print form: "Sun, Oct 18, 2026, 8:06 PM". */
export function fullDate(ms: number): string {
  const d = new Date(ms);
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}, ${timeOfDay(d)}`;
}

/** Quote attribution: "On Sun, Oct 18, 2026 at 8:06 PM". */
export function quoteDate(ms: number): string {
  const d = new Date(ms);
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} at ${timeOfDay(d)}`;
}

/** "Snoozed until Mon, 8:00 AM" style short form. */
export function shortWhen(ms: number, now = new Date()): string {
  const d = new Date(ms);
  const days = Math.round((startOfDay(d).getTime() - startOfDay(now).getTime()) / 86400000);
  if (days === 0) return timeOfDay(d);
  if (days > 0 && days < 7) return `${DAYS[d.getDay()]}, ${timeOfDay(d)}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${timeOfDay(d)}`;
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function at(d: Date, dayOffset: number, hour: number): Date {
  const x = startOfDay(d);
  x.setDate(x.getDate() + dayOffset);
  x.setHours(hour, 0, 0, 0);
  return x;
}

export interface Preset {
  key: string;
  label: string;
  when: Date;
  detail: string; // "Mon, 8:00 AM"
}

/**
 * Snooze presets: Later today (6 PM, while it's before 5 PM), Tomorrow 8 AM, This weekend (Sat 8 AM, Mon–Thu)
 * or Next weekend (Fri–Sun), Next week (next Monday 8 AM; Tuesday when tomorrow is already Monday).
 */
export function snoozePresets(now = new Date()): Preset[] {
  const out: Preset[] = [];
  const dow = now.getDay();
  if (now.getHours() < 17) out.push(preset("later", "Later today", at(now, 0, 18), now));
  out.push(preset("tomorrow", "Tomorrow", at(now, 1, 8), now));
  const toSat = (6 - dow + 7) % 7 || 7;
  if (dow >= 1 && dow <= 4) out.push(preset("weekend", "This weekend", at(now, toSat, 8), now));
  let toMon = (8 - dow) % 7 || 7;
  if (toMon === 1) toMon = 2; // tomorrow is Monday: next week starts on Tuesday's 8 AM
  out.push(preset("nextweek", "Next week", at(now, toMon, 8), now));
  if (dow === 0 || dow === 5 || dow === 6) out.push(preset("nextweekend", "Next weekend", at(now, toSat === 7 && dow === 6 ? 7 : toSat, 8), now));
  return out.sort((a, b) => a.when.getTime() - b.when.getTime());
}

function preset(key: string, label: string, when: Date, now: Date): Preset {
  const days = Math.round((startOfDay(when).getTime() - startOfDay(now).getTime()) / 86400000);
  const detail = days === 0 ? timeOfDay(when) : `${DAYS[when.getDay()]}, ${timeOfDay(when)}`;
  return { key, label, when, detail };
}

/** Schedule-send presets: Tomorrow morning 8 AM, Tomorrow afternoon 1 PM, next Monday morning 8 AM. */
export function schedulePresets(now = new Date()): Preset[] {
  const out: Preset[] = [];
  const tomorrow = at(now, 1, 8);
  out.push({ key: "tm", label: "Tomorrow morning", when: tomorrow, detail: `${MONTHS[tomorrow.getMonth()]} ${tomorrow.getDate()}, ${timeOfDay(tomorrow)}` });
  const ta = at(now, 1, 13);
  out.push({ key: "ta", label: "Tomorrow afternoon", when: ta, detail: `${MONTHS[ta.getMonth()]} ${ta.getDate()}, ${timeOfDay(ta)}` });
  const dow = now.getDay();
  const toMon = (8 - dow) % 7 || 7;
  if (toMon > 1) {
    const mon = at(now, toMon, 8);
    out.push({ key: "mon", label: `${LONG_DAYS[1]} morning`, when: mon, detail: `${MONTHS[mon.getMonth()]} ${mon.getDate()}, ${timeOfDay(mon)}` });
  }
  return out;
}

/** "Oct 19, 8:00 AM" for the scheduled list / toasts. */
export function scheduledWhen(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${timeOfDay(d)}`;
}

export const MONTH_NAMES = MONTHS;
export const DAY_NAMES = DAYS;
