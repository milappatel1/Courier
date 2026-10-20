// Dialogs: new/edit label, add account (mail API or IMAP with discovery), snooze date picker, confirm,
// keyboard shortcuts, show original; and the toast stack.
import { useEffect, useState } from "react";
import { authResults, parseMessage, type ParsedMessage } from "../core/mime/parse";
import { latin1 } from "../core/bytes";
import { fullDate } from "../core/dates";
import { COMPOSE_SHORTCUTS, SHORTCUTS } from "../core/shortcuts";
import { LABEL_BG, labelTextColor, leafName, parentPath, validateLabelName } from "../core/labels";
import { formatAddress } from "../core/addresses";
import { api, errorText } from "../ipc/api";
import type { Discovered, ImapAccountConfig } from "../ipc/types";
import { applyLabels, snooze } from "../state/actions";
import { download } from "../state/files";
import { dismissToast, labelsFor, loadAccounts, loadLabels, setAccount, toast, ui, useMail } from "../state/store";
import { Dialog, Icon, IconButton } from "./common";

export function Dialogs() {
  const u = useMail((s) => s.ui);
  return (
    <>
      {u.labelDialog && <LabelDialog {...u.labelDialog} onClose={() => ui({ labelDialog: null })} />}
      {u.addAccount && <AddAccount kind={u.addAccount.kind} reauth={u.addAccount.reauth} onClose={() => ui({ addAccount: null })} />}
      {u.snoozePicker && <SnoozePicker {...u.snoozePicker} onClose={() => ui({ snoozePicker: null })} />}
      {u.confirm && <Confirm {...u.confirm} onClose={() => ui({ confirm: null })} />}
      {u.ask && <Ask {...u.ask} onClose={() => ui({ ask: null })} />}
      {u.shortcutsHelp && <ShortcutsHelp onClose={() => ui({ shortcutsHelp: false })} />}
      {u.showOriginal && <ShowOriginal {...u.showOriginal} onClose={() => ui({ showOriginal: null })} />}
    </>
  );
}

function Confirm({ title, body, ok, run, onClose }: { title: string; body: string; ok: string; run: () => void; onClose: () => void }) {
  return (
    <Dialog
      title={title}
      onClose={onClose}
      testId="confirm-dialog"
      actions={
        <>
          <button className="btn text" onClick={onClose}>
            Cancel
          </button>
          <button className="btn text" onClick={() => (onClose(), run())} data-testid="confirm-ok">
            {ok}
          </button>
        </>
      }
    >
      {body}
    </Dialog>
  );
}

/**
 * Google sign-in setup inside the Add Gmail step, so a first account can be added before any other exists (the
 * same control as Settings ▸ Accounts): import the client JSON, or paste the client ID and secret.
 */
function ClientSetup({ onDone }: { onDone: () => void }) {
  const [cid, setCid] = useState("");
  const [secret, setSecret] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const save = async (jsonText?: string) => {
    setErr(null);
    try {
      await api.googleClientSet(jsonText ? { jsonText } : { clientId: cid.trim(), clientSecret: secret.trim() });
      setCid("");
      setSecret("");
      toast("Google sign-in is set up.");
      onDone();
    } catch (e) {
      setErr(errorText(e));
    }
  };
  return (
    <div className="client-setup" data-testid="client-setup">
      <p style={{ marginTop: 0 }}>
        First, give Courier your Google sign-in client (made once in Google Cloud; SETUP-GOOGLE.md has the steps). It's stored in your Keychain.
      </p>
      <label className="btn outline sm" style={{ cursor: "pointer" }}>
        <Icon name="upload_file" /> Import JSON…
        <input
          type="file"
          accept="application/json,.json"
          hidden
          data-testid="client-json-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void f.text().then((t) => save(t));
            e.target.value = "";
          }}
        />
      </label>
      <div className="hint" style={{ margin: "10px 0 4px" }}>
        or paste them:
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input
          type="text"
          placeholder="Client ID"
          value={cid}
          onChange={(e) => setCid(e.target.value)}
          style={{ flex: "1 1 220px" }}
          aria-label="Client ID"
          data-testid="add-client-id"
        />
        <input
          type="password"
          placeholder="Client secret"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          style={{ flex: "1 1 140px" }}
          aria-label="Client secret"
          data-testid="add-client-secret"
        />
        <button className="btn filled sm" disabled={!cid.trim()} onClick={() => void save()} data-testid="add-client-save">
          Save
        </button>
      </div>
      {err && <div className="error-box">{err}</div>}
    </div>
  );
}

