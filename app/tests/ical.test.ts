import { describe, expect, it } from "vitest";
import { parseIcal, replyIcal, replySubject, zonedTime } from "../src/core/ical";

const INVITE = [
  "BEGIN:VCALENDAR",
  "PRODID:-//Example//Cal//EN",
  "METHOD:REQUEST",
  "BEGIN:VTIMEZONE",
  "TZID:America/New_York",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "DTSTART;TZID=America/New_York:20261021T150000",
  "DTEND;TZID=America/New_York:20261021T160000",
  "UID:abc-123@cal.example",
  "SEQUENCE:2",
  'ORGANIZER;CN="Ana Lima":mailto:ana@cal.example',
  "ATTENDEE;CN=Pat;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:Pat@Example.com",
  "SUMMARY:Planning\\, round two",
  "LOCATION:Room 4",
  "DESCRIPTION:Bring the notes.\\nAnd snacks.",
  "  Folded on.",
  "BEGIN:VALARM",
  "SUMMARY:not this one",
  "END:VALARM",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("calendar invitations", () => {
  it("reads the event: zone-aware times, organizer, attendees, escapes and folded lines", () => {
    const ev = parseIcal(INVITE)!;
    expect(ev.method).toBe("REQUEST");
    expect(ev.summary).toBe("Planning, round two");
    expect(ev.location).toBe("Room 4");
    expect(ev.description).toBe("Bring the notes.\nAnd snacks. Folded on.");
    expect(ev.start?.toISOString()).toBe("2026-10-21T19:00:00.000Z"); // 3 pm EDT
    expect(ev.end?.toISOString()).toBe("2026-10-21T20:00:00.000Z");
    expect(ev.organizer).toEqual({ name: "Ana Lima", email: "ana@cal.example", partstat: undefined });
    expect(ev.attendees[0]).toMatchObject({ email: "pat@example.com", partstat: "NEEDS-ACTION" });
    expect(ev.sequence).toBe(2);
  });

  it("handles UTC, all-day events, Windows zone names and daylight saving", () => {
    expect(parseIcal("BEGIN:VEVENT\nDTSTART:20261101T120000Z\nEND:VEVENT")!.start?.toISOString()).toBe("2026-11-01T12:00:00.000Z");
    const day = parseIcal("BEGIN:VEVENT\nDTSTART;VALUE=DATE:20261224\nDTEND;VALUE=DATE:20261225\nEND:VEVENT")!;
    expect(day.allDay).toBe(true);
    expect(parseIcal('BEGIN:VEVENT\nDTSTART;TZID="Pacific Standard Time":20261215T090000\nEND:VEVENT')!.start?.toISOString()).toBe("2026-12-15T17:00:00.000Z");
    // The day New York springs forward: noon is already daylight time (UTC−4).
    expect(zonedTime(2026, 3, 8, 12, 0, 0, "America/New_York").toISOString()).toBe("2026-03-08T16:00:00.000Z");
  });

  it("answers with an iTIP REPLY the organizer's calendar understands", () => {
    const ev = parseIcal(INVITE)!;
    const r = replyIcal(ev, { name: "Pat Example", email: "pat@example.com" }, "ACCEPTED", new Date("2026-10-20T10:00:00Z"));
    expect(r).toContain("METHOD:REPLY\r\n");
    expect(r).toContain("UID:abc-123@cal.example\r\n");
    expect(r).toContain("SEQUENCE:2\r\n");
    expect(r).toContain('ATTENDEE;CN="Pat Example";PARTSTAT=ACCEPTED:mailto:pat@example.com');
    expect(r).toContain("DTSTART;TZID=America/New_York:20261021T150000");
    expect(r).toContain('ORGANIZER;CN="Ana Lima":mailto:ana@cal.example');
    expect(r).toContain("DTSTAMP:20261020T100000Z");
    expect(r.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    expect(replySubject(ev, "DECLINED")).toBe("Declined: Planning, round two");
  });

  it("ignores text without an event", () => {
    expect(parseIcal("BEGIN:VCALENDAR\nEND:VCALENDAR")).toBeNull();
  });
});

import { buildMime } from "../src/core/mime/build";
import { parseMessage } from "../src/core/mime/parse";

describe("invitations in mail", () => {
  it("keeps a calendar alternative for the event card without listing it as a file", () => {
    const built = buildMime({
      from: { name: "Ana", email: "ana@cal.example" },
      to: [{ name: "", email: "pat@example.com" }],
      subject: "Invitation",
      text: "You're invited.",
      calendar: { method: "REQUEST", text: "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:x\r\nSUMMARY:Café\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n" },
    });
    const raw = new TextDecoder().decode(built.raw);
    expect(raw).toMatch(/multipart\/alternative/);
    expect(raw).toMatch(/text\/calendar; method=REQUEST; charset=UTF-8/);
    const p = parseMessage(built.raw);
    expect(p.text).toContain("You're invited.");
    const cal = p.attachments.find((a) => a.mimeType === "text/calendar")!;
    expect(cal.alternative).toBe(true);
    expect(parseIcal(new TextDecoder().decode(cal.data))!.summary).toBe("Café");
  });
});
