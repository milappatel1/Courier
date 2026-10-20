// The account switcher under the avatar: current account, the others (⌘1…⌘9), All inboxes, add another
// account, sign out.
import { useRef } from "react";
import { api, failureText } from "../ipc/api";
import { loadAccounts, openSettings, setAccount, toast, ui, useMail } from "../state/store";
import { Avatar, Icon, IconButton, useOutsideClick } from "./common";

export function AccountMenu({ onClose }: { onClose: () => void }) {
  const accounts = useMail((s) => s.accounts);
  const accountId = useMail((s) => s.accountId);
  const unified = useMail((s) => s.settings.unifiedInbox);
  const counts = useMail((s) => s.labels);
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClick(ref, onClose);
  const current = accounts.find((a) => a.id === accountId);
  const unread = (id: string) => counts[id]?.find((l) => l.id === "INBOX")?.threadsUnread ?? 0;
  const signOut = (id: string) => {
    const a = accounts.find((x) => x.id === id);
    if (!a) return;
    ui({
      confirm: {
        title: `Sign out of ${a.email}?`,
        body: "Courier removes this account's sign-in from the Keychain and deletes its local copy of your mail. Nothing changes on the server.",
        ok: "Sign out",
        run: () =>
          void api
            .removeAccount(id)
            .then(async () => {
              const rest = await loadAccounts();
              if (rest.length) await setAccount(rest[0].id);
              toast(`Signed out of ${a.email}.`);
            })
            .catch((e) => toast(failureText("sign out", e))),
      },
    });
  };
  return (
    <div className="acct-menu" ref={ref} role="dialog" aria-label="Accounts" data-testid="account-menu">
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <IconButton icon="close" label="Close" onClick={onClose} />
      </div>
      <div className="acct-card">
        {current ? (
          <div className="acct-current">
            <Avatar name={current.name} email={current.email} photo={current.photo} color={current.color} size={56} />
            <div className="who">
              <div className="n">{current.name || current.email.split("@")[0]}</div>
              <div className="e">{current.email}</div>
              <div className="e">{current.kind === "gmail" ? "Signed in with Google" : "IMAP account"}</div>
            </div>
            <IconButton icon="settings" label="Account settings" onClick={() => (openSettings("accounts"), onClose())} />
          </div>
        ) : (
          <div className="acct-current">
            <span className="avatar" style={{ width: 56, height: 56, background: "#5f6368" }}>
              <Icon name="stacks" size={24} />
            </span>
            <div className="who">
              <div className="n">All inboxes</div>
              <div className="e">{accounts.length} accounts</div>
            </div>
          </div>
        )}
        {(unified || accounts.length > 1) && (
          <div className={["acct-row"].join(" ")} role="button" tabIndex={0} onClick={() => (void setAccount("all"), onClose())} data-testid="all-inboxes">
            <span className="avatar" style={{ width: 32, height: 32, background: "#5f6368" }}>
              <Icon name="stacks" />
            </span>
            <div className="who">
              <div className="n">All inboxes</div>
              <div className="e">Every account's Inbox together</div>
            </div>
            <span className="kbd">⌘0</span>
          </div>
        )}
        {accounts.map((a, i) => (
          <div
            key={a.id}
            className="acct-row"
            role="button"
            tabIndex={0}
            data-testid={`account-${a.email}`}
            onClick={() => {
              void setAccount(a.id);
              onClose();
            }}
          >
            <Avatar name={a.name} email={a.email} photo={a.photo} color={a.color} size={32} />
            <div className="who">
              <div className="n">
                {a.name || a.email.split("@")[0]} {a.id === accountId && <Icon name="check" size={16} />}
              </div>
              <div className="e">
                {a.email}
                {a.needsReauth ? " · sign in again" : unread(a.id) ? ` · ${unread(a.id)} unread` : ""}
              </div>
            </div>
            {a.needsReauth ? (
              <button className="btn text sm" onClick={(e) => (e.stopPropagation(), ui({ addAccount: { kind: a.kind, reauth: a } }), onClose())}>
                Sign in
              </button>
            ) : (
              i < 9 && <span className="kbd">⌘{i + 1}</span>
            )}
          </div>
        ))}
        <div className="acct-row" role="button" tabIndex={0} onClick={() => (ui({ addAccount: {} }), onClose())} data-testid="add-account">
          <span style={{ width: 32, display: "inline-flex", justifyContent: "center" }}>
            <Icon name="person_add" size={24} />
          </span>
          <div className="who">
            <div className="n">Add another account</div>
          </div>
        </div>
        {current && (
          <div className="acct-row" role="button" tabIndex={0} onClick={() => (signOut(current.id), onClose())} data-testid="sign-out">
            <span style={{ width: 32, display: "inline-flex", justifyContent: "center" }}>
              <Icon name="logout" size={24} />
            </span>
            <div className="who">
              <div className="n">Sign out of {current.email}</div>
            </div>
          </div>
        )}
      </div>
      <div className="acct-foot">Accounts stay on this Mac. Sign-ins are kept in the Keychain.</div>
    </div>
  );
}
