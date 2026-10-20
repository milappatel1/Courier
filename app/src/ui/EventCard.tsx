// A calendar invitation shown at the top of its message: what, when, where, who invited you, Yes / Maybe / No
// (an iTIP reply to the organizer), and Add to Calendar (the invitation opens in the Mac's calendar app).
import { useEffect, useState } from "react";
import { eventWhen, parseIcal, replyIcal, replySubject, type IcalEvent, type Partstat } from "../core/ical";
import type { ParsedAttachment } from "../core/mime/parse";
import { buildMime } from "../core/mime/build";
import { api, failureText } from "../ipc/api";
import { openInApp } from "../state/files";
import { accountById, toast } from "../state/store";
import { Icon } from "./common";

/** The calendar part of a message, if it has one. */
export function calendarPart(attachments: ParsedAttachment[]): ParsedAttachment | undefined {
  return attachments.find((a) => /^(text\/calendar|application\/ics)$/i.test(a.mimeType) || /\.ics$/i.test(a.filename));
}

const ANSWERS: { id: Partstat; label: string }[] = [
  { id: "ACCEPTED", label: "Yes" },
  { id: "TENTATIVE", label: "Maybe" },
  { id: "DECLINED", label: "No" },
];

export function EventCard({ accountId, part }: { accountId: string; part: ParsedAttachment }) {
  const [ev, setEv] = useState<IcalEvent | null>(null);
  const [answer, setAnswer] = useState<Partstat | null>(null);
  const [busy, setBusy] = useState(false);
  const acct = accountById(accountId);
  const mine = [acct?.email ?? "", ...(acct?.aliases ?? [])].map((x) => x.toLowerCase()).filter(Boolean);
  useEffect(() => {
    const e = parseIcal(new TextDecoder().decode(part.data));
    setEv(e);
    if (!e) return;
    const me = e.attendees.find((a) => mine.includes(a.email));
    if (me?.partstat && me.partstat !== "NEEDS-ACTION") setAnswer(me.partstat as Partstat);
    void api
      .settings()
      .then((kv) => {
        const saved = (kv as Record<string, unknown>)[`rsvp:${e.uid}`];
        if (typeof saved === "string") setAnswer(saved as Partstat);
      })
      .catch(() => {});
  }, [part]);
  if (!ev) return null;
  const fromMe = !!ev.organizer && mine.includes(ev.organizer.email);
  const canceled = ev.method === "CANCEL" || ev.status === "CANCELLED";
  const canAnswer = ev.method === "REQUEST" && !!ev.organizer && !fromMe && !canceled;
  const replier = ev.method === "REPLY" ? ev.attendees[0] : null;
  const respond = async (p: Partstat) => {
    if (!acct || !ev.organizer || busy) return;
    setBusy(true);
    try {
      const meAtt = ev.attendees.find((a) => mine.includes(a.email));
      const me = { name: acct.name, email: meAtt?.email ?? acct.email };
      const verb = p === "ACCEPTED" ? "accepted" : p === "TENTATIVE" ? "may attend" : "declined";
      const built = buildMime(
        {
          from: { name: acct.name, email: me.email },
          to: [{ name: ev.organizer.name, email: ev.organizer.email }],
          subject: replySubject(ev, p),
          text: `${acct.name || me.email} ${verb}: ${ev.summary}${ev.start ? ` (${eventWhen(ev)})` : ""}`,
          calendar: { method: "REPLY", text: replyIcal(ev, me, p) },
        },
        { includeBcc: true },
      );
      await api.send(accountId, built.raw, { undoMs: 0 });
      await api.setSetting(`rsvp:${ev.uid}`, p);
      setAnswer(p);
      toast(`Reply sent to ${ev.organizer.name || ev.organizer.email}.`);
    } catch (e) {
      toast(failureText(`send your reply`, e));
    } finally {
      setBusy(false);
    }
  };
  const month = ev.start?.toLocaleDateString("en-US", { month: "short" }).toUpperCase() ?? "";
  return (
    <div className={["event-card", canceled ? "canceled" : ""].join(" ")} data-testid="event-card">
      {ev.start && (
        <div className="ev-date" aria-hidden="true">
          <span className="ev-mon">{month}</span>
          <span className="ev-day">{ev.start.getDate()}</span>
          <span className="ev-wd">{ev.start.toLocaleDateString("en-US", { weekday: "short" })}</span>
        </div>
      )}
      <div className="ev-body">
        <div className="ev-title" data-testid="event-title">
          {ev.summary || "Invitation"}
        </div>
        {ev.start && (
          <div className="ev-line" data-testid="event-when">
            <Icon name="schedule" size={18} /> {eventWhen(ev)}
            {ev.recurring ? " · repeats" : ""}
          </div>
        )}
        {ev.location && (
          <div className="ev-line">
            <Icon name="location_on" size={18} /> {ev.location}
          </div>
        )}
        {ev.organizer && !fromMe && (
          <div className="ev-line">
            <Icon name="person" size={18} /> Invited by {ev.organizer.name || ev.organizer.email}
          </div>
        )}
        {canceled && <div className="ev-note">This event was canceled.</div>}
        {replier && (
          <div className="ev-note">
            {replier.name || replier.email}{" "}
            {replier.partstat === "ACCEPTED"
              ? "is going"
              : replier.partstat === "TENTATIVE"
                ? "might go"
                : replier.partstat === "DECLINED"
                  ? "isn't going"
                  : "replied"}
            .
          </div>
        )}
        <div className="ev-actions">
          {canAnswer && (
            <span className="ev-rsvp" role="group" aria-label="Going?">
              <span className="ev-q">Going?</span>
              {ANSWERS.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className={["ev-ans", answer === a.id ? "on" : ""].join(" ")}
                  aria-pressed={answer === a.id}
                  disabled={busy}
                  onClick={() => void respond(a.id)}
                  data-testid={`rsvp-${a.id.toLowerCase()}`}
                >
                  {answer === a.id && <Icon name="check" size={16} />}
                  {a.label}
                </button>
              ))}
            </span>
          )}
          <button type="button" className="btn text sm" onClick={() => void openInApp(part.filename || "invite.ics", part.data)} data-testid="event-add">
            <Icon name="event" size={18} /> {canceled ? "Open in Calendar" : "Add to Calendar"}
          </button>
        </div>
      </div>
    </div>
  );
}
