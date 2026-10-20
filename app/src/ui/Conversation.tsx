// An open conversation: toolbar, subject with label chips, messages (collapsed / expanded), attachments,
// per-message actions, details, reply/forward buttons and the inline reply composer.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { headerDate, fullDate, listDate } from "../core/dates";
import { conversationLayout } from "../core/threading";
import { authResults, parseMessage, type ParsedAttachment, type ParsedMessage } from "../core/mime/parse";
import { humanSize } from "../core/bytes";
import { formatAddress } from "../core/addresses";
import { isSystemLabel, chipStyle } from "../core/labels";
import { api, errorText } from "../ipc/api";
import type { MessageRow } from "../ipc/types";
import { act, applyLabels, blockSender, markUnreadFromHere, starMessage, unsubscribe } from "../state/actions";
import { forwardAsAttachment, openCompose, openReply, sendSimple } from "../state/compose";
import { download, downloadAll, downloadName, openInApp } from "../state/files";
import { STAR_TYPES } from "../state/settings";
import {
  closeThread,
  getState,
  labelName,
  loadThread,
  search,
  setSetting,
  stepThread,
  toast,
  ui,
  useMail,
  visibleThreads,
  accountById,
  openDraft,
} from "../state/store";
import { ComposeInline } from "./Compose";
import { Avatar, FileIcon, Icon, IconButton, Menu, anchorOf, useFollowAnchor, type MenuEntry } from "./common";
import { calendarPart, EventCard } from "./EventCard";
import { FilterDialog } from "./FilterDialog";
import { MessageFrame, type FrameState } from "./MessageFrame";
import { LabelAsBody, LabelAsMenu, MoveToMenu, SnoozeMenu } from "./menus";

type Anchor = ReturnType<typeof anchorOf>;

const parsedCache = new Map<string, ParsedMessage>();
async function parsedFor(accountId: string, id: string): Promise<ParsedMessage> {
  const key = `${accountId}:${id}`;
  const hit = parsedCache.get(key);
  if (hit) return hit;
  const p = parseMessage(await api.raw(accountId, id));
  if (parsedCache.size > 200) parsedCache.delete(parsedCache.keys().next().value as string);
  parsedCache.set(key, p);
  return p;
}

