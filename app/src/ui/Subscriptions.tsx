// Manage subscriptions: the senders whose mail offers a way to unsubscribe, busiest first, each with an
// Unsubscribe button (one-click, an unsubscribe email, or the sender's page) and a way to clear out their
// past mail. Built from the mail Courier has on this Mac.
import { useEffect, useMemo, useState } from "react";
import { listDate } from "../core/dates";
import { parseListUnsubscribe } from "../core/unsubscribe";
import { api, errorText, on } from "../ipc/api";
import type { Subscription } from "../ipc/types";
import { unsubscribe } from "../state/actions";
import { sendSimple } from "../state/compose";
import { accountById, go, loadLabels, toast, ui, useMail, withUndo } from "../state/store";
import { Avatar, Icon, IconButton } from "./common";

type Sort = "recent" | "volume" | "name";

export function Subscriptions() {
  const accountId = useMail((s) => s.accountId);
  const [rows, setRows] = useState<Subscription[] | null>(null);
  const [sort, setSort] = useState<Sort>("volume");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      void api
        .subscriptions(accountId)
        .then((r) => live && (setRows(r), setError(null)))
        .catch((e) => live && setError(errorText(e)));
    load();
    const un = on("mail-changed", load);
    return () => {
      live = false;
      void un.then((f) => f());
    };
  }, [accountId]);
  const sorted = useMemo(() => {
    const list = [...(rows ?? [])];
    if (sort === "recent") list.sort((a, b) => b.lastDate - a.lastDate);
    else if (sort === "name") list.sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
    else list.sort((a, b) => b.recent - a.recent || b.total - a.total);
    return list;
  }, [rows, sort]);
  const active = sorted.filter((r) => !r.unsubscribed);
  const done = sorted.filter((r) => r.unsubscribed);
  const markDone = (r: Subscription) => {
    void api.markUnsubscribed(r.accountId, r.email).catch(() => {});
    setRows((rs) => (rs ?? []).map((x) => (x.email === r.email && x.accountId === r.accountId ? { ...x, unsubscribed: Date.now() } : x)));
  };
  return (
    <div className="subs" data-testid="subscriptions">
      <h1 className="subs-title">Manage subscriptions</h1>
      <div className="subs-scroll">
        <div className="subs-head">
          <span className="subs-intro">
            Senders whose mail offers a way to unsubscribe, from the mail on this Mac. Mail you already have stays until you clear it.
          </span>
          <label className="subs-sort">
            <span className="light">Sort by</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} data-testid="subs-sort" aria-label="Sort subscriptions">
              <option value="volume">Most mail</option>
              <option value="recent">Newest</option>
              <option value="name">Name</option>
            </select>
          </label>
        </div>
        {error && <div className="empty">{error}</div>}
        {rows && !rows.length && (
          <div className="empty" data-testid="subs-empty">
            <h3>No subscriptions found.</h3>
            <div>Newsletters and mailing lists show up here once their mail arrives.</div>
          </div>
        )}
        {active.map((r) => (
          <SubRow key={`${r.accountId}:${r.email}`} r={r} onDone={() => markDone(r)} />
        ))}
        {done.length > 0 && (
          <>
            <div className="subs-section">Unsubscribed</div>
            {done.map((r) => (
              <SubRow key={`${r.accountId}:${r.email}`} r={r} onDone={() => {}} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function SubRow({ r, onDone }: { r: Subscription; onDone: () => void }) {
  const multi = useMail((s) => s.accountId === "all");
  const how = parseListUnsubscribe(r.listUnsubscribe || null, r.listUnsubscribePost || null);
  const name = r.name || r.email;
  const showMail = () => go({ label: null, query: `from:${r.email}` });
  return (
    <div className="sub-row" data-testid="sub-row" role="group" aria-label={name}>
      <button type="button" className="sub-main" onClick={showMail} data-testid="sub-open" title={`Show mail from ${r.email}`}>
        <Avatar name={name} email={r.email} size={40} />
        <span className="sub-text">
          <span className="sub-name">{name}</span>
          <span className="sub-meta">
            {r.email}
            {multi && <> · {accountById(r.accountId)?.email}</>}
          </span>
          <span className="sub-meta">
            {r.recent > 0 ? `${r.recent} in the last 30 days` : "Nothing in the last 30 days"} · {r.total} in all · newest {listDate(r.lastDate)}
          </span>
        </span>
      </button>
      <div className="sub-actions">
        <IconButton icon="delete_sweep" label={`Move all mail from ${name} to Trash`} onClick={() => clearSender(r)} testId="sub-clear" />
        {r.unsubscribed ? (
          <span className="sub-done" data-testid="sub-done">
            <Icon name="check" size={18} /> Unsubscribed
          </span>
        ) : (
          <IconButton
            icon="unsubscribe"
            label={how ? `Unsubscribe from ${name}` : "No unsubscribe option"}
            disabled={!how}
            onClick={() =>
              void unsubscribe(r.accountId, r.listUnsubscribe, r.listUnsubscribePost, name, (to, s, b) => sendSimple(r.accountId, to, s, b), onDone)
            }
            testId="sub-unsubscribe"
          />
        )}
      </div>
    </div>
  );
}

/** Trash every conversation from this sender (all of it on the server, not just what's cached). */
function clearSender(r: Subscription) {
  const name = r.name || r.email;
  ui({
    confirm: {
      title: `Move all mail from ${name} to Trash?`,
      body: `Every conversation from ${r.email} goes to Trash, including older mail that isn't on this Mac. You can undo this right after.`,
      ok: "Move to Trash",
      run: () =>
        void api
          .bulkModify(
            { accountId: r.accountId, label: null, category: null, query: `from:${r.email}`, page: 0, pageSize: 50, conversations: true },
            ["TRASH"],
            [],
            [],
          )
          .then((ids) => {
            withUndo(`${ids.length} message${ids.length === 1 ? "" : "s"} from ${name} moved to Trash.`, () =>
              api.modifyMessages(r.accountId, ids, [], ["TRASH"]),
            );
            void loadLabels(r.accountId);
          })
          .catch((e) => toast(`Couldn't move them: ${errorText(e)}`)),
    },
  });
}
