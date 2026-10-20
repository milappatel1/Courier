// "Create filter" (from a search or "Filter messages like these"): criteria, then actions.
import { useState } from "react";
import { criteriaToQuery, describeCriteria, type FilterAction, type FilterCriteria } from "../core/search/advanced";
import { api, errorText } from "../ipc/api";
import { CATEGORIES } from "../core/labels";
import { activeAccount, labelsFor, toast, useMail, SYSTEM_DISPLAY } from "../state/store";
import { Dialog } from "./common";

export function FilterDialog({ criteria, onClose, accountId }: { criteria: FilterCriteria; onClose: () => void; accountId?: string }) {
  const acctId = accountId ?? useMail.getState().accountId;
  const acct = activeAccount();
  const labels = labelsFor(acctId).filter((l) => l.type === "user");
  const [c, setC] = useState<FilterCriteria>(criteria);
  const [step, setStep] = useState<1 | 2>(1);
  const [a, setA] = useState({
    skipInbox: false,
    markRead: false,
    star: false,
    label: "",
    forward: "",
    trash: false,
    neverSpam: false,
    important: "" as "" | "always" | "never",
    category: "",
    applyExisting: false,
  });
  const [err, setErr] = useState<string | null>(null);
  const field = (k: keyof FilterCriteria, label: string) => (
    <div className="field">
      <label>{label}</label>
      <input value={String(c[k] ?? "")} onChange={(e) => setC({ ...c, [k]: e.target.value || undefined })} data-testid={`filter-${k}`} />
    </div>
  );
  const create = async () => {
    const action: FilterAction = { addLabelIds: [], removeLabelIds: [] };
    if (a.skipInbox) action.removeLabelIds!.push("INBOX");
    if (a.markRead) action.removeLabelIds!.push("UNREAD");
    if (a.star) action.addLabelIds!.push("STARRED");
    if (a.label) action.addLabelIds!.push(a.label);
    if (a.trash) action.addLabelIds!.push("TRASH");
    if (a.neverSpam) action.removeLabelIds!.push("SPAM");
    if (a.important === "always") action.addLabelIds!.push("IMPORTANT");
    if (a.important === "never") action.removeLabelIds!.push("IMPORTANT");
    if (a.category) action.addLabelIds!.push(a.category);
    if (a.forward.trim()) action.forward = a.forward.trim();
    try {
      await api.filterCreate(acctId, c as Record<string, unknown>, action as Record<string, unknown>, a.applyExisting);
      toast("Your filter was created.");
      onClose();
    } catch (e) {
      setErr(errorText(e));
    }
  };
  const check = (k: keyof typeof a, label: string) => (
    <label className="checkline">
      <input type="checkbox" checked={!!a[k]} onChange={(e) => setA({ ...a, [k]: e.target.checked })} data-testid={`filter-action-${k}`} /> {label}
    </label>
  );
  return (
    <Dialog
      title={step === 1 ? "Create filter" : "For messages that match this search:"}
      onClose={onClose}
      testId="filter-dialog"
      actions={
        step === 1 ? (
          <>
            <button className="btn text" onClick={onClose}>
              Cancel
            </button>
            <button className="btn filled" disabled={!criteriaToQuery(c).trim()} onClick={() => setStep(2)} data-testid="filter-next">
              Create filter
            </button>
          </>
        ) : (
          <>
            <button className="btn text" onClick={() => setStep(1)}>
              Back
            </button>
            <button className="btn filled" onClick={() => void create()} data-testid="filter-create">
              Create filter
            </button>
          </>
        )
      }
    >
      {step === 1 ? (
        <>
          {field("from", "From")}
          {field("to", "To")}
          {field("subject", "Subject")}
          {field("query", "Has the words")}
          {field("negatedQuery", "Doesn't have")}
          <label className="checkline">
            <input type="checkbox" checked={!!c.hasAttachment} onChange={(e) => setC({ ...c, hasAttachment: e.target.checked || undefined })} /> Has attachment
          </label>
        </>
      ) : (
        <div style={{ color: "var(--text)" }}>
          <div className="hint" style={{ marginBottom: 8, color: "var(--text-2)" }}>
            {describeCriteria(c)}
          </div>
          {check("skipInbox", "Skip the Inbox (Archive it)")}
          {check("markRead", "Mark as read")}
          {check("star", "Star it")}
          <label className="checkline">
            <input type="checkbox" checked={!!a.label} onChange={(e) => setA({ ...a, label: e.target.checked ? (labels[0]?.id ?? "") : "" })} /> Apply the
            label:
            <select value={a.label} onChange={(e) => setA({ ...a, label: e.target.value })} data-testid="filter-label">
              <option value="">Choose label…</option>
              {labels.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          {acct?.kind === "gmail" && (
            <label className="checkline">
              <input type="checkbox" checked={!!a.forward} onChange={(e) => setA({ ...a, forward: e.target.checked ? " " : "" })} /> Forward it to:
              <input value={a.forward.trim()} onChange={(e) => setA({ ...a, forward: e.target.value })} placeholder="verified forwarding address" />
            </label>
          )}
          {check("trash", "Delete it")}
          {check("neverSpam", "Never send it to Spam")}
          <label className="checkline">
            <select value={a.important} onChange={(e) => setA({ ...a, important: e.target.value as "" | "always" | "never" })}>
              <option value="">Importance: no change</option>
              <option value="always">Always mark it as important</option>
              <option value="never">Never mark it as important</option>
            </select>
          </label>
          {acct?.kind === "gmail" && (
            <label className="checkline">
              Categorize as:
              <select value={a.category} onChange={(e) => setA({ ...a, category: e.target.value })}>
                <option value="">Choose category…</option>
                {CATEGORIES.map((x) => (
                  <option key={x.id} value={x.id}>
                    {SYSTEM_DISPLAY[x.id] ?? x.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {check("applyExisting", "Also apply to the conversations that already match.")}
          {err && <div className="error-box">{err}</div>}
        </div>
      )}
    </Dialog>
  );
}