function Ask({
  title,
  label,
  value = "",
  ok,
  options,
  run,
  onClose,
}: {
  title: string;
  label: string;
  value?: string;
  ok: string;
  options?: string[];
  run: (value: string) => void;
  onClose: () => void;
}) {
  const [v, setV] = useState(value);
  const submit = () => {
    if (!v.trim()) return;
    onClose();
    run(v.trim());
  };
  return (
    <Dialog
      title={title}
      onClose={onClose}
      testId="ask-dialog"
      actions={
        <>
          <button className="btn text" onClick={onClose}>
            Cancel
          </button>
          <button className="btn text" disabled={!v.trim()} onClick={submit} data-testid="ask-ok">
            {ok}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="ask-input">{label}</label>
        <input
          id="ask-input"
          autoFocus
          value={v}
          list={options?.length ? "ask-options" : undefined}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          data-testid="ask-input"
        />
        {options && options.length > 0 && (
          <datalist id="ask-options">
            {options.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
        )}
      </div>
    </Dialog>
  );
}

function LabelDialog({
  accountId,
  edit,
  parent,
  applyTo,
  onClose,
}: {
  accountId: string;
  edit?: import("../ipc/types").Label;
  parent?: string;
  applyTo?: string[];
  onClose: () => void;
}) {
  const labels = labelsFor(accountId).filter((l) => l.type === "user");
  const [name, setName] = useState(edit ? leafName(edit.name) : "");
  const [nest, setNest] = useState(!!(parent ?? (edit && parentPath(edit.name))));
  const [under, setUnder] = useState(parent ?? (edit ? (parentPath(edit.name) ?? "") : (labels[0]?.name ?? "")));
  const [bg, setBg] = useState<string | null>(edit?.bg ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const full = nest && under ? `${under}/${name.trim()}` : name.trim();
  const submit = async () => {
    const others = labels.filter((l) => l.id !== edit?.id).map((l) => l.name);
    const v = validateLabelName(full, others);
    if (v) return setErr(v);
    setBusy(true);
    try {
      if (edit) {
        const patch: Record<string, unknown> = {};
        if (full !== edit.name) patch.name = full;
        if (bg !== edit.bg) patch.color = bg ? { backgroundColor: bg, textColor: labelTextColor(bg) } : { backgroundColor: "", textColor: "" };
        if (Object.keys(patch).length) await api.labelUpdate(accountId, edit.id, patch);
      } else {
        const id = await api.labelCreate(accountId, full, bg, bg ? labelTextColor(bg) : null);
        if (applyTo?.length) await applyLabels([id], [], { targets: [{ accountId, threadIds: applyTo }] });
      }
      await loadLabels(accountId);
      onClose();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={edit ? "Edit label" : "New label"}
      onClose={onClose}
      testId="label-dialog"
      actions={
        <>
          <button className="btn text" onClick={onClose}>
            Cancel
          </button>
          <button className="btn text" disabled={!name.trim() || busy} onClick={() => void submit()} data-testid="label-create">
            {edit ? "Save" : "Create"}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Please enter a new label name:</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => (setName(e.target.value), setErr(null))}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          data-testid="label-name"
        />
        {err && <span className="err">{err}</span>}
      </div>
      <label className="checkline">
        <input type="checkbox" checked={nest} onChange={(e) => setNest(e.target.checked)} disabled={!labels.length} data-testid="label-nest" /> Nest label
        under:
      </label>
      <select
        value={under}
        onChange={(e) => setUnder(e.target.value)}
        disabled={!nest}
        style={{ width: "100%", height: 36, marginBottom: 12 }}
        data-testid="label-parent"
      >
        {labels
          .filter((l) => !edit || (l.id !== edit.id && !l.name.startsWith(`${edit.name}/`)))
          .map((l) => (
            <option key={l.id} value={l.name}>
              {l.name}
            </option>
          ))}
      </select>
      <div style={{ color: "var(--text)" }}>Label color:</div>
      <div className="color-grid" style={{ padding: "8px 0" }}>
        <button className={!bg ? "on" : ""} style={{ background: "transparent" }} aria-label="No color" onClick={() => setBg(null)}>
          <Icon name="block" size={16} />
        </button>
        {LABEL_BG.slice(8, 48).map((c) => (
          <button key={c} className={bg === c ? "on" : ""} style={{ background: c }} aria-label={`Color ${c}`} onClick={() => setBg(c)} />
        ))}
      </div>
    </Dialog>
  );
}

function AddAccount({ kind, reauth, onClose }: { kind?: "gmail" | "imap"; reauth?: import("../ipc/types").Account; onClose: () => void }) {
  const [step, setStep] = useState<"choose" | "gmail" | "imap-email" | "imap-details">(
    reauth ? (reauth.kind === "gmail" ? "gmail" : "imap-details") : kind === "imap" ? "imap-email" : kind === "gmail" ? "gmail" : "choose",
  );
  const [email, setEmail] = useState(reauth?.email ?? "");
  const [name, setName] = useState(reauth?.name ?? "");
  const [password, setPassword] = useState("");
  const [smtpPassword, setSmtpPassword] = useState("");
  const [cfg, setCfg] = useState<ImapAccountConfig | null>((reauth?.config as unknown as ImapAccountConfig) ?? null);
  const [found, setFound] = useState<Discovered | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [client, setClient] = useState<boolean | null>(null);
  useEffect(() => {
    void api.googleClientStatus().then((s) => setClient(s.configured));
  }, []);
  const done = async (id: string) => {
    await loadAccounts();
    await setAccount(id);
    toast(reauth ? "Signed in again." : "Account added. Syncing your mail…");
    onClose();
  };
  const gmail = async () => {
    setBusy(true);
    setErr(null);
    try {
      const a = await api.addGmail(email || undefined, reauth?.id);
      await done(a.id);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const discover = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.discover(email.trim());
      const d = r[0];
      if (d?.kind === "gmail") {
        setStep("gmail");
        return;
      }
      setFound(d ?? null);
      setCfg(d?.config ?? null);
      setStep("imap-details");
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const imap = async () => {
    if (!cfg) return;
    setBusy(true);
    setErr(null);
    try {
      const a = await api.addImap({
        email: email.trim(),
        name: name.trim(),
        config: cfg,
        password,
        smtpPassword: smtpPassword || undefined,
        reauthId: reauth?.id,
      });
      await done(a.id);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const server = (which: "imap" | "smtp") =>
    cfg && (
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 8 }}>
        <div className="field">
          <label>{which === "imap" ? "Incoming (IMAP) server" : "Outgoing (SMTP) server"}</label>
          <input value={cfg[which].host} onChange={(e) => setCfg({ ...cfg, [which]: { ...cfg[which], host: e.target.value } })} data-testid={`${which}-host`} />
        </div>
        <div className="field">
          <label>Port</label>
          <input
            value={cfg[which].port}
            onChange={(e) => setCfg({ ...cfg, [which]: { ...cfg[which], port: Number(e.target.value) || 0 } })}
            data-testid={`${which}-port`}
          />
        </div>
        <div className="field">
          <label>Security</label>
          <select
            value={cfg[which].security}
            onChange={(e) => setCfg({ ...cfg, [which]: { ...cfg[which], security: e.target.value as "tls" } })}
            data-testid={`${which}-security`}
          >
            <option value="tls">SSL/TLS</option>
            <option value="starttls">STARTTLS</option>
            <option value="plain">None</option>
          </select>
        </div>
      </div>
    );
  return (
    <Dialog
      title={reauth ? `Sign in to ${reauth.email}` : "Add an account"}
      onClose={onClose}
      testId="add-account"
      actions={
        step === "choose" ? (
          <button className="btn text" onClick={onClose}>
            Cancel
          </button>
        ) : step === "gmail" ? (
          <>
            <button className="btn text" onClick={() => (reauth ? onClose() : setStep("choose"))}>
              {reauth ? "Cancel" : "Back"}
            </button>
            <button className="btn filled" disabled={busy || client === false} onClick={() => void gmail()} data-testid="gmail-signin">
              {busy ? "Waiting for the browser…" : "Sign in with Google"}
            </button>
          </>
        ) : step === "imap-email" ? (
          <>
            <button className="btn text" onClick={() => setStep("choose")}>
              Back
            </button>
            <button
              className="btn filled"
              disabled={busy || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())}
              onClick={() => void discover()}
              data-testid="imap-next"
            >
              {busy ? "Looking up settings…" : "Next"}
            </button>
          </>
        ) : (
          <>
            <button className="btn text" onClick={() => (reauth ? onClose() : setStep("imap-email"))}>
              {reauth ? "Cancel" : "Back"}
            </button>
            <button className="btn filled" disabled={busy || !password || !cfg} onClick={() => void imap()} data-testid="imap-add">
              {busy ? "Checking…" : reauth ? "Sign in" : "Add account"}
            </button>
          </>
        )
      }
    >
      {step === "choose" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, margin: "0 -8px 8px" }}>
          <button className="menu-item" style={{ padding: "14px 12px", borderRadius: 12 }} onClick={() => setStep("gmail")} data-testid="choose-gmail">
            <Icon name="mail" size={24} />
            <span>
              <div style={{ color: "var(--text)", fontWeight: 500 }}>Gmail or Google Workspace</div>
              <div style={{ fontSize: 12 }}>Signs in through your browser. Labels, categories and filters work as on the web.</div>
            </span>
          </button>
          <button className="menu-item" style={{ padding: "14px 12px", borderRadius: 12 }} onClick={() => setStep("imap-email")} data-testid="choose-imap">
            <Icon name="dns" size={24} />
            <span>
              <div style={{ color: "var(--text)", fontWeight: 500 }}>Other mail (iCloud, Outlook, Fastmail, Yahoo, …)</div>
              <div style={{ fontSize: 12 }}>IMAP and SMTP with an app password. Folders show as labels.</div>
            </span>
          </button>
        </div>
      )}
      {step === "gmail" && (
        <>
          {client === false && <ClientSetup onDone={() => setClient(true)} />}
          <p>Your browser opens to sign in. When you've allowed access, come back here. Courier keeps the sign-in in your Keychain.</p>
          {!reauth && (
            <div className="field">
              <label>Email (optional)</label>
              <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@gmail.com" data-testid="gmail-hint" />
            </div>
          )}
        </>
      )}
      {step === "imap-email" && (
        <>
          <div className="field">
            <label>Email address</label>
            <input
              autoFocus
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void discover()}
              data-testid="imap-email"
            />
          </div>
          <div className="field">
            <label>Your name (shown to recipients)</label>
            <input value={name} onChange={(e) => setName(e.target.value)} data-testid="imap-name" />
          </div>
        </>
      )}
      {step === "imap-details" && (
        <>
          {found && (
            <div className="hint" style={{ marginBottom: 8 }}>
              {found.provider} · settings from {found.source}
              {found.help && <div>{found.help}</div>}
            </div>
          )}
          <div className="field">
            <label>Password (an app password for most providers)</label>
            <input autoFocus type="password" value={password} onChange={(e) => setPassword(e.target.value)} data-testid="imap-password" />
          </div>
          {cfg && (
            <>
              <div className="field">
                <label>User name</label>
                <input
                  value={cfg.imap.username}
                  onChange={(e) => setCfg({ ...cfg, imap: { ...cfg.imap, username: e.target.value }, smtp: { ...cfg.smtp, username: e.target.value } })}
                />
              </div>
              {server("imap")}
              {server("smtp")}
              <div className="field">
                <label>Outgoing password (if different)</label>
                <input type="password" value={smtpPassword} onChange={(e) => setSmtpPassword(e.target.value)} />
              </div>
              <label className="checkline">
                <input type="checkbox" checked={cfg.saveSent} onChange={(e) => setCfg({ ...cfg, saveSent: e.target.checked })} /> Save a copy of sent mail in
                the Sent folder
              </label>
            </>
          )}
          {!cfg && <div className="error-box">No settings were found. Enter the servers manually.</div>}
        </>
      )}
      {err && <div className="error-box">{err}</div>}
    </Dialog>
  );
}

function SnoozePicker({ accountId, threadIds, onClose }: { accountId: string; threadIds: string[]; onClose: () => void }) {
  const t = new Date(Date.now() + 86400000);
  const [date, setDate] = useState(`${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`);
  const [time, setTime] = useState("08:00");
  const when = new Date(`${date}T${time}`);
  return (
    <Dialog
      title="Pick date & time"
      onClose={onClose}
      testId="snooze-picker"
      actions={
        <>
          <button className="btn text" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn text"
            disabled={isNaN(when.getTime()) || when.getTime() <= Date.now()}
            onClick={() => (void snooze(when.getTime(), [{ accountId, threadIds }]), onClose())}
            data-testid="snooze-save"
          >
            Save
          </button>
        </>
      }
    >
      <div style={{ display: "flex", gap: 16 }}>
        <div className="field">
          <label>Date</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} data-testid="snooze-date" />
        </div>
        <div className="field">
          <label>Time</label>
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} data-testid="snooze-time" />
        </div>
      </div>
    </Dialog>
  );
}

