// Secondary windows: a popped-out compose window, a conversation in its own window, the print view and an
// .eml viewer. Each gets its payload from the opener through window_take.
import { useEffect, useState } from "react";
import { fullDate, headerDate } from "./core/dates";
import { formatAddress } from "./core/addresses";
import { parseMessage, type ParsedMessage } from "./core/mime/parse";
import { api } from "./ipc/api";
import type { MessageRow } from "./ipc/types";
import { buildRaw } from "./state/compose";
import { init, setState, useMail, type ComposeData } from "./state/store";
import { adoptCompose, ComposeWindow, serializeCompose } from "./ui/Compose";
import { Conversation } from "./ui/Conversation";
import { Dialogs, Toasts } from "./ui/Dialogs";
import { MessageFrame } from "./ui/MessageFrame";
import { Avatar, TooltipHost } from "./ui/common";

const closeSelf = () => void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().close()).catch(() => window.close());

export function ComposePage({ id }: { id: string }) {
  const composes = useMail((s) => s.composes);
  const [cid, setCid] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      await init();
      const payload = await api.windowTake<ReturnType<typeof serializeCompose>>(id);
      if (payload) setCid(adoptCompose(payload).id);
      else {
        const { openCompose } = await import("./state/compose");
        setCid((await openCompose()) ?? null);
      }
    })();
  }, [id]);
  useEffect(() => {
    // The window closes when its compose is sent, discarded or closed.
    if (cid && !composes.some((c) => c.id === cid)) setTimeout(closeSelf, 300);
  }, [composes, cid]);
  const c = composes.find((x) => x.id === cid);
  return (
    <div style={{ height: "100vh", display: "flex", paddingTop: 28 }} data-tauri-drag-region>
      {c && <ComposeWindow c={{ ...c, minimized: false, fullscreen: false }} popout />}
      <Dialogs />
      <Toasts />
      <TooltipHost />
    </div>
  );
}

export function ThreadPage({ id }: { id: string }) {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    void (async () => {
      await init();
      const ref = await api.windowTake<{ accountId: string; threadId: string }>(id);
      if (!ref) return;
      setState((s) => ({ accountId: ref.accountId, route: { ...s.route, thread: ref } }));
      const { loadThread } = await import("./state/store");
      await loadThread(ref);
      setOk(true);
    })();
  }, [id]);
  return (
    <div className="app" style={{ gridTemplateRows: "36px 1fr" }}>
      <div className="drag" data-tauri-drag-region />
      <main className="main" style={{ margin: "0 12px 12px" }}>
        {ok && <Conversation split />}
      </main>
      <Dialogs />
      <Toasts />
      <TooltipHost />
    </div>
  );
}

interface PrintPayload {
  accountId?: string;
  threadId?: string;
  messageId?: string;
  compose?: ReturnType<typeof serializeCompose>;
}

export function PrintPage({ id }: { id: string }) {
  const [msgs, setMsgs] = useState<{ row: Partial<MessageRow>; parsed: ParsedMessage }[]>([]);
  const [subject, setSubject] = useState("");
  const [account, setAccount] = useState("");
  useEffect(() => {
    void (async () => {
      await init();
      const p = await api.windowTake<PrintPayload>(id);
      if (!p) return;
      if (p.compose) {
        const { deserializeCompose } = await import("./ui/Compose");
        const c: ComposeData = deserializeCompose(p.compose);
        const parsed = parseMessage(buildRaw(c).raw);
        setSubject(c.subject);
        setMsgs([{ row: { internalDate: Date.now(), fromName: "", fromEmail: c.from }, parsed }]);
      } else if (p.accountId && p.threadId) {
        const d = await api.thread(p.accountId, p.threadId);
        const pick = d.messages.filter((m) => !m.labels.includes("DRAFT") && (!p.messageId || m.id === p.messageId));
        const out = await Promise.all(pick.map(async (m) => ({ row: m, parsed: parseMessage(await api.raw(p.accountId!, m.id)) })));
        setSubject(d.messages[0]?.subject ?? "");
        setAccount(useMail.getState().accounts.find((a) => a.id === p.accountId)?.email ?? "");
        setMsgs(out);
      }
      // Print once everything rendered (the print command is a no-op in test runs).
      setTimeout(() => void api.printWindow(), 900);
    })();
  }, [id]);
  return (
    <div className="print-doc" data-testid="print-view">
      <div className="no-print" style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginBottom: 12 }}>
        <button className="btn outline sm" onClick={() => void api.printWindow()}>
          Print
        </button>
        <button className="btn text sm" onClick={closeSelf}>
          Close
        </button>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", color: "#5f6368", fontSize: 12 }}>
        <span>Courier</span>
        <span>{account}</span>
      </div>
      <h1>{subject || "(no subject)"}</h1>
      <div style={{ color: "#5f6368", fontSize: 12, marginBottom: 8 }}>
        {msgs.length} message{msgs.length === 1 ? "" : "s"}
      </div>
      {msgs.map(({ row, parsed }, i) => (
        <div key={i} className="pm">
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <b>{parsed.from.map(formatAddress).join(", ") || row.fromEmail}</b>
            <span style={{ color: "#5f6368" }}>{fullDate(row.internalDate ?? Date.now())}</span>
          </div>
          <div style={{ color: "#5f6368", fontSize: 12, marginBottom: 8 }}>
            To: {parsed.to.map(formatAddress).join(", ")}
            {parsed.cc.length ? ` · Cc: ${parsed.cc.map(formatAddress).join(", ")}` : ""}
          </div>
          <MessageFrame parsed={parsed} allowRemote={useMail.getState().settings.images === "always"} showQuoted />
          {parsed.attachments.filter((a) => !a.inline).length > 0 && (
            <div style={{ marginTop: 8, color: "#5f6368" }}>
              Attachments:{" "}
              {parsed.attachments
                .filter((a) => !a.inline)
                .map((a) => a.filename)
                .join(", ")}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function EmlPage({ id }: { id: string }) {
  const [p, setP] = useState<ParsedMessage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      await init();
      const payload = await api.windowTake<{ path: string }>(id);
      if (!payload) return;
      try {
        setP(parseMessage(await api.readFile(payload.path)));
      } catch (e) {
        setErr(String(e));
      }
    })();
  }, [id]);
  return (
    <div className="app" style={{ gridTemplateRows: "36px 1fr" }}>
      <div className="drag" data-tauri-drag-region />
      <main className="main conv-card" style={{ margin: "0 12px 12px", overflow: "auto" }} data-testid="eml-view">
        {err && <div className="empty">{err}</div>}
        {p && (
          <>
            <div className="conv-head">
              <h2 className="conv-subject">{p.subject || "(no subject)"}</h2>
            </div>
            <div className="msg" style={{ borderTop: 0 }}>
              <div className="msg-avatar">
                <Avatar name={p.from[0]?.name ?? ""} email={p.from[0]?.email ?? "?"} size={40} />
              </div>
              <div>
                <div className="msg-head">
                  <div className="msg-from">
                    <b>{p.from[0]?.name || p.from[0]?.email}</b> {p.from[0]?.name && <span className="addr">&lt;{p.from[0]?.email}&gt;</span>}
                  </div>
                  <span className="msg-time">{p.date ? headerDate(p.date.getTime()) : ""}</span>
                </div>
                <div className="msg-to">to {p.to.map((a) => a.name || a.email).join(", ")}</div>
                <div className="msg-body">
                  <MessageFrame parsed={p} allowRemote={false} showQuoted={false} />
                </div>
              </div>
            </div>
          </>
        )}
      </main>
      <TooltipHost />
    </div>
  );
}