export function Conversation({ split }: { split?: boolean }) {
  const ref = useMail((s) => s.route.thread);
  const { detail, loading, error } = useMail((s) => s.thread);
  // Until the messages are here (a few milliseconds from this Mac), the subject from the list row holds the place.
  const placeholder = useMail((s) => (s.thread.detail ? null : (s.list.result?.threads.find((t) => t.threadId === s.route.thread?.threadId)?.subject ?? null)));
  const composes = useMail((s) => s.composes);
  const advanced = useMail((s) => s.settings.advancedToolbar);
  const textLabels = useMail((s) => s.settings.buttonLabels === "text");
  const [expandAll, setExpandAll] = useState<boolean | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ kind: "label" | "move" | "snooze" | "more"; anchor: Anchor } | null>(null);
  const [filter, setFilter] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    setOpen({});
    setExpandAll(null);
  }, [ref?.threadId]);
  if (!ref) return null;
  const msgs = (detail?.messages ?? []).filter((m) => !m.labels.includes("TRASH") || (detail?.messages ?? []).every((x) => x.labels.includes("TRASH")));
  const layout = conversationLayout(
    msgs.map((m) => ({ id: m.id, unread: m.labels.includes("UNREAD"), isDraft: m.labels.includes("DRAFT"), date: m.internalDate })),
    { expandAll: expandAll === true, unfold: !!open.__showall },
  );
  const isOpen = (id: string, def: boolean) => (expandAll === false ? (open[id] ?? false) : (open[id] ?? def));
  const last = msgs.filter((m) => !m.labels.includes("DRAFT")).at(-1);
  const subject = msgs[0]?.subject || "(no subject)";
  const allLabels = [...new Set(msgs.flatMap((m) => m.labels))];
  const chipIds = allLabels.filter((id) => id === "INBOX" || !isSystemLabel(id) || id === "SPAM" || id === "TRASH");
  const list = visibleThreads();
  const idx = list.findIndex((t) => t.threadId === ref.threadId);
  const target = [{ accountId: ref.accountId, threadIds: [ref.threadId] }];
  const inbox = allLabels.includes("INBOX");
  const inline = composes.filter((c) => c.placement === "inline" && c.reply?.threadId === ref.threadId);
  const acct = accountById(ref.accountId);
  const moreItems = (): MenuEntry[] => [
    // Simplified toolbar (the default): Snooze and Label as live in this menu.
    ...(advanced
      ? []
      : ([
          {
            label: "Snooze",
            icon: "schedule",
            run: () => setMenu({ kind: "snooze", anchor: menu?.anchor ?? { x: 0, y: 0 } }),
            keepOpen: true,
            testId: "conv-more-snooze",
          },
          { sep: true },
          {
            label: "Label as",
            icon: "label",
            testId: "conv-more-label",
            subClassName: "label-menu",
            submenu: (close) => <LabelAsBody onClose={close} accountId={ref.accountId} current={[allLabels]} />,
          },
        ] as MenuEntry[])),
    allLabels.includes("IMPORTANT")
      ? { label: "Mark as not important", icon: "label_important_outline", run: () => void act("not-important", target) }
      : { label: "Mark as important", icon: "label_important", run: () => void act("important", target) },
    detail?.muted
      ? { label: "Unmute", icon: "notifications", run: () => void act("unmute", target).then(() => loadThread(ref)) }
      : { label: "Mute", icon: "notifications_off", run: () => void act("mute", target) },
    { label: "Filter messages like these", icon: "filter_alt", run: () => setFilter({ from: last?.fromEmail ?? "" }) },
    {
      label: "Forward all",
      icon: "forward",
      run: () =>
        void forwardAsAttachment(
          ref.accountId,
          msgs.filter((m) => !m.labels.includes("DRAFT")),
        ),
    },
    { label: "Print all", icon: "print", run: () => void printThread(ref.accountId, ref.threadId) },
    ...(detail?.snoozedUntil ? [{ label: "Unsnooze", icon: "alarm_off", run: () => void act("unsnooze", target) }] : []),
    { sep: true },
    advanced
      ? { label: "Switch to simplified toolbar", icon: "sync_alt", run: () => void setSetting("advancedToolbar", false) }
      : { label: "Switch to advanced toolbar", icon: "sync_alt", run: () => void setSetting("advancedToolbar", true) },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }} data-testid="conversation">
      <div className={["toolbar", "conv-toolbar", textLabels ? "text-labels" : ""].join(" ")} role="toolbar" aria-label="Conversation actions">
        {!split && <IconButton icon="arrow_back" label="Back to list" onClick={closeThread} testId="conv-back" />}
        {allLabels.includes("TRASH") ? (
          <IconButton icon="restore_from_trash" label="Move to Inbox" onClick={() => void act("restore", target)} />
        ) : inbox ? (
          <IconButton icon="archive" label="Archive" onClick={() => void act("archive", target)} testId="conv-archive" />
        ) : (
          <IconButton icon="move_to_inbox" label="Move to Inbox" onClick={() => void act("inbox", target)} testId="conv-inbox" />
        )}
        {allLabels.includes("SPAM") ? (
          <IconButton icon="report_off" label="Not spam" onClick={() => void act("not-spam", target)} />
        ) : (
          <IconButton icon="report" label="Report spam" onClick={() => void act("spam", target)} testId="conv-spam" />
        )}
        <IconButton
          icon="delete"
          label="Delete"
          onClick={() => void act(allLabels.includes("TRASH") ? "delete-forever" : "trash", target)}
          testId="conv-delete"
        />
        <span className="sep" />
        <IconButton icon="mark_email_unread" label="Mark as unread" onClick={() => void act("unread", target).then(closeThread)} testId="conv-unread" />
        {advanced && (
          <IconButton icon="schedule" label="Snooze" onClick={(e) => setMenu({ kind: "snooze", anchor: anchorOf(e.currentTarget) })} testId="conv-snooze" />
        )}
        {advanced && <span className="sep" />}
        <IconButton icon="drive_file_move" label="Move to" onClick={(e) => setMenu({ kind: "move", anchor: anchorOf(e.currentTarget) })} testId="conv-move" />
        {advanced && (
          <IconButton icon="label" label="Labels" onClick={(e) => setMenu({ kind: "label", anchor: anchorOf(e.currentTarget) })} testId="conv-label" />
        )}
        <IconButton
          icon="more_vert"
          label="More email options"
          className="tb-more"
          onClick={(e) => setMenu({ kind: "more", anchor: anchorOf(e.currentTarget) })}
          testId="conv-more"
        />
        <div className="grow" />
        {idx >= 0 && (
          <>
            <span className="page-info">
              {idx + 1} of {list.length}
            </span>
            <IconButton icon="chevron_left" label="Newer" className="page-btn" disabled={idx <= 0} onClick={() => stepThread(-1)} testId="conv-newer" />
            <IconButton
              icon="chevron_right"
              label="Older"
              className="page-btn"
              disabled={idx >= list.length - 1}
              onClick={() => stepThread(1)}
              testId="conv-older"
            />
          </>
        )}
      </div>
      {menu?.kind === "more" && <Menu anchor={menu.anchor} items={moreItems()} onClose={() => setMenu(null)} className="icons" />}
      {menu?.kind === "label" && <LabelAsMenu anchor={menu.anchor} onClose={() => setMenu(null)} accountId={ref.accountId} current={[allLabels]} />}
      {menu?.kind === "move" && <MoveToMenu anchor={menu.anchor} onClose={() => setMenu(null)} accountId={ref.accountId} />}
      {menu?.kind === "snooze" && <SnoozeMenu anchor={menu.anchor} onClose={() => setMenu(null)} targets={target} />}
      {filter && <FilterDialog criteria={filter} onClose={() => setFilter(null)} accountId={ref.accountId} />}
      <div className="conv conv-card selectable-off">
        {loading && !detail && <div className="loading-bar" />}
        {!detail && !error && placeholder != null && (
          <div className="conv-head">
            <h2 className="conv-subject" data-testid="conv-subject">
              {placeholder || "(no subject)"}
            </h2>
          </div>
        )}
        {error && <div className="empty">{error}</div>}
        {detail && (
          <>
            <div className="conv-head">
              <h2 className="conv-subject" data-testid="conv-subject">
                {subject}
                {chipIds.map((id) => {
                  const l = (getState().labels[ref.accountId] ?? []).find((x) => x.id === id);
                  return (
                    <span key={id} className="chip-label" style={chipStyle(l?.bg ? { backgroundColor: l.bg, textColor: l.fg ?? "" } : null)}>
                      {labelName(ref.accountId, id)}
                      <span
                        className="chip-x"
                        role="button"
                        aria-label={`Remove label ${labelName(ref.accountId, id)}`}
                        onClick={() => void applyLabels([], [id], { targets: target }).then(() => loadThread(ref))}
                      >
                        {" "}
                        ×
                      </span>
                    </span>
                  );
                })}
              </h2>
              <div className="conv-head-actions">
                <IconButton
                  icon={expandAll ? "unfold_less" : "unfold_more"}
                  label={expandAll ? "Collapse all" : "Expand all"}
                  onClick={() => (setExpandAll(!expandAll), setOpen({}))}
                  testId="expand-all"
                />
                <IconButton icon="print" label="Print all" onClick={() => void printThread(ref.accountId, ref.threadId)} testId="print-all" />
                <IconButton icon="open_in_new" label="In new window" onClick={() => void api.windowOpen("thread", ref, subject)} />
              </div>
            </div>
            {detail.snoozedUntil && (
              <div className="images-banner" style={{ paddingLeft: 72 }}>
                <Icon name="schedule" size={18} /> Snoozed until {fullDate(detail.snoozedUntil)}
              </div>
            )}
            {layout.map((it) =>
              it.kind === "collapsed" ? (
                <div key={`g${it.ids[0]}`} className="collapsed-group">
                  <button
                    onClick={() => setOpen((o) => ({ ...o, ...Object.fromEntries(it.ids.map((id) => [id, false])), __showall: true }))}
                    aria-label={`${it.ids.length} older messages`}
                  >
                    {it.ids.length}
                  </button>
                </div>
              ) : (
                <Message
                  key={it.id}
                  m={msgs.find((x) => x.id === it.id)!}
                  index={msgs.findIndex((x) => x.id === it.id)}
                  expanded={isOpen(it.id, it.expanded)}
                  onToggle={() => setOpen((o) => ({ ...o, [it.id]: !isOpen(it.id, it.expanded) }))}
                  accountId={ref.accountId}
                  onReply={(kind) => last && void openReply(ref.accountId, msgs.find((x) => x.id === it.id) ?? last, kind)}
                />
              ),
            )}
            {inline.map((c) => (
              <ComposeInline key={c.id} c={c} />
            ))}
            {!inline.length && last && (
              <div className="conv-foot">
                <button className="btn outline" onClick={() => void openReply(ref.accountId, last, "reply")} data-testid="reply">
                  <Icon name="reply" /> Reply
                </button>
                {last.to.length + last.cc.length > 1 && (
                  <button className="btn outline" onClick={() => void openReply(ref.accountId, last, "reply-all")} data-testid="reply-all">
                    <Icon name="reply_all" /> Reply all
                  </button>
                )}
                <button className="btn outline" onClick={() => void openReply(ref.accountId, last, "forward")} data-testid="forward">
                  <Icon name="forward" /> Forward
                </button>
              </div>
            )}
            {acct && <span className="sr-only">{acct.email}</span>}
          </>
        )}
      </div>
    </div>
  );
}

