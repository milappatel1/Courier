// Calendar invitations (iCalendar, RFC 5545) and the replies to them (iTIP, RFC 5546). Pure: no DOM, no IPC.

export interface IcalPerson {
  name: string;
  email: string;
  partstat?: string;
}

export interface IcalEvent {
  /** REQUEST (an invitation or an update), CANCEL, REPLY (someone answered), PUBLISH. */
  method: string;
  uid: string;
  sequence: number;
  recurrenceId: string | null;
  summary: string;
  location: string;
  description: string;
  status: string;
  start: Date | null;
  end: Date | null;
  allDay: boolean;
  recurring: boolean;
  organizer: IcalPerson | null;
  attendees: IcalPerson[];
  /** The raw DTSTART / DTEND / ORGANIZER / RECURRENCE-ID lines, copied into a reply as they were. */
  lines: Record<string, string>;
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
  raw: string;
}

/** Lines unfolded (a line starting with a space or tab continues the previous one). */
function unfold(text: string): string[] {
  const out: string[] = [];
  for (const line of text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length) out[out.length - 1] += line.slice(1);
    else if (line) out.push(line);
  }
  return out;
}

function parseProp(line: string): Prop | null {
  // NAME;PARAM=VALUE;PARAM="quoted:value":THE VALUE — the value starts at the first colon outside quotes.
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ":" && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const parts: string[] = [];
  let cur = "";
  quoted = false;
  for (const c of head) {
    if (c === '"') quoted = !quoted;
    if (c === ";" && !quoted) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: parts[0].toUpperCase(), params, value: line.slice(colon + 1), raw: line };
}

const unescape = (v: string) => v.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
export const escapeText = (v: string) => v.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Windows time zone names some calendars send, mapped to IANA ones. */
const WINDOWS_ZONES: Record<string, string> = {
  "Eastern Standard Time": "America/New_York",
  "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Denver",
  "Pacific Standard Time": "America/Los_Angeles",
  "GMT Standard Time": "Europe/London",
  "W. Europe Standard Time": "Europe/Berlin",
  "Romance Standard Time": "Europe/Paris",
  "Central European Standard Time": "Europe/Warsaw",
  "India Standard Time": "Asia/Kolkata",
  "China Standard Time": "Asia/Shanghai",
  "Tokyo Standard Time": "Asia/Tokyo",
  "AUS Eastern Standard Time": "Australia/Sydney",
  UTC: "UTC",
};

/** Milliseconds a time zone is ahead of UTC at instant `t`. */
function zoneOffset(t: number, zone: string): number {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - t;
}

/** A wall-clock time in a zone, as an instant (two passes settle daylight-saving edges). */
export function zonedTime(y: number, mo: number, d: number, h: number, mi: number, s: number, zone: string): Date {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = wall;
  for (let i = 0; i < 2; i++) t = wall - zoneOffset(t, zone);
  return new Date(t);
}

