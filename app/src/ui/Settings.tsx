// Settings ("See all settings"): General, Labels, Inbox, Accounts, Filters and blocked addresses,
// Forwarding and POP/IMAP, Advanced, Offline, Themes.
import { useEffect, useRef, useState } from "react";
import { describeActions, describeCriteria, type FilterAction, type FilterCriteria } from "../core/search/advanced";
import { exportFiltersXml, importedAction, importFiltersXml, type FilterActionLike, type FilterCriteriaLike, type ImportedFilter } from "../core/filtersxml";
import { download } from "../state/files";
import { leafName } from "../core/labels";
import { api, errorText } from "../ipc/api";
import type { Account, ImapAccountConfig, Label, Signature } from "../ipc/types";
import { DEFAULTS, FONTS, SIZES, STAR_TYPES, SWIPE_ACTIONS, type Settings as S, type SwipeAction } from "../state/settings";
import {
  closeSettings,
  labelsFor,
  loadAccounts,
  loadLabels,
  openSettings,
  setAccount,
  setSetting,
  toast,
  ui,
  useMail,
  SYSTEM_DISPLAY,
  labelName,
  NO_LABELS,
  SYNC_TEXT,
} from "../state/store";
import { themeById } from "../state/themes";
import { Avatar, Icon } from "./common";
import { FilterDialog } from "./FilterDialog";

const TABS: [string, string][] = [
  ["general", "General"],
  ["labels", "Labels"],
  ["inbox", "Inbox"],
  ["accounts", "Accounts"],
  ["filters", "Filters and Blocked Addresses"],
  ["fwdandpop", "Forwarding and POP/IMAP"],
  ["advanced", "Advanced"],
  ["offline", "Offline"],
  ["themes", "Themes"],
];

export function SettingsPage() {
  const tab = useMail((s) => s.route.settings) ?? "general";
  const accountId = useMail((s) => s.accountId);
  const accounts = useMail((s) => s.accounts);
  const acctId = accountId === "all" ? (accounts[0]?.id ?? "") : accountId;
  return (
    <div className="settings" data-testid="settings">
      <div style={{ display: "flex", alignItems: "center" }}>
        <div className="settings-title">Settings</div>
        <span style={{ flex: 1 }} />
        {accounts.length > 1 && (
          <select
            value={acctId}
            onChange={(e) => void setAccount(e.target.value).then(() => openSettings(tab))}
            style={{ marginRight: 16 }}
            aria-label="Account for these settings"
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.email}
              </option>
            ))}
          </select>
        )}
        <button className="btn text" onClick={closeSettings} style={{ marginRight: 16 }} data-testid="settings-close">
          <Icon name="close" /> Close
        </button>
      </div>
      <div className="settings-tabs" role="tablist">
        {TABS.map(([id, name]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={["settings-tab", tab === id ? "on" : ""].join(" ")}
            onClick={() => openSettings(id)}
            data-testid={`settings-tab-${id}`}
          >
            {name}
          </button>
        ))}
      </div>
      <div className="settings-body">
        {tab === "general" && <General accountId={acctId} />}
        {tab === "labels" && <LabelsTab accountId={acctId} />}
        {tab === "inbox" && <InboxTab />}
        {tab === "accounts" && <AccountsTab />}
        {tab === "filters" && <FiltersTab accountId={acctId} />}
        {tab === "fwdandpop" && <ForwardingTab accountId={acctId} />}
        {tab === "advanced" && <AdvancedTab />}
        {tab === "offline" && <OfflineTab />}
        {tab === "themes" && <ThemesTab />}
      </div>
    </div>
  );
}

/** A draft copy of the settings that "Save Changes" applies. */
function useDraft() {
  const settings = useMail((s) => s.settings);
  const [d, setD] = useState<S>(settings);
  useEffect(() => setD(settings), [settings]);
  const set = <K extends keyof S>(k: K, v: S[K]) => setD((x) => ({ ...x, [k]: v }));
  const dirty = (Object.keys(d) as (keyof S)[]).some((k) => JSON.stringify(d[k]) !== JSON.stringify(settings[k]));
  const save = async () => {
    for (const k of Object.keys(d) as (keyof S)[]) if (JSON.stringify(d[k]) !== JSON.stringify(settings[k])) await setSetting(k, d[k]);
    toast("Your preferences have been saved.");
  };
  return { d, set, dirty, save, reset: () => setD(settings) };
}

function SaveBar({ dirty, save, reset, extra }: { dirty: boolean; save: () => void; reset: () => void; extra?: () => Promise<void> }) {
  return (
    <div className="settings-actions">
      <button className="btn filled" disabled={!dirty && !extra} onClick={() => void Promise.resolve(save()).then(() => extra?.())} data-testid="settings-save">
        Save Changes
      </button>
      <button className="btn outline" onClick={reset}>
        Cancel
      </button>
    </div>
  );
}

const Row = ({ k, small, children }: { k: string; small?: React.ReactNode; children: React.ReactNode }) => (
  <div className="srow">
    <div className="k">
      {k}
      {small && <small>{small}</small>}
    </div>
    <div className="v">{children}</div>
  </div>
);

function Radio<T extends string | boolean | number>({
  name,
  value,
  cur,
  onPick,
  label,
  desc,
  test,
}: {
  name: string;
  value: T;
  cur: T;
  onPick: (v: T) => void;
  label: string;
  desc?: string;
  test?: string;
}) {
  return (
    <label className="opt">
      <input type="radio" name={name} checked={cur === value} onChange={() => onPick(value)} data-testid={test} />
      <span>
        <b>{label}</b>
        {desc && <span className="desc"> - {desc}</span>}
      </span>
    </label>
  );
}

// ---- General ----