async function printThread(accountId: string, threadId: string) {
  await api.windowOpen("print", { accountId, threadId }, "Print");
}

function Message({
  m,
  index,
  expanded,
  onToggle,
  accountId,
  onReply,
}: {
  m: MessageRow;
  index: number;
  expanded: boolean;
  onToggle: () => void;
  accountId: string;
  onReply: (k: "reply" | "reply-all" | "forward") => void;
}) {
  const [parsed, setParsed] = useState<ParsedMessage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [remote, setRemote] = useState(false);
  const [quoted, setQuoted] = useState(false);
  const [frame, setFrame] = useState<FrameState | null>(null);
  const [menu, setMenu] = useState<Anchor | null>(null);
  const [details, setDetails] = useState(false);
  const [trusted, setTrusted] = useState(false);
  const [filter, setFilter] = useState<Record<string, unknown> | null>(null);
  const settings = useMail((s) => s.settings);
  const acct = useMail((s) => s.accounts.find((a) => a.id === accountId));
  const isDraft = m.labels.includes("DRAFT");
  useEffect(() => {
    if (!expanded || parsed) return;
    let live = true;
    parsedFor(accountId, m.id)
      .then((p) => live && setParsed(p))
      .catch((e) => live && setErr(errorText(e)));
    return () => {
      live = false;
    };
  }, [expanded, accountId, m.id]);
  const fromSelf = acct && (m.fromEmail.toLowerCase() === acct.email.toLowerCase() || acct.aliases.some((a) => a.toLowerCase() === m.fromEmail.toLowerCase()));
  const unsubscribed = useMail((s) => s.unsubscribed[accountId] ?? NO_SENDERS);
  const allowRemote = remote || settings.images === "always" || settings.alwaysShowRemoteFrom.includes(m.fromEmail.toLowerCase()) || !!fromSelf;
  const name = m.fromName || m.fromEmail;
  const star = STAR_TYPES.find((s) => s.id === (m.starType ?? "yellow-star"));
  const starred = m.labels.includes("STARRED");
  const toLine = useMemo(() => {
    const me = acct?.email.toLowerCase();
    const names = [...m.to, ...m.cc].map((a) => (a.email.toLowerCase() === me ? "me" : a.name || a.email));
    return names.length ? `to ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` +${names.length - 3}` : ""}` : "to undisclosed recipients";
  }, [m, acct]);
  const items = (): MenuEntry[] => [
    { label: "Reply", icon: "reply", run: () => onReply("reply") },
    ...(m.to.length + m.cc.length > 1 ? [{ label: "Reply all", icon: "reply_all", run: () => onReply("reply-all") }] : []),
    { label: "Forward", icon: "forward", run: () => onReply("forward") },
    { label: "Forward as attachment", icon: "attach_email", run: () => void forwardAsAttachment(accountId, [m]) },
    { sep: true },
    { label: "Filter messages like this", icon: "filter_alt", run: () => setFilter({ from: m.fromEmail }) },
    { label: "Print", icon: "print", run: () => void api.windowOpen("print", { accountId, threadId: m.threadId, messageId: m.id }, "Print") },
    {
      label: "Delete this message",
      icon: "delete",
      run: () => void api.modifyMessages(accountId, [m.id], ["TRASH"], []).then(() => loadThread({ accountId, threadId: m.threadId })),
    },
    ...(!fromSelf ? [{ label: `Block "${name}"`, icon: "block", run: () => void blockSender(accountId, m.fromEmail, name) }] : []),
    { label: "Report spam", icon: "report", run: () => void act("spam", [{ accountId, threadIds: [m.threadId] }]) },
    { label: "Report phishing", icon: "phishing", run: () => void act("phishing", [{ accountId, threadIds: [m.threadId] }]) },
    { sep: true },
    { label: "Show original", icon: "code", run: () => ui({ showOriginal: { accountId, messageId: m.id } }) },
    { label: "Download message", icon: "download", run: () => void downloadEml(accountId, m) },
    { label: "Mark unread from here", icon: "mark_email_unread", run: () => void markUnreadFromHere({ accountId, threadId: m.threadId }, index) },
    ...(m.listUnsubscribe ? [{ label: "Unsubscribe", icon: "unsubscribe", run: () => doUnsubscribe(accountId, m) }] : []),
    { label: "Share…", icon: "ios_share", run: () => void shareMessage(accountId, m) },
  ];
  if (!expanded) {
    return (
      <div className="msg collapsed" onClick={onToggle} data-testid="message-collapsed">
        <div className="msg-avatar">
          <Avatar name={name} email={m.fromEmail} size={40} />
        </div>
        <div>
          <div className="msg-head">
            <div className="msg-from">{isDraft ? <b style={{ color: "#d93025" }}>Draft</b> : <b>{fromSelf ? acct?.name || "me" : name}</b>}</div>
            <span className="msg-time" title={fullDate(m.internalDate)}>
              {m.attachments.length > 0 && <Icon name="attach_file" size={18} />}
              <span className="when-long">{headerDate(m.internalDate)}</span>
              <span className="when-short">{listDate(m.internalDate)}</span>
            </span>
            <span className="msg-actions" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className={["star-btn", starred ? "on" : ""].join(" ")}
                style={{ width: 40, height: 40, justifyContent: "center", alignItems: "center", opacity: 1 }}
                aria-label={starred ? "Starred" : "Not starred"}
                onClick={() =>
                  void starMessage(accountId, m.id, starred ? (m.starType ?? "yellow-star") : null).then(() => loadThread({ accountId, threadId: m.threadId }))
                }
              >
                <Icon name={starred ? (star?.icon ?? "star") : "star"} fill={starred} />
              </button>
            </span>
          </div>
          <div className="msg-snippet">{m.snippet}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="msg" data-testid="message" data-message={m.id}>
      <div className="msg-avatar">
        <Avatar name={name} email={m.fromEmail} size={40} />
      </div>
      <div className="msg-main">
        <div className="msg-head">
          <div style={{ flex: 1, minWidth: 0 }} onClick={onToggle}>
            <div className="msg-from">
              {isDraft ? (
                <b style={{ color: "#d93025" }}>Draft</b>
              ) : (
                <SenderCard accountId={accountId} name={m.fromName} email={m.fromEmail}>
                  <b>{name}</b>
                </SenderCard>
              )}
              {!isDraft && m.fromName && <span className="addr">&lt;{m.fromEmail}&gt;</span>}
              {m.listUnsubscribe && !fromSelf && unsubscribed.includes(m.fromEmail.toLowerCase()) ? (
                <span className="unsubscribed" data-testid="unsubscribed">
                  Unsubscribed
                </span>
              ) : (
                m.listUnsubscribe &&
                !fromSelf && (
                  <button
                    type="button"
                    className="linkbtn"
                    style={{ fontSize: 12, marginLeft: 8, textDecoration: "underline" }}
                    onClick={(e) => (e.stopPropagation(), doUnsubscribe(accountId, m))}
                    data-testid="unsubscribe"
                  >
                    Unsubscribe
                  </button>
                )
              )}
            </div>
            {/* The details box hangs under "to …" inside the message, so it scrolls with it. */}
            <span className="msg-to-wrap">
              <span className="msg-to" onClick={(e) => (e.stopPropagation(), setDetails(!details))} data-testid="msg-details">
                {toLine} <Icon name="arrow_drop_down" size={18} />
              </span>
              {details && parsed && <Details m={m} p={parsed} onClose={() => setDetails(false)} />}
            </span>
          </div>
          <span className="msg-time" title={fullDate(m.internalDate)}>
            {m.attachments.length > 0 && <Icon name="attach_file" size={18} />}
            <span className="when-long">{headerDate(m.internalDate)}</span>
            <span className="when-short">{listDate(m.internalDate)}</span>
          </span>
          <span className="msg-actions">
            <button
              type="button"
              className={["icon-btn", "star-btn", starred ? "on" : ""].join(" ")}
              style={{ opacity: 1, ...(starred && star && star.id !== "yellow-star" ? { color: star.color } : {}) }}
              aria-label={starred ? "Starred" : "Not starred"}
              data-testid="msg-star"
              onClick={() =>
                void starMessage(accountId, m.id, starred ? (m.starType ?? "yellow-star") : null).then(() => loadThread({ accountId, threadId: m.threadId }))
              }
            >
              <Icon name={starred ? (star?.icon ?? "star") : "star"} fill={starred} />
            </button>
            {isDraft ? (
              <IconButton icon="edit" label="Edit draft" onClick={() => void openDraft(accountId, m.draftId ?? m.id, m.threadId)} />
            ) : (
              <IconButton
                icon="reply"
                label="Reply"
                onClick={() => onReply(settings.defaultReply === "reply-all" && m.to.length + m.cc.length > 1 ? "reply-all" : "reply")}
                testId="msg-reply"
              />
            )}
            <IconButton icon="more_vert" label="More message options" onClick={(e) => setMenu(anchorOf(e.currentTarget, "right"))} testId="msg-more" />
          </span>
        </div>
        {menu && <Menu anchor={menu} items={items()} onClose={() => setMenu(null)} className="icons" label="Message options" />}
        {filter && <FilterDialog criteria={filter} onClose={() => setFilter(null)} accountId={accountId} />}
        <div className="msg-body selectable">
          {m.labels.includes("SPAM") && (
            <div className="warn-banner spam" data-testid="spam-banner">
              <Icon name="report" size={20} />
              <span>This message is in Spam. Its links and attachments may not be safe.</span>
              <button onClick={() => void act("not-spam", [{ accountId, threadIds: [m.threadId] }])} data-testid="banner-not-spam">
                Not spam
              </button>
            </div>
          )}
          {parsed && !m.labels.includes("SPAM") && unverified(parsed) && !trusted && (
            <div className="warn-banner" data-testid="auth-banner">
              <Icon name="warning" size={20} />
              <span>
                Check before trusting this message: Courier couldn't confirm it really came from {m.fromEmail.split("@")[1] ?? "its sender"}. Be careful with
                its links and attachments.
              </span>
              <button onClick={() => void act("spam", [{ accountId, threadIds: [m.threadId] }])}>Report spam</button>
              <button onClick={() => setTrusted(true)} data-testid="banner-looks-safe">
                Looks safe
              </button>
            </div>
          )}
          {parsed && calendarPart(parsed.attachments) && <EventCard accountId={accountId} part={calendarPart(parsed.attachments)!} />}
          {frame?.hasRemote && !allowRemote && frame.blocked > 0 && (
            <div className="images-banner" data-testid="images-banner">
              <span>Images in this message are hidden.</span>
              <button onClick={() => setRemote(true)} data-testid="display-images">
                Display images
              </button>
              <button
                onClick={() => {
                  const list = [...new Set([...settings.alwaysShowRemoteFrom, m.fromEmail.toLowerCase()])];
                  void setSetting("alwaysShowRemoteFrom", list);
                  setRemote(true);
                }}
              >
                Always display images from {m.fromEmail}
              </button>
            </div>
          )}
          {err && <div className="error-box">{err}</div>}
          {parsed && <MessageFrame parsed={parsed} allowRemote={allowRemote} showQuoted={quoted} onState={setFrame} />}
          {frame?.quoted && (
            <button
              type="button"
              className="trimmed"
              aria-label={quoted ? "Hide trimmed content" : "Show trimmed content"}
              data-tip={quoted ? "Hide expanded content" : "Show trimmed content"}
              onClick={() => setQuoted(!quoted)}
              data-testid="show-trimmed"
            >
              <Icon name="more_horiz" />
            </button>
          )}
          {parsed && <Attachments items={parsed.attachments.filter((a) => !a.alternative && (!a.inline || !parsed.html?.includes(`cid:${a.contentId}`)))} />}
        </div>
      </div>
    </div>
  );
}

function Details({ m, p, onClose }: { m: MessageRow; p: ParsedMessage; onClose: () => void }) {
  const auth = authResults(p);
  const mailedBy = (p.header("return-path") ?? "").replace(/[<>]/g, "").split("@")[1] ?? "";
  const signedBy = (p.headerAll("dkim-signature")[0]?.match(/\bd=([^;\s]+)/) ?? [])[1] ?? "";
  useEffect(() => {
    const f = () => onClose();
    setTimeout(() => document.addEventListener("mousedown", f), 0);
    return () => document.removeEventListener("mousedown", f);
  }, [onClose]);
  const row = (k: string, v: string) =>
    v ? (
      <>
        <b>{k}:</b>
        <span>{v}</span>
      </>
    ) : null;
  return (
    <div className="details-pop" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} data-testid="details-popup">
      {row("from", p.from.map(formatAddress).join(", ") || m.fromEmail)}
      {row("reply-to", p.replyTo.map(formatAddress).join(", "))}
      {row("to", p.to.map(formatAddress).join(", "))}
      {row("cc", p.cc.map(formatAddress).join(", "))}
      {row("bcc", p.bcc.map(formatAddress).join(", "))}
      {row("date", fullDate(m.internalDate))}
      {row("subject", p.subject)}
      {row("mailed-by", mailedBy)}
      {row("signed-by", signedBy)}
      {row("security", auth.spf || auth.dkim ? `SPF ${auth.spf ?? "—"} · DKIM ${auth.dkim ?? "—"} · DMARC ${auth.dmarc ?? "—"}` : "")}
    </div>
  );
}