function parseDate(p: Prop | undefined): { date: Date | null; allDay: boolean } {
  if (!p) return { date: null, allDay: false };
  const v = p.value.trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return { date: null, allDay: false };
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  if (m[4] == null || p.params.VALUE === "DATE") return { date: new Date(y, mo - 1, d), allDay: true };
  const [h, mi, s] = [+m[4], +m[5], +(m[6] ?? 0)];
  if (m[7]) return { date: new Date(Date.UTC(y, mo - 1, d, h, mi, s)), allDay: false };
  const tzid = p.params.TZID?.replace(/^\//, "");
  if (tzid) {
    const zone = WINDOWS_ZONES[tzid] ?? tzid;
    try {
      return { date: zonedTime(y, mo, d, h, mi, s, zone), allDay: false };
    } catch {
      // An unknown zone name: read it as local time.
    }
  }
  return { date: new Date(y, mo - 1, d, h, mi, s), allDay: false };
}

function person(p: Prop): IcalPerson {
  return {
    name: p.params.CN ?? "",
    email: p.value
      .replace(/^mailto:/i, "")
      .trim()
      .toLowerCase(),
    partstat: p.params.PARTSTAT?.toUpperCase(),
  };
}

/** The first event of an iCalendar text (an invitation), or null. */
export function parseIcal(text: string): IcalEvent | null {
  const lines = unfold(text);
  let method = "";
  let inEvent = false;
  let depth = 0;
  const props: Prop[] = [];
  for (const line of lines) {
    const p = parseProp(line);
    if (!p) continue;
    if (p.name === "METHOD" && !inEvent) method = p.value.trim().toUpperCase();
    if (p.name === "BEGIN" && p.value.trim().toUpperCase() === "VEVENT") {
      if (props.length) break; // only the first event
      inEvent = true;
      continue;
    }
    if (!inEvent) continue;
    // Skip nested components (alarms).
    if (p.name === "BEGIN") depth++;
    else if (p.name === "END" && depth > 0) depth--;
    else if (p.name === "END") break;
    else if (depth === 0) props.push(p);
  }
  if (!props.length) return null;
  const get = (n: string) => props.find((p) => p.name === n);
  const start = parseDate(get("DTSTART"));
  const end = parseDate(get("DTEND"));
  const lineOf: Record<string, string> = {};
  for (const n of ["DTSTART", "DTEND", "ORGANIZER", "RECURRENCE-ID", "DURATION"]) {
    const p = get(n);
    if (p) lineOf[n] = p.raw;
  }
  return {
    method: method || "PUBLISH",
    uid: get("UID")?.value.trim() ?? "",
    sequence: Number(get("SEQUENCE")?.value ?? 0) || 0,
    recurrenceId: get("RECURRENCE-ID")?.value ?? null,
    summary: unescape(get("SUMMARY")?.value ?? "").trim(),
    location: unescape(get("LOCATION")?.value ?? "").trim(),
    description: unescape(get("DESCRIPTION")?.value ?? "").trim(),
    status: (get("STATUS")?.value ?? "").trim().toUpperCase(),
    start: start.date,
    end: end.date,
    allDay: start.allDay,
    recurring: !!get("RRULE"),
    organizer: get("ORGANIZER") ? person(get("ORGANIZER")!) : null,
    attendees: props.filter((p) => p.name === "ATTENDEE").map(person),
    lines: lineOf,
  };
}

export type Partstat = "ACCEPTED" | "TENTATIVE" | "DECLINED";

/** Fold a content line at 75 octets (RFC 5545 §3.1), continuing with a space. */
function fold(line: string): string {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (bytes + n > 75) {
      out.push(cur);
      cur = " ";
      bytes = 1;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join("\r\n");
}

const stamp = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

/** An iTIP REPLY: my answer to an invitation, for the organizer's calendar to record. */
export function replyIcal(ev: IcalEvent, me: { name: string; email: string }, partstat: Partstat, now = new Date()): string {
  const cn = me.name ? `;CN="${me.name.replace(/"/g, "'")}"` : "";
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//Courier//Courier Mail//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "METHOD:REPLY",
    "BEGIN:VEVENT",
    ...["DTSTART", "DTEND", "DURATION", "RECURRENCE-ID", "ORGANIZER"].filter((n) => ev.lines[n]).map((n) => ev.lines[n]),
    `DTSTAMP:${stamp(now)}`,
    `UID:${ev.uid}`,
    `SEQUENCE:${ev.sequence}`,
    `ATTENDEE${cn};PARTSTAT=${partstat}:mailto:${me.email}`,
    `SUMMARY:${escapeText(ev.summary)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

/** The subject line for a reply, as calendar programs word it. */
export function replySubject(ev: IcalEvent, partstat: Partstat): string {
  const verb = partstat === "ACCEPTED" ? "Accepted" : partstat === "TENTATIVE" ? "Tentative" : "Declined";
  return `${verb}: ${ev.summary || "Invitation"}`;
}

/** "Wed, Oct 21, 3:00 – 4:00 PM", "Wed, Oct 21 (all day)", in the reader's own time zone. */
export function eventWhen(ev: IcalEvent): string {
  if (!ev.start) return "";
  const day = (d: Date) =>
    d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: d.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
    });
  const time = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (ev.allDay) {
    const last = ev.end ? new Date(ev.end.getTime() - 86_400_000) : null;
    return last && last.getTime() > ev.start.getTime() ? `${day(ev.start)} – ${day(last)}` : `${day(ev.start)} (all day)`;
  }
  if (!ev.end) return `${day(ev.start)}, ${time(ev.start)}`;
  const sameDay = ev.start.toDateString() === ev.end.toDateString();
  return sameDay ? `${day(ev.start)}, ${time(ev.start)} – ${time(ev.end)}` : `${day(ev.start)}, ${time(ev.start)} – ${day(ev.end)}, ${time(ev.end)}`;
}