export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const on = useMail((s) => s.settings.keyboardShortcuts);
  const groups = ["Jumping", "Threadlist selection", "Navigation", "Application", "Actions"] as const;
  const fmt = (k: string) =>
    k
      .split(" ")
      .map((p) => p.replace("Shift+", "⇧"))
      .join(" then ");
  return (
    <Dialog
      title="Keyboard shortcuts"
      wide
      onClose={onClose}
      testId="shortcuts-help"
      actions={
        <button className="btn text" onClick={onClose}>
          Close
        </button>
      }
    >
      {!on && <div className="error-box">Keyboard shortcuts are off. Turn them on in Settings ▸ General.</div>}
      <div className="shortcuts-sheet">
        {groups.map((g) => (
          <div key={g}>
            <h4>{g}</h4>
            {SHORTCUTS.filter((s) => s.group === g && s.keys !== "Enter" && s.keys !== "=").map((s) => (
              <div className="kv" key={s.keys}>
                <span>
                  <kbd>{fmt(s.keys)}</kbd>
                </span>
                <span>{s.label}</span>
              </div>
            ))}
          </div>
        ))}
        <div>
          <h4>Compose and formatting</h4>
          {COMPOSE_SHORTCUTS.map(([k, v]) => (
            <div className="kv" key={k}>
              <span>
                <kbd>{k}</kbd>
              </span>
              <span>{v}</span>
            </div>
          ))}
          <h4>Mac</h4>
          {[
            ["⌘N", "New message"],
            ["⌘1 … ⌘9", "Switch account"],
            ["⌘0", "All inboxes"],
            ["⌘F", "Search mail"],
            ["⌘R / ⇧⌘R / ⇧⌘F", "Reply / reply all / forward"],
            ["⇧⌘N", "Get new mail"],
            ["⌘,", "Settings"],
            ["⌘/", "These shortcuts"],
          ].map(([k, v]) => (
            <div className="kv" key={k}>
              <span>
                <kbd>{k}</kbd>
              </span>
              <span>{v}</span>
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

function ShowOriginal({ accountId, messageId, onClose }: { accountId: string; messageId: string; onClose: () => void }) {
  const [raw, setRaw] = useState<Uint8Array | null>(null);
  const [p, setP] = useState<ParsedMessage | null>(null);
  useEffect(() => {
    void api.raw(accountId, messageId).then((r) => {
      setRaw(r);
      setP(parseMessage(r));
    });
  }, [accountId, messageId]);
  const text = raw ? latin1(raw) : "";
  const auth = p ? authResults(p) : null;
  return (
    <Dialog
      title="Original message"
      wide
      onClose={onClose}
      testId="show-original"
      actions={
        <>
          <button className="btn text" onClick={() => void navigator.clipboard.writeText(text).then(() => toast("Copied to clipboard."))}>
            Copy to clipboard
          </button>
          <button className="btn text" onClick={() => raw && void download("original_msg.eml", raw)}>
            Download original
          </button>
          <button className="btn text" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {p && (
        <table style={{ color: "var(--text)", marginBottom: 12 }}>
          <tbody>
            <tr>
              <td>Message ID</td>
              <td>{p.messageId}</td>
            </tr>
            <tr>
              <td>Created at:</td>
              <td>{p.date ? fullDate(p.date.getTime()) : ""}</td>
            </tr>
            <tr>
              <td>From:</td>
              <td>{p.from.map(formatAddress).join(", ")}</td>
            </tr>
            <tr>
              <td>To:</td>
              <td>{p.to.map(formatAddress).join(", ")}</td>
            </tr>
            <tr>
              <td>Subject:</td>
              <td>{p.subject}</td>
            </tr>
            {auth?.spf && (
              <tr>
                <td>SPF:</td>
                <td>{auth.spf}</td>
              </tr>
            )}
            {auth?.dkim && (
              <tr>
                <td>DKIM:</td>
                <td>{auth.dkim}</td>
              </tr>
            )}
            {auth?.dmarc && (
              <tr>
                <td>DMARC:</td>
                <td>{auth.dmarc}</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
      <div className="original">
        <pre data-testid="original-text">{text}</pre>
      </div>
    </Dialog>
  );
}

export function Toasts() {
  const toasts = useMail((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite" data-testid="toasts">
      {toasts.map((t) => (
        <div key={t.id} className="toast" data-testid="toast">
          <span className="msg-text">{t.text}</span>
          {t.action && (
            <button className="act" onClick={() => (t.action!.run(), dismissToast(t.id))} data-testid="toast-action">
              {t.action.label}
            </button>
          )}
          {t.secondary && (
            <button className="act" onClick={() => (t.secondary!.run(), dismissToast(t.id))} data-testid="toast-secondary">
              {t.secondary.label}
            </button>
          )}
          <IconButton icon="close" label="Dismiss" onClick={() => dismissToast(t.id)} />
        </div>
      ))}
    </div>
  );
}