function General({ accountId }: { accountId: string }) {
  const { d, set, dirty, save, reset } = useDraft();
  const acct = useMail((s) => s.accounts.find((a) => a.id === accountId));
  const labels = useMail((s) => s.labels[accountId] ?? NO_LABELS);
  const vacation = useRef<{ save: () => Promise<void> } | null>(null);
  return (
    <>
      <Row k="Language:">
        Display language:{" "}
        <select value={d.language} onChange={(e) => set("language", e.target.value)} aria-label="Display language">
          <option value="en">English (US)</option>
          <option value="en-GB">English (UK)</option>
        </select>
      </Row>
      <Row k="Maximum page size:">
        Show{" "}
        <select value={d.pageSize} onChange={(e) => set("pageSize", Number(e.target.value))} data-testid="page-size">
          {[10, 15, 20, 25, 50, 100].map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>{" "}
        conversations per page
      </Row>
      <Row k="Undo Send:">
        Send cancellation period:{" "}
        <select value={d.undoSendSeconds} onChange={(e) => set("undoSendSeconds", Number(e.target.value))} data-testid="undo-seconds">
          {[5, 10, 20, 30].map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>{" "}
        seconds
      </Row>
      <Row k="Default reply behavior:">
        <Radio name="reply" value="reply" cur={d.defaultReply} onPick={(v) => set("defaultReply", v)} label="Reply" />
        <Radio name="reply" value="reply-all" cur={d.defaultReply} onPick={(v) => set("defaultReply", v)} label="Reply all" />
      </Row>
      <Row k="Hover actions:">
        <Radio
          name="hover"
          value={true}
          cur={d.hoverActions}
          onPick={(v) => set("hoverActions", v)}
          label="Enable hover actions"
          desc="Archive, delete, mark as read and snooze appear when you point at a conversation."
        />
        <Radio name="hover" value={false} cur={d.hoverActions} onPick={(v) => set("hoverActions", v)} label="Disable hover actions" />
      </Row>
      <Row k="Swipe actions:" small="(two fingers across a conversation in the list; None leaves that direction for going back and forward)">
        <label className="opt">
          Swipe right:{" "}
          <select value={d.swipeRight} onChange={(e) => set("swipeRight", e.target.value as SwipeAction)} aria-label="Swipe right" data-testid="swipe-right">
            {SWIPE_ACTIONS.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </label>{" "}
        <label className="opt">
          Swipe left:{" "}
          <select value={d.swipeLeft} onChange={(e) => set("swipeLeft", e.target.value as SwipeAction)} aria-label="Swipe left" data-testid="swipe-left">
            {SWIPE_ACTIONS.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
      </Row>
      <Row k="Send and Archive:">
        <Radio name="sa" value={true} cur={d.sendAndArchive} onPick={(v) => set("sendAndArchive", v)} label='Show "Send & Archive" button in reply' />
        <Radio name="sa" value={false} cur={d.sendAndArchive} onPick={(v) => set("sendAndArchive", v)} label='Hide "Send & Archive" button in reply' />
      </Row>
      <Row k="Default text style:" small="(Remove formatting resets text to this style)">
        <select value={d.defaultFont.family} onChange={(e) => set("defaultFont", { ...d.defaultFont, family: e.target.value })} aria-label="Font">
          {Object.entries(FONTS).map(([k, f]) => (
            <option key={k} value={k}>
              {f.label}
            </option>
          ))}
        </select>{" "}
        <select
          value={d.defaultFont.size}
          onChange={(e) => set("defaultFont", { ...d.defaultFont, size: e.target.value as S["defaultFont"]["size"] })}
          aria-label="Size"
        >
          {Object.entries(SIZES).map(([k, s]) => (
            <option key={k} value={k}>
              {s.label}
            </option>
          ))}
        </select>{" "}
        <input
          type="color"
          value={d.defaultFont.color}
          onChange={(e) => set("defaultFont", { ...d.defaultFont, color: e.target.value })}
          aria-label="Text color"
        />
        <div style={{ marginTop: 8, fontFamily: FONTS[d.defaultFont.family]?.css, fontSize: SIZES[d.defaultFont.size]?.css, color: d.defaultFont.color }}>
          This is what your body text will look like.
        </div>
      </Row>
      <Row k="Images:">
        <Radio name="img" value="always" cur={d.images} onPick={(v) => set("images", v)} label="Show images in messages" />
        <Radio
          name="img"
          value="ask"
          cur={d.images}
          onPick={(v) => set("images", v)}
          label="Ask before showing images from the web"
          desc="Remote images can tell senders when you read their mail."
          test="images-ask"
        />
      </Row>
      <Row k="Conversation View:" small="(group emails on the same topic together)">
        <Radio name="cv" value={true} cur={d.conversationView} onPick={(v) => set("conversationView", v)} label="Group replies into conversations" />
        <Radio
          name="cv"
          value={false}
          cur={d.conversationView}
          onPick={(v) => set("conversationView", v)}
          label="Show every message on its own"
          test="conversation-off"
        />
      </Row>
      <Row k="Stars:" small="Click stars to move them between the lists. They rotate in this order when you click a star repeatedly.">
        <div style={{ marginBottom: 6 }}>
          Presets:{" "}
          <button className="linkbtn" onClick={() => set("stars", ["yellow-star"])}>
            1 star
          </button>{" "}
          ·{" "}
          <button className="linkbtn" onClick={() => set("stars", ["yellow-star", "red-bang", "blue-info", "green-check"])}>
            4 stars
          </button>{" "}
          ·{" "}
          <button
            className="linkbtn"
            onClick={() =>
              set(
                "stars",
                STAR_TYPES.map((s) => s.id),
              )
            }
            data-testid="stars-all"
          >
            all stars
          </button>
        </div>
        <div>In use:</div>
        <div className="star-pick">
          {d.stars.map((id) => {
            const s = STAR_TYPES.find((x) => x.id === id)!;
            return (
              <button
                key={id}
                title={`${s.label} (has:${s.id})`}
                onClick={() =>
                  set(
                    "stars",
                    d.stars.filter((x) => x !== id),
                  )
                }
              >
                <Icon name={s.icon} fill={s.fill} style={{ color: s.color }} />
              </button>
            );
          })}
        </div>
        <div style={{ marginTop: 6 }}>Not in use:</div>
        <div className="star-pick">
          {STAR_TYPES.filter((s) => !d.stars.includes(s.id)).map((s) => (
            <button key={s.id} title={`${s.label} (has:${s.id})`} onClick={() => set("stars", [...d.stars, s.id])}>
              <Icon name={s.icon} fill={s.fill} style={{ color: s.color }} />
            </button>
          ))}
        </div>
      </Row>
      <Row k="Desktop notifications:" small="(new mail alerts from macOS Notification Center)">
        <Radio
          name="nt"
          value="all"
          cur={d.notifications.mode}
          onPick={(v) => set("notifications", { ...d.notifications, mode: v })}
          label="Every new message"
          desc="An alert for each new message in the Inbox (in Primary when tabs are on)."
        />
        <Radio
          name="nt"
          value="important"
          cur={d.notifications.mode}
          onPick={(v) => set("notifications", { ...d.notifications, mode: v })}
          label="Important messages only"
          desc="An alert only for mail marked important."
        />
        <Radio name="nt" value="off" cur={d.notifications.mode} onPick={(v) => set("notifications", { ...d.notifications, mode: v })} label="No alerts" />
        {acct && (
          <div style={{ marginTop: 8 }}>
            <label className="opt">
              <input
                type="checkbox"
                checked={d.notifications.accounts[acct.id] !== false}
                onChange={(e) => set("notifications", { ...d.notifications, accounts: { ...d.notifications.accounts, [acct.id]: e.target.checked } })}
              />
              <span>Notify for {acct.email}</span>
            </label>
            {labels.filter((l) => l.type === "user").length > 0 && (
              <div style={{ marginTop: 6 }}>
                Also notify for labels:
                {labels
                  .filter((l) => l.type === "user")
                  .map((l) => (
                    <label key={l.id} className="opt" style={{ marginLeft: 16 }}>
                      <input
                        type="checkbox"
                        checked={!!d.notifications.labels[acct.id]?.[l.id]}
                        onChange={(e) =>
                          set("notifications", {
                            ...d.notifications,
                            labels: { ...d.notifications.labels, [acct.id]: { ...(d.notifications.labels[acct.id] ?? {}), [l.id]: e.target.checked } },
                          })
                        }
                      />
                      <span>{l.name}</span>
                    </label>
                  ))}
              </div>
            )}
          </div>
        )}
      </Row>
      <Row k="Keyboard shortcuts:">
        <Radio name="ks" value={false} cur={d.keyboardShortcuts} onPick={(v) => set("keyboardShortcuts", v)} label="Keyboard shortcuts off" />
        <Radio name="ks" value={true} cur={d.keyboardShortcuts} onPick={(v) => set("keyboardShortcuts", v)} label="Keyboard shortcuts on" />
      </Row>
      <Row k="Button labels:">
        <Radio name="bl" value="icons" cur={d.buttonLabels} onPick={(v) => set("buttonLabels", v)} label="Icons" />
        <Radio name="bl" value="text" cur={d.buttonLabels} onPick={(v) => set("buttonLabels", v)} label="Text" />
      </Row>
      <Row k="Create contacts for auto-complete:">
        <Radio
          name="ac"
          value={true}
          cur={d.autoContacts}
          onPick={(v) => set("autoContacts", v)}
          label="Remember new people I write to, so their addresses complete as I type"
        />
        <Radio name="ac" value={false} cur={d.autoContacts} onPick={(v) => set("autoContacts", v)} label="Only suggest people I've added" />
      </Row>
      {acct && <SignaturesRow account={acct} />}
      <Row k="Personal level indicators:">
        <Radio name="pi" value={false} cur={d.personalIndicators} onPick={(v) => set("personalIndicators", v)} label="No markers" />
        <Radio
          name="pi"
          value={true}
          cur={d.personalIndicators}
          onPick={(v) => set("personalIndicators", v)}
          label="Show who it was sent to"
          desc="› marks mail addressed to me (not a list); » marks mail sent to me alone."
        />
      </Row>
      <Row k="Snippets:">
        <Radio
          name="sn"
          value={true}
          cur={d.snippets}
          onPick={(v) => set("snippets", v)}
          label="Show snippets"
          desc="A line of each message after its subject."
        />
        <Radio name="sn" value={false} cur={d.snippets} onPick={(v) => set("snippets", v)} label="No snippets" desc="Subjects alone." />
      </Row>
      {acct && <VacationRow account={acct} ctl={vacation} />}
      <SaveBar dirty={dirty} save={save} reset={reset} extra={() => vacation.current?.save() ?? Promise.resolve()} />
    </>
  );
}

function SignaturesRow({ account }: { account: Account }) {
  const [sigs, setSigs] = useState<Signature[]>([]);
  const [edit, setEdit] = useState<Signature | null>(null);
  const [defaults, setDefaults] = useState<{ newMail: string | null; replies: string | null }>({ newMail: null, replies: null });
  const editor = useRef<HTMLDivElement>(null);
  const load = () => void api.signatures(account.id).then(setSigs);
  useEffect(() => {
    load();
    void api.settings().then((all) => {
      const d = (all[`sigDefaults:${account.id}`] as Record<string, { newMail: string | null; replies: string | null }> | undefined)?.[account.email];
      if (d) setDefaults(d);
    });
  }, [account.id]);
  useEffect(() => {
    if (editor.current && edit) editor.current.innerHTML = edit.html;
  }, [edit?.id]);
  const saveSig = async () => {
    if (!edit) return;
    const id = await api.signatureSave({ id: edit.id || null, accountId: account.id, name: edit.name, html: editor.current?.innerHTML ?? edit.html });
    setEdit(null);
    load();
    return id;
  };
  const saveDefaults = async (d: typeof defaults) => {
    setDefaults(d);
    await api.signatureDefaults(account.id, account.email, d.newMail, d.replies).catch((e) => toast(errorText(e)));
  };
  return (
    <Row k="Signature:" small="(added at the end of outgoing messages)">
      {!sigs.length && !edit && <div>No signatures</div>}
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        <div style={{ minWidth: 160 }}>
          {sigs.map((s) => (
            <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button className="linkbtn" onClick={() => setEdit(s)}>
                {s.name}
              </button>
              <button className="linkbtn" aria-label={`Delete ${s.name}`} onClick={() => void api.signatureDelete(s.id).then(load)}>
                <Icon name="delete" size={16} />
              </button>
            </div>
          ))}
          <button
            className="btn outline sm"
            style={{ marginTop: 8 }}
            onClick={() => setEdit({ id: "", name: `Signature ${sigs.length + 1}`, html: "" })}
            data-testid="sig-new"
          >
            <Icon name="add" /> Create new
          </button>
        </div>
        {edit && (
          <div style={{ flex: 1 }}>
            <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} aria-label="Signature name" data-testid="sig-name" />
            <div
              ref={editor}
              className="editor selectable"
              contentEditable
              suppressContentEditableWarning
              style={{ border: "1px solid var(--input-border)", borderRadius: 4, minHeight: 80, padding: 8, marginTop: 6 }}
              data-testid="sig-editor"
            />
            <button className="btn filled sm" style={{ marginTop: 6 }} onClick={() => void saveSig()} data-testid="sig-save">
              Save signature
            </button>
          </div>
        )}
      </div>
      {sigs.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <b>Signature defaults</b> for {account.email}: For new emails use{" "}
          <select
            value={defaults.newMail ?? ""}
            onChange={(e) => void saveDefaults({ ...defaults, newMail: e.target.value || null })}
            data-testid="sig-default-new"
          >
            <option value="">No signature</option>
            {sigs.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>{" "}
          On reply/forward use{" "}
          <select
            value={defaults.replies ?? ""}
            onChange={(e) => void saveDefaults({ ...defaults, replies: e.target.value || null })}
            data-testid="sig-default-reply"
          >
            <option value="">No signature</option>
            {sigs.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      )}
    </Row>
  );
}

interface Vacation {
  enableAutoReply: boolean;
  responseSubject: string;
  responseBodyHtml?: string;
  responseBodyPlainText?: string;
  restrictToContacts: boolean;
  restrictToDomain?: boolean;
  startTime?: string;
  endTime?: string;
}

function VacationRow({ account, ctl }: { account: Account; ctl: React.MutableRefObject<{ save: () => Promise<void> } | null> }) {
  const [v, setV] = useState<Vacation | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (account.kind !== "gmail") return;
    void api
      .serverSettings<Vacation>(account.id, "vacation")
      .then(setV)
      .catch((e) => setErr(errorText(e)));
  }, [account.id]);
  ctl.current = {
    save: async () => {
      if (!v || account.kind !== "gmail") return;
      await api.setServerSettings(account.id, "vacation", v).catch((e) => toast(errorText(e)));
    },
  };
  const day = (ms?: string) => (ms ? new Date(Number(ms)).toISOString().slice(0, 10) : "");
  return (
    <Row k="Vacation responder:" small="(sends an automatic reply to incoming messages, at most once every 4 days per sender)">
      {account.kind !== "gmail" ? (
        <span className="desc">Your provider manages automatic replies for {account.email}; set them up in its own settings.</span>
      ) : err ? (
        <span className="desc">{err}</span>
      ) : !v ? (
        "Loading…"
      ) : (
        <>
          <Radio name="vr" value={false} cur={v.enableAutoReply} onPick={(x) => setV({ ...v, enableAutoReply: x })} label="Vacation responder off" />
          <Radio
            name="vr"
            value={true}
            cur={v.enableAutoReply}
            onPick={(x) => setV({ ...v, enableAutoReply: x })}
            label="Vacation responder on"
            test="vacation-on"
          />
          <div style={{ display: "grid", gridTemplateColumns: "100px 1fr", gap: 6, marginTop: 8, alignItems: "center" }}>
            <span>First day:</span>
            <input
              type="date"
              value={day(v.startTime)}
              onChange={(e) => setV({ ...v, startTime: e.target.value ? String(new Date(e.target.value).getTime()) : undefined })}
            />
            <span>Last day:</span>
            <input
              type="date"
              value={day(v.endTime)}
              onChange={(e) => setV({ ...v, endTime: e.target.value ? String(new Date(e.target.value).getTime() + 86399000) : undefined })}
            />
            <span>Subject:</span>
            <input type="text" value={v.responseSubject} onChange={(e) => setV({ ...v, responseSubject: e.target.value })} data-testid="vacation-subject" />
            <span>Message:</span>
            <textarea
              value={v.responseBodyPlainText ?? (v.responseBodyHtml ?? "").replace(/<[^>]+>/g, "")}
              onChange={(e) => setV({ ...v, responseBodyPlainText: e.target.value, responseBodyHtml: undefined })}
              data-testid="vacation-body"
            />
          </div>
          <label className="opt" style={{ marginTop: 6 }}>
            <input type="checkbox" checked={v.restrictToContacts} onChange={(e) => setV({ ...v, restrictToContacts: e.target.checked })} />
            <span>Only send a response to people in my Contacts</span>
          </label>
        </>
      )}
    </Row>
  );
}

// ---- Labels ----

function LabelsTab({ accountId }: { accountId: string }) {
  const labels = useMail((s) => s.labels[accountId] ?? NO_LABELS);
  const user = labels.filter((l) => l.type === "user").sort((a, b) => a.name.localeCompare(b.name));
  const sys = ["INBOX", "STARRED", "SNOOZED", "IMPORTANT", "SENT", "SCHEDULED", "DRAFT", "ALL", "SPAM", "TRASH"];
  const vis = useMail((s) => (s.settings as unknown as Record<string, unknown>).systemLabels as Record<string, string> | undefined) ?? {};
  const update = (l: Label, patch: Record<string, unknown>) =>
    void api
      .labelUpdate(accountId, l.id, patch)
      .then(() => loadLabels(accountId))
      .catch((e) => toast(errorText(e)));
  const setSys = (id: string, v: string) => {
    useMail.setState((s) => ({ settings: { ...s.settings, systemLabels: { ...vis, [id]: v } } as unknown as S }));
    void api.setSetting("systemLabels", { ...vis, [id]: v });
  };
  return (
    <>
      <table className="stable">
        <thead>
          <tr>
            <th>System labels</th>
            <th>Show in label list</th>
          </tr>
        </thead>
        <tbody>
          {sys.map((id) => (
            <tr key={id}>
              <td>{SYSTEM_DISPLAY[id]}</td>
              <td>
                {id === "INBOX" ? (
                  <span className="muted">always shown</span>
                ) : (
                  ["show", "hide", ...(["SPAM", "DRAFT", "SCHEDULED"].includes(id) ? ["show if unread"] : [])].map((v) => (
                    <button
                      key={v}
                      className="linkbtn"
                      style={{
                        marginRight: 8,
                        fontWeight: (vis[id] ?? "show") === v ? 700 : 400,
                        color: (vis[id] ?? "show") === v ? "var(--text)" : undefined,
                      }}
                      onClick={() => setSys(id, v)}
                    >
                      {v}
                    </button>
                  ))
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="stable">
        <thead>
          <tr>
            <th>Labels</th>
            <th>Show in label list</th>
            <th>Show in message list</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td colSpan={4}>
              <button className="btn outline sm" onClick={() => ui({ labelDialog: { accountId } })} data-testid="settings-new-label">
                Create new label
              </button>
            </td>
          </tr>
          {user.map((l) => {
            const v = l.labelListVisibility ?? "labelShow";
            return (
              <tr key={l.id} data-testid={`settings-label-${l.name}`}>
                <td>
                  <span style={{ paddingLeft: (l.name.split("/").length - 1) * 16 }}>
                    <Icon name="label" fill style={{ color: l.bg ?? "var(--icon)", verticalAlign: -4 }} size={18} /> {leafName(l.name)}
                  </span>
                  <div className="muted">
                    {l.threadsTotal} conversation{l.threadsTotal === 1 ? "" : "s"}
                  </div>
                </td>
                <td>
                  {(
                    [
                      ["labelShow", "show"],
                      ["labelHide", "hide"],
                      ["labelShowIfUnread", "show if unread"],
                    ] as const
                  ).map(([val, txt]) => (
                    <button
                      key={val}
                      className="linkbtn"
                      style={{ marginRight: 8, fontWeight: v === val ? 700 : 400, color: v === val ? "var(--text)" : undefined }}
                      onClick={() => update(l, { labelListVisibility: val })}
                    >
                      {txt}
                    </button>
                  ))}
                </td>
                <td>
                  {(["show", "hide"] as const).map((val) => (
                    <button
                      key={val}
                      className="linkbtn"
                      style={{
                        marginRight: 8,
                        fontWeight: (l.messageListVisibility ?? "show") === val ? 700 : 400,
                        color: (l.messageListVisibility ?? "show") === val ? "var(--text)" : undefined,
                      }}
                      onClick={() => update(l, { messageListVisibility: val })}
                    >
                      {val}
                    </button>
                  ))}
                </td>
                <td>
                  <button className="linkbtn" onClick={() => ui({ labelDialog: { accountId, edit: l } })}>
                    edit
                  </button>{" "}
                  <button
                    className="linkbtn"
                    onClick={() =>
                      ui({
                        confirm: {
                          title: "Remove label",
                          body: `Delete the label "${l.name}"?`,
                          ok: "Delete",
                          run: () =>
                            void api
                              .labelDelete(accountId, l.id)
                              .then(() => loadLabels(accountId))
                              .catch((e) => toast(errorText(e))),
                        },
                      })
                    }
                  >
                    remove
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="muted" style={{ color: "var(--text-2)" }}>
        Removing a label doesn't remove its conversations.
      </div>
    </>
  );
}

// ---- Inbox ----

function InboxTab() {
  const { d, set, dirty, save, reset } = useDraft();
  const acct = useMail((s) => s.accounts.find((a) => a.id === s.accountId));
  const labels = labelsFor(acct?.id ?? "");
  return (
    <>
      <Row k="Inbox type:">
        <select value={d.inboxType} onChange={(e) => set("inboxType", e.target.value as S["inboxType"])} data-testid="inbox-type">
          <option value="default">Default</option>
          <option value="important">Important first</option>
          <option value="unread">Unread first</option>
          <option value="starred">Starred first</option>
          <option value="priority">Priority Inbox</option>
          <option value="multiple">Multiple Inboxes</option>
        </select>
      </Row>
      {d.inboxType === "default" && (
        <Row k="Categories:" small="Choose which categories show as inbox tabs. Other mail appears in Primary.">
          <label className="opt">
            <input type="checkbox" checked disabled /> <span>Primary</span>
          </label>
          {(["promotions", "social", "updates", "forums"] as const).map((k) => (
            <label key={k} className="opt">
              <input
                type="checkbox"
                checked={d.categories[k]}
                onChange={(e) => set("categories", { ...d.categories, [k]: e.target.checked })}
                data-testid={`cat-${k}`}
              />
              <span>{k[0].toUpperCase() + k.slice(1)}</span>
            </label>
          ))}
          <label className="opt">
            <input type="checkbox" checked={d.includeStarredInPrimary} onChange={(e) => set("includeStarredInPrimary", e.target.checked)} />{" "}
            <span>Include starred in Primary</span>
          </label>
          {acct?.kind !== "gmail" && <div className="desc">Categories apply to accounts whose provider sorts mail into them.</div>}
        </Row>
      )}
      {d.inboxType === "priority" && (
        <Row k="Inbox sections:">
          {d.prioritySections.map((sec, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", margin: "4px 0" }}>
              {i + 1}.
              <select
                value={sec.kind === "label" ? `label:${sec.label}` : sec.kind}
                onChange={(e) => {
                  const v = e.target.value;
                  const next = [...d.prioritySections];
                  next[i] = v.startsWith("label:") ? { kind: "label", label: v.slice(6), max: sec.max } : { kind: v as typeof sec.kind, max: sec.max };
                  set("prioritySections", next);
                }}
              >
                <option value="important-unread">Important and unread</option>
                <option value="important">Important</option>
                <option value="unread">Unread</option>
                <option value="starred">Starred</option>
                <option value="everything">Everything else</option>
                {labels
                  .filter((l) => l.type === "user")
                  .map((l) => (
                    <option key={l.id} value={`label:${l.name}`}>
                      {l.name}
                    </option>
                  ))}
              </select>
              Show up to{" "}
              <select
                value={sec.max}
                onChange={(e) =>
                  set(
                    "prioritySections",
                    d.prioritySections.map((x, j) => (j === i ? { ...x, max: Number(e.target.value) } : x)),
                  )
                }
              >
                {[5, 10, 25, 50].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>{" "}
              items
            </div>
          ))}
        </Row>
      )}
      {d.inboxType === "multiple" && (
        <Row k="Multiple inbox sections:">
          {[0, 1, 2, 3, 4].map((i) => {
            const sec = d.multipleInboxes.sections[i] ?? { name: "", query: "" };
            const put = (patch: Partial<typeof sec>) => {
              const list = [...d.multipleInboxes.sections];
              list[i] = { ...sec, ...patch };
              set("multipleInboxes", { ...d.multipleInboxes, sections: list.filter((x) => x && (x.query || x.name)) });
            };
            return (
              <div key={i} style={{ display: "flex", gap: 8, margin: "4px 0", alignItems: "center" }}>
                Section {i + 1}:{" "}
                <input
                  type="text"
                  placeholder="search query (e.g. is:starred)"
                  value={sec.query}
                  onChange={(e) => put({ query: e.target.value })}
                  data-testid={`mi-query-${i}`}
                />
                Section name: <input type="text" value={sec.name} onChange={(e) => put({ name: e.target.value })} data-testid={`mi-name-${i}`} />
              </div>
            );
          })}
          <div style={{ marginTop: 8 }}>
            Maximum page size: show{" "}
            <select value={d.multipleInboxes.max} onChange={(e) => set("multipleInboxes", { ...d.multipleInboxes, max: Number(e.target.value) })}>
              {[5, 9, 10, 15, 20, 25].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>{" "}
            conversations per section
          </div>
          <div style={{ marginTop: 8 }}>
            Multiple Inbox position:{" "}
            {(["right", "above", "below"] as const).map((p) => (
              <label key={p} style={{ marginRight: 12 }}>
                <input type="radio" checked={d.multipleInboxes.position === p} onChange={() => set("multipleInboxes", { ...d.multipleInboxes, position: p })} />{" "}
                {p === "right" ? "Right of the inbox" : p === "above" ? "Above the inbox" : "Below the inbox"}
              </label>
            ))}
          </div>
        </Row>
      )}
      <Row k="Reading pane:">
        <Radio name="rp" value="none" cur={d.readingPane} onPick={(v) => set("readingPane", v)} label="No split" />
        <Radio name="rp" value="right" cur={d.readingPane} onPick={(v) => set("readingPane", v)} label="Right of inbox" />
        <Radio name="rp" value="below" cur={d.readingPane} onPick={(v) => set("readingPane", v)} label="Below inbox" />
      </Row>
      <Row k="Importance markers:">
        <Radio
          name="im"
          value={true}
          cur={d.importanceMarkers}
          onPick={(v) => set("importanceMarkers", v)}
          label="Show markers"
          desc="A tag beside conversations marked important."
          test="importance-on"
        />
        <Radio name="im" value={false} cur={d.importanceMarkers} onPick={(v) => set("importanceMarkers", v)} label="No markers" />
      </Row>
      <SaveBar dirty={dirty} save={save} reset={reset} />
    </>
  );
}

// ---- Accounts ----

function AccountsTab() {
  const accounts = useMail((s) => s.accounts);
  const unified = useMail((s) => s.settings.unifiedInbox);
  const [client, setClient] = useState<{ configured: boolean; clientIdHint: string | null } | null>(null);
  const [cid, setCid] = useState("");
  const [secret, setSecret] = useState("");
  const [isDefault, setIsDefault] = useState<boolean | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const loadClient = () => void api.googleClientStatus().then(setClient);
  useEffect(() => {
    loadClient();
    void api
      .isDefaultMailApp()
      .then(setIsDefault)
      .catch(() => setIsDefault(false));
  }, []);
  const saveClient = async (json?: string) => {
    try {
      await api.googleClientSet(json ? { jsonText: json } : { clientId: cid, clientSecret: secret });
      setCid("");
      setSecret("");
      loadClient();
      toast("Google sign-in is set up.");
    } catch (e) {
      toast(errorText(e));
    }
  };
  return (
    <>
      <Row k="Accounts:" small="Each account has its own colour, shown in All inboxes and the account switcher.">
        {accounts.map((a, i) => (
          <AccountRow key={a.id} a={a} index={i} />
        ))}
        <button className="btn outline sm" style={{ marginTop: 8 }} onClick={() => ui({ addAccount: {} })} data-testid="settings-add-account">
          <Icon name="person_add" /> Add another account
        </button>
        <label className="opt" style={{ marginTop: 12 }}>
          <input type="checkbox" checked={unified} onChange={(e) => void setSetting("unifiedInbox", e.target.checked)} />
          <span>Show "All inboxes" (every account's Inbox together) in the account menu</span>
        </label>
      </Row>
      <Row k="Google sign-in setup:" small="Needed once to add Gmail accounts">
        {client?.configured ? (
          <div>
            <Icon name="check_circle" style={{ color: "#188038", verticalAlign: -4 }} /> Set up (client {client.clientIdHint}){" "}
            <button className="linkbtn" onClick={() => void api.googleClientClear().then(loadClient)}>
              remove
            </button>
          </div>
        ) : (
          <div className="desc" style={{ marginBottom: 8 }}>
            Not set up yet.
          </div>
        )}
        <ol style={{ margin: "6px 0 10px", paddingLeft: 20, lineHeight: 1.6 }}>
          <li>Open console.cloud.google.com and create a project (any name, e.g. "Courier").</li>
          <li>APIs &amp; Services ▸ Library: enable the Gmail API (and People API for contact suggestions).</li>
          <li>Google Auth Platform ▸ Get started: app name "Courier", audience External; add your addresses as test users.</li>
          <li>Clients ▸ Create client ▸ Desktop app. Download the JSON, or copy the client ID and secret.</li>
          <li>Import the JSON or paste them below. They're stored in your Keychain.</li>
        </ol>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input type="text" placeholder="Client ID" value={cid} onChange={(e) => setCid(e.target.value)} style={{ width: 320 }} data-testid="client-id" />
          <input
            type="password"
            placeholder="Client secret"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            style={{ width: 200 }}
            data-testid="client-secret"
          />
          <button className="btn filled sm" disabled={!cid.trim()} onClick={() => void saveClient()} data-testid="client-save">
            Save
          </button>
          <button className="btn outline sm" onClick={() => file.current?.click()}>
            Import JSON…
          </button>
          <input
            ref={file}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void f.text().then((t) => saveClient(t));
              e.target.value = "";
            }}
          />
        </div>
      </Row>
      <Row k="Default mail app:">
        {isDefault ? (
          <span>
            <Icon name="check_circle" style={{ color: "#188038", verticalAlign: -4 }} /> Courier opens mailto: links.
          </span>
        ) : (
          <>
            <span className="desc">Another app opens mail links. </span>
            <button
              className="btn outline sm"
              onClick={() =>
                void api
                  .setDefaultMailApp()
                  .then(() => setTimeout(() => void api.isDefaultMailApp().then(setIsDefault), 1500))
                  .catch((e) => toast(errorText(e)))
              }
            >
              Make Courier the default mail app
            </button>
          </>
        )}
      </Row>
      {accounts
        .filter((a) => a.kind === "gmail")
        .map((a) => (
          <SendAsRow key={a.id} a={a} />
        ))}
      {accounts
        .filter((a) => a.kind === "imap")
        .map((a) => (
          <ImapServerRow key={a.id} a={a} />
        ))}
    </>
  );
}

const COLORS = ["#1a73e8", "#0b8043", "#d93025", "#9334e6", "#e37400", "#007b83", "#c5221f", "#3949ab", "#5f6368", "#ad1457"];

function AccountRow({ a, index }: { a: Account; index: number }) {
  const [name, setName] = useState(a.name);
  const sync = useMail((s) => s.sync[a.id]);
  const syncError = useMail((s) => s.syncError[a.id]);
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0", borderBottom: "1px solid var(--settings-border)" }}
      data-testid={`settings-account-${a.email}`}
    >
      <Avatar name={a.name} email={a.email} photo={a.photo} color={a.color} size={36} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name !== a.name && void api.updateAccount(a.id, { name }).then(loadAccounts)}
          aria-label="Account name"
          style={{ width: 200 }}
        />
        <div className="desc">
          {a.email} · {a.kind === "gmail" ? "Gmail (mail API)" : "IMAP/SMTP"} · ⌘{index + 1}
          {a.needsReauth ? " · needs signing in again" : sync ? ` · ${SYNC_TEXT[sync] ?? sync}` : ""}
          {!a.needsReauth && syncError && (sync === "error" || sync === "busy") && <div className="hint">{syncError}</div>}
        </div>
      </div>
      <div style={{ display: "flex", gap: 4 }}>
        {COLORS.map((c) => (
          <button
            key={c}
            aria-label={`Colour ${c}`}
            onClick={() => void api.updateAccount(a.id, { color: c }).then(loadAccounts)}
            style={{
              width: 18,
              height: 18,
              borderRadius: "50%",
              border: a.color === c ? "2px solid var(--text)" : "1px solid rgba(0,0,0,.2)",
              background: c,
              cursor: "pointer",
              padding: 0,
            }}
          />
        ))}
      </div>
      {a.needsReauth && (
        <button className="btn filled sm" onClick={() => ui({ addAccount: { kind: a.kind, reauth: a } })}>
          Sign in
        </button>
      )}
      <button
        className="btn outline sm"
        onClick={() =>
          ui({
            confirm: {
              title: `Sign out of ${a.email}?`,
              body: "Removes this account's sign-in from the Keychain and its local copy of mail. Nothing changes on the server.",
              ok: "Sign out",
              run: () =>
                void api
                  .removeAccount(a.id)
                  .then(loadAccounts)
                  .then(() => toast(`Signed out of ${a.email}.`)),
            },
          })
        }
        data-testid="settings-sign-out"
      >
        Sign out
      </button>
    </div>
  );
}

function SendAsRow({ a }: { a: Account }) {
  const [list, setList] = useState<Record<string, unknown>[]>([]);
  const [adding, setAdding] = useState(false);
  const [n, setN] = useState("");
  const [e, setE] = useState("");
  const load = () =>
    void api
      .sendAs(a.id)
      .then(setList)
      .catch(() => {});
  useEffect(load, [a.id]);
  return (
    <Row k="Send mail as:" small={a.email}>
      {list.map((s) => (
        <div key={String(s.sendAsEmail)} style={{ display: "flex", gap: 8, alignItems: "center", margin: "4px 0" }}>
          <span style={{ flex: 1 }}>
            {String(s.displayName || a.name)} &lt;{String(s.sendAsEmail)}&gt; {s.isDefault ? <b>default</b> : ""}{" "}
            {s.verificationStatus === "pending" ? <span className="desc">(unverified)</span> : ""}
          </span>
          {!s.isDefault && (
            <button className="linkbtn" onClick={() => void api.sendAsSave(a.id, String(s.sendAsEmail), { isDefault: true }).then(load)}>
              make default
            </button>
          )}
          {!s.isPrimary && (
            <button className="linkbtn" onClick={() => void api.sendAsDelete(a.id, String(s.sendAsEmail)).then(load)}>
              delete
            </button>
          )}
        </div>
      ))}
      {adding ? (
        <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
          <input type="text" placeholder="Name" value={n} onChange={(x) => setN(x.target.value)} />
          <input type="email" placeholder="Email address" value={e} onChange={(x) => setE(x.target.value)} />
          <button
            className="btn filled sm"
            disabled={!e.includes("@")}
            onClick={() =>
              void api
                .sendAsSave(a.id, e, { displayName: n, treatAsAlias: true }, true)
                .then(() => (setAdding(false), load(), toast("Address added. Confirm it from the verification email your provider sends.")))
                .catch((x) => toast(errorText(x)))
            }
          >
            Add
          </button>
        </div>
      ) : (
        <button className="linkbtn" onClick={() => setAdding(true)}>
          Add another email address
        </button>
      )}
    </Row>
  );
}

function ImapServerRow({ a }: { a: Account }) {
  const cfg = a.config as unknown as ImapAccountConfig;
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Row k="Servers:" small={a.email}>
      <div>
        Incoming: {cfg.imap?.host}:{cfg.imap?.port} ({cfg.imap?.security}) · user {cfg.imap?.username}
      </div>
      <div>
        Outgoing: {cfg.smtp?.host}:{cfg.smtp?.port} ({cfg.smtp?.security})
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
        <input type="password" placeholder="New app password" value={pw} onChange={(e) => setPw(e.target.value)} />
        <button
          className="btn outline sm"
          disabled={!pw || busy}
          onClick={() => {
            setBusy(true);
            void api
              .addImap({ email: a.email, name: a.name, config: cfg, password: pw, reauthId: a.id })
              .then(() => (toast("Password updated."), setPw("")))
              .catch((e) => toast(errorText(e)))
              .finally(() => setBusy(false));
          }}
        >
          Update password
        </button>
      </div>
    </Row>
  );
}

// ---- Filters ----

function FiltersTab({ accountId }: { accountId: string }) {
  const [filters, setFilters] = useState<{ id: string; criteria: Record<string, unknown>; action: Record<string, unknown> }[]>([]);
  const [blocked, setBlocked] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<{ id: string; criteria: Record<string, unknown>; action: Record<string, unknown> } | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [importing, setImporting] = useState<{ list: ImportedFilter[]; on: boolean[] } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const acct = useMail((s) => s.accounts.find((a) => a.id === accountId));
  const exportPicked = () => {
    const chosen = filters.filter((f) => picked.includes(f.id));
    const xml = exportFiltersXml(chosen as { criteria: FilterCriteriaLike; action: FilterActionLike }[], (id) => labelName(accountId, id), {
      name: acct?.name ?? "",
      email: acct?.email ?? "",
    });
    void download("mailFilters.xml", new TextEncoder().encode(xml));
  };
  const deletePicked = async () => {
    for (const id of picked) await api.filterDelete(accountId, id).catch(() => {});
    setPicked([]);
    load();
  };
  const runImport = async () => {
    if (!importing) return;
    let made = 0;
    for (const [i, f] of importing.list.entries()) {
      if (!importing.on[i]) continue;
      let labelId: string | null = null;
      if (f.labelName) {
        labelId = labelsFor(accountId).find((l) => l.name.toLowerCase() === f.labelName!.toLowerCase())?.id ?? null;
        if (!labelId) labelId = await api.labelCreate(accountId, f.labelName).catch(() => null);
      }
      try {
        await api.filterCreate(accountId, f.criteria as Record<string, unknown>, importedAction(f, labelId) as Record<string, unknown>);
        made++;
      } catch (e) {
        setErr(errorText(e));
      }
    }
    setImporting(null);
    void loadLabels(accountId);
    load();
    toast(`${made} filter${made === 1 ? "" : "s"} imported.`);
  };
  const load = () => {
    void api
      .filters(accountId)
      .then(setFilters)
      .catch((e) => setErr(errorText(e)));
    void api.blocked(accountId).then(setBlocked);
  };
  useEffect(load, [accountId]);
  return (
    <>
      <h4 style={{ margin: "16px 0 8px" }}>Filters run on every message that arrives:</h4>
      {err && <div className="error-box">{err}</div>}
      <table className="stable">
        <tbody>
          {filters.map((f) => (
            <tr key={f.id} data-testid="filter-row">
              <td style={{ width: 28 }}>
                <input
                  type="checkbox"
                  aria-label="Select filter"
                  checked={picked.includes(f.id)}
                  onChange={() => setPicked((p) => (p.includes(f.id) ? p.filter((x) => x !== f.id) : [...p, f.id]))}
                  data-testid="filter-pick"
                />
              </td>
              <td>
                <b>Matches:</b> {describeCriteria(f.criteria as FilterCriteria)}
                <div>
                  <b>Do this:</b> {describeActions(f.action, (id) => labelName(accountId, id)).join(", ") || "—"}
                </div>
              </td>
              <td style={{ width: 120 }}>
                <button className="linkbtn" onClick={() => setEditing(f)} data-testid="filter-edit">
                  edit
                </button>{" "}
                <button className="linkbtn" onClick={() => void api.filterDelete(accountId, f.id).then(load)} data-testid="filter-delete">
                  delete
                </button>
              </td>
            </tr>
          ))}
          {!filters.length && (
            <tr>
              <td className="muted">No filters yet.</td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="filter-tools">
        <label className="checkline">
          <input
            type="checkbox"
            checked={filters.length > 0 && picked.length === filters.length}
            onChange={(e) => setPicked(e.target.checked ? filters.map((f) => f.id) : [])}
            aria-label="Select all filters"
            data-testid="filter-pick-all"
          />{" "}
          All
        </label>
        <button className="btn outline sm" disabled={!picked.length} onClick={exportPicked} data-testid="filters-export">
          Export
        </button>
        <button className="btn outline sm" disabled={!picked.length} onClick={() => void deletePicked()} data-testid="filters-delete">
          Delete
        </button>
        <span className="grow" />
        <button className="btn outline sm" onClick={() => setCreating(true)} data-testid="filters-create">
          New filter
        </button>
        <button className="btn outline sm" onClick={() => fileInput.current?.click()} data-testid="filters-import">
          Import filters…
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".xml,text/xml,application/xml"
          hidden
          data-testid="filters-import-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            void f.text().then((t) => {
              const list = importFiltersXml(t);
              if (!list.length) setErr("No filters found in that file.");
              else setImporting({ list, on: list.map(() => true) });
            });
          }}
        />
      </div>
      {importing && (
        <div className="import-box" data-testid="filters-import-box">
          <b>Filters in the file:</b>
          {importing.list.map((f, i) => (
            <label key={i} className="checkline">
              <input
                type="checkbox"
                checked={importing.on[i]}
                onChange={(e) => setImporting({ ...importing, on: importing.on.map((v, j) => (j === i ? e.target.checked : v)) })}
              />{" "}
              {describeCriteria(f.criteria as FilterCriteria)}
              {f.labelName ? ` → ${f.labelName}` : ""}
            </label>
          ))}
          <div className="import-actions">
            <button className="btn text sm" onClick={() => setImporting(null)}>
              Cancel
            </button>
            <button className="btn outline sm" onClick={() => void runImport()} data-testid="filters-import-create">
              Create filters
            </button>
          </div>
        </div>
      )}
      <h4 style={{ margin: "24px 0 8px" }}>Blocked senders (their mail goes to Spam or Trash):</h4>
      <table className="stable">
        <tbody>
          {blocked.map((b) => (
            <tr key={b}>
              <td>{b}</td>
              <td style={{ width: 120 }}>
                <button className="linkbtn" onClick={() => void api.unblock(accountId, b).then(load)}>
                  unblock
                </button>
              </td>
            </tr>
          ))}
          {!blocked.length && (
            <tr>
              <td className="muted">No one is blocked.</td>
            </tr>
          )}
        </tbody>
      </table>
      {creating && <FilterDialog criteria={{}} onClose={() => (setCreating(false), load())} accountId={accountId} />}
      {editing && (
        <FilterDialog
          criteria={editing.criteria as FilterCriteria}
          existing={{ id: editing.id, action: editing.action as FilterAction }}
          onClose={() => (setEditing(null), load())}
          accountId={accountId}
        />
      )}
    </>
  );
}

// ---- Forwarding and POP/IMAP ----

function ForwardingTab({ accountId }: { accountId: string }) {
  const acct = useMail((s) => s.accounts.find((a) => a.id === accountId));
  const [fwd, setFwd] = useState<{ forwardingEmail: string; verificationStatus: string }[]>([]);
  const [auto, setAuto] = useState<{ enabled: boolean; emailAddress?: string; disposition?: string } | null>(null);
  const [pop, setPop] = useState<{ accessWindow: string; disposition: string } | null>(null);
  const [imap, setImap] = useState<{ enabled: boolean; autoExpunge: boolean; expungeBehavior: string; maxFolderSize: number } | null>(null);
  const [add, setAdd] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const load = () => {
    if (acct?.kind !== "gmail") return;
    void api
      .forwarding(accountId)
      .then(setFwd)
      .catch((e) => setErr(errorText(e)));
    void api
      .serverSettings<typeof auto>(accountId, "autoForwarding")
      .then(setAuto)
      .catch(() => {});
    void api
      .serverSettings<typeof pop>(accountId, "pop")
      .then(setPop)
      .catch(() => {});
    void api
      .serverSettings<typeof imap>(accountId, "imap")
      .then(setImap)
      .catch(() => {});
  };
  useEffect(load, [accountId]);
  if (acct?.kind !== "gmail") return <div className="empty">Forwarding and POP/IMAP are managed by your provider for {acct?.email}.</div>;
  const save = async () => {
    try {
      if (auto) await api.setServerSettings(accountId, "autoForwarding", auto);
      if (pop) await api.setServerSettings(accountId, "pop", pop);
      if (imap) await api.setServerSettings(accountId, "imap", imap);
      toast("Your preferences have been saved.");
    } catch (e) {
      toast(errorText(e));
    }
  };
  const verified = fwd.filter((f) => f.verificationStatus === "accepted");
  return (
    <>
      {err && <div className="error-box">{err}</div>}
      <Row k="Forwarding:">
        {fwd.map((f) => (
          <div key={f.forwardingEmail}>
            {f.forwardingEmail} {f.verificationStatus !== "accepted" && <span className="desc">(waiting for confirmation)</span>}{" "}
            <button className="linkbtn" onClick={() => void api.forwardingRemove(accountId, f.forwardingEmail).then(load)}>
              remove
            </button>
          </div>
        ))}
        <div style={{ display: "flex", gap: 8, margin: "6px 0" }}>
          <input type="email" placeholder="Add a forwarding address" value={add} onChange={(e) => setAdd(e.target.value)} />
          <button
            className="btn outline sm"
            disabled={!add.includes("@")}
            onClick={() =>
              void api
                .forwardingAdd(accountId, add)
                .then(() => (setAdd(""), load(), toast("A confirmation code was sent to that address.")))
                .catch((e) => toast(errorText(e)))
            }
          >
            Add
          </button>
        </div>
        {auto && (
          <>
            <Radio name="af" value={false} cur={auto.enabled} onPick={(v) => setAuto({ ...auto, enabled: v })} label="Disable forwarding" />
            <label className="opt">
              <input
                type="radio"
                name="af"
                checked={auto.enabled}
                disabled={!verified.length}
                onChange={() => setAuto({ ...auto, enabled: true, emailAddress: auto.emailAddress || verified[0]?.forwardingEmail })}
              />
              <span>
                Forward a copy of incoming mail to{" "}
                <select value={auto.emailAddress ?? ""} onChange={(e) => setAuto({ ...auto, emailAddress: e.target.value })} disabled={!verified.length}>
                  {verified.map((f) => (
                    <option key={f.forwardingEmail}>{f.forwardingEmail}</option>
                  ))}
                </select>{" "}
                and{" "}
                <select value={auto.disposition ?? "leaveInInbox"} onChange={(e) => setAuto({ ...auto, disposition: e.target.value })}>
                  <option value="leaveInInbox">keep the copy in the Inbox</option>
                  <option value="markRead">mark the copy as read</option>
                  <option value="archive">archive the copy</option>
                  <option value="trash">delete the copy</option>
                </select>
              </span>
            </label>
          </>
        )}
      </Row>
      {pop && (
        <Row k="POP download:">
          <div>Status: {pop.accessWindow === "disabled" ? "POP is disabled" : "POP is enabled"}</div>
          <Radio name="pop" value="allMail" cur={pop.accessWindow} onPick={(v) => setPop({ ...pop, accessWindow: v })} label="Turn on POP for all mail" />
          <Radio
            name="pop"
            value="fromNowOn"
            cur={pop.accessWindow}
            onPick={(v) => setPop({ ...pop, accessWindow: v })}
            label="Turn on POP for new mail only"
          />
          <Radio name="pop" value="disabled" cur={pop.accessWindow} onPick={(v) => setPop({ ...pop, accessWindow: v })} label="Disable POP" />
          <div style={{ marginTop: 6 }}>
            When messages are accessed with POP{" "}
            <select value={pop.disposition} onChange={(e) => setPop({ ...pop, disposition: e.target.value })}>
              <option value="leaveInInbox">keep the copy in the Inbox</option>
              <option value="markRead">mark the copy as read</option>
              <option value="archive">archive the copy</option>
              <option value="trash">delete the copy</option>
            </select>
          </div>
        </Row>
      )}
      {imap && (
        <Row k="IMAP access:" small="(other mail apps)">
          <Radio name="imap" value={true} cur={imap.enabled} onPick={(v) => setImap({ ...imap, enabled: v })} label="Enable IMAP" />
          <Radio name="imap" value={false} cur={imap.enabled} onPick={(v) => setImap({ ...imap, enabled: v })} label="Disable IMAP" />
          <div style={{ marginTop: 6 }}>When I mark a message in IMAP as deleted:</div>
          <Radio
            name="ae"
            value={true}
            cur={imap.autoExpunge}
            onPick={(v) => setImap({ ...imap, autoExpunge: v })}
            label="Auto-Expunge on"
            desc="Changes reach the server at once."
          />
          <Radio
            name="ae"
            value={false}
            cur={imap.autoExpunge}
            onPick={(v) => setImap({ ...imap, autoExpunge: v })}
            label="Auto-Expunge off"
            desc="Leave it to the mail app to tell the server."
          />
          <div style={{ marginTop: 6 }}>When a message is marked as deleted and expunged from the last visible IMAP folder:</div>
          <Radio name="eb" value="archive" cur={imap.expungeBehavior} onPick={(v) => setImap({ ...imap, expungeBehavior: v })} label="Archive it" />
          <Radio name="eb" value="trash" cur={imap.expungeBehavior} onPick={(v) => setImap({ ...imap, expungeBehavior: v })} label="Move it to Trash" />
          <Radio
            name="eb"
            value="deleteForever"
            cur={imap.expungeBehavior}
            onPick={(v) => setImap({ ...imap, expungeBehavior: v })}
            label="Delete it forever right away"
          />
          <div style={{ marginTop: 6 }}>
            Folder size limits:{" "}
            <select value={imap.maxFolderSize} onChange={(e) => setImap({ ...imap, maxFolderSize: Number(e.target.value) })}>
              <option value={0}>Do not limit the number of messages in an IMAP folder</option>
              {[1000, 2000, 5000, 10000].map((n) => (
                <option key={n} value={n}>
                  Limit IMAP folders to {n.toLocaleString()} messages
                </option>
              ))}
            </select>
          </div>
        </Row>
      )}
      <div className="settings-actions">
        <button className="btn filled" onClick={() => void save()} data-testid="fwd-save">
          Save Changes
        </button>
        <button className="btn outline" onClick={load}>
          Cancel
        </button>
      </div>
    </>
  );
}

// ---- Advanced / Offline / Themes ----

function AdvancedTab() {
  const { d, set, dirty, save, reset } = useDraft();
  return (
    <>
      <Row k="Auto-advance:" small="Where to go after archiving, deleting or muting a conversation:">
        <Radio name="aa" value="newer" cur={d.autoAdvance} onPick={(v) => set("autoAdvance", v)} label="the next (newer) conversation" />
        <Radio name="aa" value="older" cur={d.autoAdvance} onPick={(v) => set("autoAdvance", v)} label="the previous (older) conversation" />
        <Radio name="aa" value="list" cur={d.autoAdvance} onPick={(v) => set("autoAdvance", v)} label="the conversation list" />
      </Row>
      <Row k="Templates:" small="Save frequent messages as templates (compose ▸ More options ▸ Templates).">
        <Radio name="tp" value={true} cur={d.templates} onPick={(v) => set("templates", v)} label="Enable" test="templates-on" />
        <Radio name="tp" value={false} cur={d.templates} onPick={(v) => set("templates", v)} label="Disable" />
      </Row>
      <Row k="Unread message badge:" small="The count on Courier's Dock icon.">
        <Radio name="bd" value={true} cur={d.badge.enabled} onPick={(v) => set("badge", { ...d.badge, enabled: v })} label="Enable" />
        <Radio name="bd" value={false} cur={d.badge.enabled} onPick={(v) => set("badge", { ...d.badge, enabled: v })} label="Disable" />
        <label className="opt">
          <input type="checkbox" checked={d.badge.primaryOnly} onChange={(e) => set("badge", { ...d.badge, primaryOnly: e.target.checked })} />{" "}
          <span>Count only the Primary tab</span>
        </label>
      </Row>
      <Row k="Checking for new mail:">
        Every{" "}
        <select value={d.syncSeconds} onChange={(e) => set("syncSeconds", Number(e.target.value))}>
          {[30, 60, 120, 300, 900].map((n) => (
            <option key={n} value={n}>
              {n < 60 ? `${n} seconds` : `${n / 60} minute${n === 60 ? "" : "s"}`}
            </option>
          ))}
        </select>{" "}
        (IMAP accounts with IDLE get new mail right away)
      </Row>
      <SaveBar dirty={dirty} save={save} reset={reset} />
    </>
  );
}

function OfflineTab() {
  const { d, set, dirty, save, reset } = useDraft();
  const info = useMail((s) => s.info);
  return (
    <>
      <Row k="Offline:">
        <label className="opt">
          <input type="checkbox" checked={d.offline.enabled} onChange={(e) => set("offline", { ...d.offline, enabled: e.target.checked })} />{" "}
          <span>Keep mail on this Mac for offline reading and search</span>
        </label>
        <div style={{ marginTop: 6 }}>
          Sync mail from the last{" "}
          <select value={d.offline.days} onChange={(e) => set("offline", { ...d.offline, days: Number(e.target.value) })}>
            {[7, 30, 90].map((n) => (
              <option key={n} value={n}>
                {n} days
              </option>
            ))}
          </select>
        </div>
        <div className="desc" style={{ marginTop: 6 }}>
          Mail is stored in {info?.dataDir}. Messages you write offline wait in the Outbox and go out when you're back online.
        </div>
      </Row>
      <SaveBar dirty={dirty} save={save} reset={reset} />
    </>
  );
}

function ThemesTab() {
  const theme = useMail((s) => s.settings.theme);
  return (
    <Row k="Themes:">
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span className="theme-tile on" style={{ width: 96, height: 60, background: themeById(theme).swatch, display: "inline-block" }} />
        <div>
          {themeById(theme).name}
          <div>
            <button className="btn outline sm" onClick={() => ui({ themePicker: true })} data-testid="settings-set-theme">
              Set theme
            </button>
          </div>
        </div>
      </div>
    </Row>
  );
}

export const SETTINGS_DEFAULTS = DEFAULTS;