/** The sender's domain failed its checks: DMARC failed, or SPF failed with no passing DKIM signature. */
function unverified(p: ParsedMessage): boolean {
  const a = authResults(p);
  return a.dmarc === "FAIL" || (a.spf === "FAIL" && a.dkim !== "PASS");
}

/** Pointing at a sender's name shows who it is, with quick actions (write, copy the address, find their mail). */
function SenderCard({ accountId, name, email, children }: { accountId: string; name: string; email: string; children: React.ReactNode }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const card = useRef<HTMLDivElement>(null);
  // The card follows the name when the conversation scrolls, and goes once the name is out of sight.
  useFollowAnchor(
    card,
    { x: 0, y: 0, el: ref.current ?? undefined },
    (a) => at && setAt({ x: Math.min(a.x, window.innerWidth - 336), y: a.y + (a.h ?? 0) + 6 }),
    () => at && setAt(null),
  );
  const timer = useRef(0);
  const later = (f: () => void, ms: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(f, ms);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const show = () =>
    later(() => {
      const r = ref.current?.getBoundingClientRect();
      if (r) setAt({ x: Math.min(r.left, window.innerWidth - 336), y: r.bottom + 6 });
    }, 450);
  const hide = () => later(() => setAt(null), 250);
  return (
    <span ref={ref} className="sender-hover" onMouseEnter={show} onMouseLeave={hide} data-testid="sender-name">
      {children}
      {at &&
        createPortal(
          <div
            ref={card}
            className="sender-card"
            style={{ left: Math.max(8, at.x), top: at.y }}
            onMouseEnter={() => window.clearTimeout(timer.current)}
            onMouseLeave={hide}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label={name || email}
            data-testid="sender-card"
          >
            <div className="sc-top">
              <Avatar name={name} email={email} size={56} />
              <div className="sc-who">
                <div className="sc-name">{name || email}</div>
                {name && <div className="sc-mail">{email}</div>}
              </div>
            </div>
            <div className="sc-actions">
              <button type="button" className="btn text sm" onClick={() => (setAt(null), void openCompose({ accountId, to: [{ name, email }] }))}>
                <Icon name="mail" size={18} /> Email
              </button>
              <button
                type="button"
                className="btn text sm"
                onClick={() => void navigator.clipboard.writeText(email).then(() => (setAt(null), toast("Address copied.")))}
                data-testid="sender-copy"
              >
                <Icon name="content_copy" size={18} /> Copy address
              </button>
              <button type="button" className="btn text sm" onClick={() => (setAt(null), search(`from:${email}`))} data-testid="sender-find">
                <Icon name="search" size={18} /> Their mail
              </button>
            </div>
          </div>,
          document.body,
        )}
    </span>
  );
}

const NO_SENDERS: string[] = [];

function doUnsubscribe(accountId: string, m: MessageRow) {
  void unsubscribe({
    accountId,
    sender: { name: m.fromName, email: m.fromEmail },
    scope: "list",
    header: m.listUnsubscribe,
    post: m.listUnsubscribePost,
    sendMail: (to, subject, body) => sendSimple(accountId, to, subject, body),
  });
}

async function downloadEml(accountId: string, m: MessageRow) {
  await download(downloadName(m.subject, "eml"), await api.raw(accountId, m.id));
}

/** File ▸ Share…: the open conversation's latest message, as an .eml, through the Share menu. */
export async function shareOpenConversation() {
  const s = getState();
  const d = s.thread.detail;
  if (!s.route.thread || !d) return void toast("Open a conversation to share it.");
  const m = [...d.messages].reverse().find((x) => !x.labels.includes("DRAFT")) ?? d.messages[d.messages.length - 1];
  if (m) await shareMessage(s.route.thread.accountId, m);
}

async function shareMessage(accountId: string, m: MessageRow) {
  const raw = await api.raw(accountId, m.id);
  const path = await api.tempFile(`${(m.subject || "message").replace(/[\\/:*?"<>|]+/g, " ").slice(0, 60)}.eml`, raw);
  await api.share([path], null, window.innerWidth / 2, 120);
}

function Attachments({ items }: { items: ParsedAttachment[] }) {
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  useEffect(() => {
    const t: Record<string, string> = {};
    for (const a of items) if (a.mimeType.startsWith("image/")) t[a.partId] = URL.createObjectURL(new Blob([a.data as BlobPart], { type: a.mimeType }));
    setThumbs(t);
    return () => Object.values(t).forEach((u) => URL.revokeObjectURL(u));
  }, [items]);
  if (!items.length) return null;
  const save = (a: ParsedAttachment) => void download(a.filename, a.data);
  const look = (a: ParsedAttachment) => void openInApp(a.filename, a.data);
  const share = async (a: ParsedAttachment, e: React.MouseEvent) => {
    const p = await api.tempFile(a.filename, a.data);
    await api.share([p], null, e.clientX, e.clientY);
  };
  return (
    <div className="att-area" data-testid="attachments">
      <div className="att-head">
        {items.length === 1 ? "One attachment" : `${items.length} attachments`}
        <span className="light">· {humanSize(items.reduce((n, a) => n + a.size, 0))}</span>
        {items.length > 1 && (
          <IconButton
            icon="download"
            label="Download all attachments"
            className="att-all"
            onClick={() => void downloadAll(items.map((a) => ({ name: a.filename, data: a.data })))}
            testId="att-download-all"
          />
        )}
      </div>
      <div className="att-cards">
        {items.map((a) => (
          <div
            key={a.partId}
            className="att-card"
            role="button"
            tabIndex={0}
            aria-label={`Attachment ${a.filename}, ${humanSize(a.size)}`}
            data-testid="attachment-card"
            draggable
            onDragStart={(e) => {
              e.preventDefault();
              void api.tempFile(a.filename, a.data).then(async (path) => {
                const { startDrag } = await import("@crabnebula/tauri-plugin-drag");
                await startDrag({ item: [path], icon: path }).catch(() => {});
              });
            }}
            onClick={() => look(a)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                look(a);
              }
            }}
          >
            <div className="thumb" style={thumbs[a.partId] ? { backgroundImage: `url(${thumbs[a.partId]})` } : undefined}>
              {!thumbs[a.partId] && <FileIcon mime={a.mimeType} name={a.filename} />}
            </div>
            <div className="meta">
              <FileIcon mime={a.mimeType} name={a.filename} />
              <span>{a.filename}</span>
            </div>
            <div className="hover">
              <span className="name">
                {a.filename} · {humanSize(a.size)}
              </span>
              <IconButton
                icon="download"
                label={`Download ${a.filename}`}
                onClick={(e) => {
                  e.stopPropagation();
                  save(a);
                }}
                testId="att-download"
              />
              <IconButton
                icon="open_in_new"
                label={`Open ${a.filename}`}
                onClick={(e) => {
                  e.stopPropagation();
                  look(a);
                }}
                testId="att-open"
              />
              <IconButton
                icon="ios_share"
                label="Share"
                onClick={(e) => {
                  e.stopPropagation();
                  void share(a, e);
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
