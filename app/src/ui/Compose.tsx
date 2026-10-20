// Compose: stacked windows at the bottom right (minimise, full screen, pop-out), inline replies, the rich
// text editor with its formatting bar, recipients with autocomplete, attachments and inline images,
// emoji, links, signatures, templates, plain-text mode, spell check and schedule send.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { parseAddressList, type Address } from "../core/addresses";
import { base64Decode, base64Encode, humanSize, randomToken } from "../core/bytes";
import { schedulePresets } from "../core/dates";
import { encodedSize, SEND_LIMIT_BYTES } from "../core/mime/build";
import { signatureHtml } from "../core/compose";
import { htmlToText } from "../core/text";
import { api, errorText, failureText } from "../ipc/api";
import type { Contact, Signature, Template } from "../ipc/types";
import {
  attachmentFromFile,
  changeCompose,
  checkBeforeSend,
  closeCompose,
  discardCompose,
  plainToggle,
  saveDraft,
  sendCompose,
  templateInto,
} from "../state/compose";
import { FONTS, SIZES } from "../state/settings";
import { useShallow } from "zustand/react/shallow";
import { removeCompose, toast, ui, updateCompose, useMail, addCompose, newComposeId, labelsFor, type Attachment, type ComposeData } from "../state/store";
import { Avatar, Dialog, FileIcon, Icon, IconButton, Menu, anchorOf, useFollowAnchor, type MenuEntry } from "./common";

type Anchor = ReturnType<typeof anchorOf>;

/** Compose windows side by side from the right; the ones that don't fit the window's width fold to their title bar. */
export function ComposeDock() {
  const composes = useMail(useShallow((s) => s.composes.filter((c) => c.placement === "dock")));
  const full = composes.find((c) => c.fullscreen && !c.minimized);
  const width = useMail((s) => s.width);
  const [raised, setRaised] = useState<Record<string, number>>({});
  // The newest (or last opened) first; each open window needs 575 px, a folded one 276.
  const order = [...composes].reverse().sort((a, b) => (raised[b.id] ?? 0) - (raised[a.id] ?? 0));
  const folded = new Set<string>();
  let room = width - 61 - 16;
  order.forEach((c, i) => {
    // The first one always stays open (at phone width it fills the window).
    if (i > 0 && !c.minimized && !c.fullscreen && room < 575) folded.add(c.id);
    room -= c.minimized || folded.has(c.id) ? 276 : 575;
  });
  return (
    <>
      {full && <div className="compose-full-scrim" onClick={() => updateCompose(full.id, { fullscreen: false })} />}
      <div className="compose-dock" aria-label="Compose windows">
        {[...composes].reverse().map((c) => (
          <ComposeWindow key={c.id} c={c} folded={folded.has(c.id)} onRaise={() => setRaised((r) => ({ ...r, [c.id]: Date.now() }))} />
        ))}
      </div>
    </>
  );
}

export function ComposeWindow({ c, popout, folded, onRaise }: { c: ComposeData; popout?: boolean; folded?: boolean; onRaise?: () => void }) {
  const title = c.subject.trim() || (c.reply ? (c.reply.kind === "forward" ? "Forward" : "Reply") : "New Message");
  const popOut = async () => {
    await saveDraft(c.id);
    const latest = useMail.getState().composes.find((x) => x.id === c.id) ?? c;
    await api.windowOpen("compose", serializeCompose(latest), title);
    removeCompose(c.id);
  };
  return (
    <section
      className={["compose", c.minimized || folded ? "min" : "", c.fullscreen && !c.minimized && !popout ? "full" : ""].join(" ")}
      role="dialog"
      aria-label={title}
      data-testid="compose-window"
      style={popout ? { width: "100%", height: "100vh", maxHeight: "none", margin: 0, borderRadius: 0, boxShadow: "none" } : undefined}
    >
      {!popout && (
        <div
          className="compose-head"
          onClick={() => (folded ? (onRaise?.(), updateCompose(c.id, { minimized: false })) : updateCompose(c.id, { minimized: !c.minimized }))}
          data-testid="compose-head"
        >
          <span className="title">{title}</span>
          <IconButton
            icon="minimize"
            label={c.minimized ? "Restore" : "Minimize"}
            onClick={() => updateCompose(c.id, { minimized: !c.minimized })}
            testId="compose-minimize"
          />
          <IconButton
            icon={c.fullscreen ? "close_fullscreen" : "open_in_full"}
            label={c.fullscreen ? "Exit full screen" : "Full screen (⇧ for pop-out)"}
            onClick={(e) => (e.shiftKey ? void popOut() : updateCompose(c.id, { fullscreen: !c.fullscreen, minimized: false }))}
            testId="compose-fullscreen"
          />
          <IconButton icon="close" label="Save & close" onClick={() => void closeCompose(c.id)} testId="compose-close" />
        </div>
      )}
      {!c.minimized && <ComposeBody c={c} onPopOut={popout ? undefined : () => void popOut()} />}
    </section>
  );
}

export function ComposeInline({ c }: { c: ComposeData }) {
  return (
    <section className="inline-compose" aria-label="Reply" data-testid="inline-compose">
      <ComposeBody c={c} inline onPopOut={() => updateCompose(c.id, { placement: "dock" })} />
    </section>
  );
}

function ComposeBody({ c, inline, onPopOut }: { c: ComposeData; inline?: boolean; onPopOut?: () => void }) {
  const accounts = useMail((s) => s.accounts);
  const settings = useMail((s) => s.settings);
  const acct = accounts.find((a) => a.id === c.accountId);
  const [fmt, setFmt] = useState(false);
  const [menu, setMenu] = useState<{ kind: "send" | "more" | "sig" | "emoji" | "font" | "size" | "color" | "align"; anchor: Anchor } | null>(null);
  const [dialog, setDialog] = useState<null | "link" | "schedule" | "spell" | { confirm: string; run: () => void } | { error: string }>(null);
  const [dropping, setDropping] = useState(false);
  const [sigs, setSigs] = useState<Signature[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [sendAs, setSendAs] = useState<string[]>([]);
  const editor = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const savedRange = useRef<Range | null>(null);
  useEffect(() => {
    void api
      .signatures(c.accountId)
      .then(setSigs)
      .catch(() => {});
    if (settings.templates)
      void api
        .templates()
        .then(setTemplates)
        .catch(() => {});
    void api
      .sendAs(c.accountId)
      .then((l) => setSendAs(l.filter((x) => x.verificationStatus !== "pending").map((x) => String(x.sendAsEmail))))
      .catch(() => {});
  }, [c.accountId, settings.templates]);
  // The editor's content is owned by the DOM; React sets it once.
  useEffect(() => {
    if (editor.current && editor.current.innerHTML !== c.html) editor.current.innerHTML = c.html;
    if (c.focus === "body") setTimeout(() => focusEditorStart(editor.current), 30);
  }, [c.id, c.plain]);
  const sync = () => {
    if (editor.current) changeCompose(c.id, { html: editor.current.innerHTML });
  };
  const exec = (cmd: string, value?: string) => {
    editor.current?.focus();
    if (savedRange.current) {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(savedRange.current);
    }
    document.execCommand("styleWithCSS", false, "false");
    document.execCommand(cmd, false, value);
    sync();
  };
  const saveRange = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && editor.current?.contains(sel.anchorNode)) savedRange.current = sel.getRangeAt(0).cloneRange();
  };
  const addFiles = async (files: FileList | File[], inlineImages = false) => {
    const list = Array.from(files);
    const atts = await Promise.all(list.map(attachmentFromFile));
    const total = [...c.attachments, ...atts].reduce((n, a) => n + a.size, 0);
    if (encodedSize(total) > SEND_LIMIT_BYTES) {
      setDialog({
        error: `Large files: the attachments would be ${humanSize(total)}. Messages can carry up to 25 MB of attachments; share bigger files another way.`,
      });
      return;
    }
    const images = inlineImages ? atts.filter((a) => a.mime.startsWith("image/")) : [];
    const others = atts.filter((a) => !images.includes(a));
    const latest = useMail.getState().composes.find((x) => x.id === c.id) ?? c;
    const inlineMap = { ...latest.inlineImages };
    for (const img of images) {
      const url = URL.createObjectURL(new Blob([img.data as BlobPart], { type: img.mime }));
      inlineMap[url] = { ...img, id: `img_${randomToken(6)}` };
      exec("insertHTML", `<img src="${url}" alt="${img.name.replace(/"/g, "")}" style="max-width:100%">`);
    }
    changeCompose(c.id, { attachments: [...latest.attachments, ...others], inlineImages: inlineMap, html: editor.current?.innerHTML ?? latest.html });
  };
  const sendAndArchive = useMail((s) => s.settings.sendAndArchive);
  const doSend = async (opts: { sendAt?: number; archive?: boolean } = {}) => {
    sync();
    const latest = useMail.getState().composes.find((x) => x.id === c.id) ?? c;
    const check = checkBeforeSend(latest);
    if (!check.ok) return setDialog({ error: check.error! });
    if (check.confirm) return setDialog({ confirm: check.confirm, run: () => void sendCompose(c.id, { sendAt: opts.sendAt, archiveThread: opts.archive }) });
    await sendCompose(c.id, { sendAt: opts.sendAt, archiveThread: opts.archive });
  };
  const onKey = (e: React.KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (e.metaKey && k === "enter") {
      e.preventDefault();
      void doSend();
    } else if (e.metaKey && e.shiftKey && k === "c") {
      e.preventDefault();
      updateCompose(c.id, { showCc: true });
    } else if (e.metaKey && e.shiftKey && k === "b") {
      e.preventDefault();
      updateCompose(c.id, { showBcc: true });
    } else if (e.metaKey && e.shiftKey && k === "d") {
      e.preventDefault();
      void discardCompose(c.id);
    } else if (e.metaKey && k === "k") {
      e.preventDefault();
      saveRange();
      setDialog("link");
    } else if (e.metaKey && e.shiftKey && (k === "7" || k === "&")) {
      e.preventDefault();
      exec("insertOrderedList");
    } else if (e.metaKey && e.shiftKey && (k === "8" || k === "*")) {
      e.preventDefault();
      exec("insertUnorderedList");
    } else if (e.metaKey && e.shiftKey && (k === "9" || k === "(")) {
      e.preventDefault();
      exec("formatBlock", "blockquote");
    } else if (e.metaKey && k === "[") {
      e.preventDefault();
      exec("outdent");
    } else if (e.metaKey && k === "]") {
      e.preventDefault();
      exec("indent");
    } else if (e.metaKey && e.shiftKey && k === "x") {
      e.preventDefault();
      exec("strikeThrough");
    } else if (e.metaKey && k === "\\") {
      e.preventDefault();
      exec("removeFormat");
    } else if (e.metaKey && e.shiftKey && k === "l") {
      e.preventDefault();
      exec("justifyLeft");
    } else if (e.metaKey && e.shiftKey && k === "e") {
      e.preventDefault();
      exec("justifyCenter");
    } else if (e.metaKey && e.shiftKey && k === "r") {
      e.preventDefault();
      exec("justifyRight");
    }
    e.stopPropagation(); // keep list shortcuts out of compose
  };
  const insertSignature = (s: Signature | null) => {
    const ed = editor.current;
    if (!ed) return;
    ed.querySelector("[data-courier-signature]")?.remove();
    if (s) ed.insertAdjacentHTML("beforeend", signatureHtml(s.html));
    changeCompose(c.id, { html: ed.innerHTML, signatureId: s?.id ?? null });
  };
  const userLabels = labelsFor(c.accountId).filter((l) => l.type === "user");
  const moreItems = (): MenuEntry[] => [
    ...(acct?.kind === "gmail" && userLabels.length
      ? [
          {
            label: "Label",
            testId: "compose-label",
            // Applied to the conversation once the message is sent.
            submenu: userLabels.map((l) => ({
              label: l.name,
              checked: (c.labels ?? []).includes(l.id),
              keepOpen: true,
              testId: `compose-label-${l.name}`,
              run: () =>
                changeCompose(c.id, {
                  labels: (c.labels ?? []).includes(l.id) ? (c.labels ?? []).filter((x) => x !== l.id) : [...(c.labels ?? []), l.id],
                }),
            })),
          } as MenuEntry,
          { sep: true },
        ]
      : []),
    {
      label: "Default to full screen",
      checked: settings.compose.fullScreenDefault,
      run: () =>
        void import("../state/store").then((s) => s.setSetting("compose", { ...settings.compose, fullScreenDefault: !settings.compose.fullScreenDefault })),
    },
    { sep: true },
    ...(settings.templates
      ? [
          {
            label: "Templates",
            submenu: [
              { head: "Insert template" },
              ...(templates.length
                ? templates.map((t) => ({
                    label: t.name,
                    run: () => (changeCompose(c.id, templateInto(c, t)), editor.current && (editor.current.innerHTML = t.html + editor.current.innerHTML)),
                  }))
                : [{ label: "No saved templates", disabled: true }]),
              { sep: true },
              {
                label: "Save draft as template",
                submenu: [
                  {
                    label: "Save as new template",
                    run: () => {
                      sync();
                      const latest = useMail.getState().composes.find((x) => x.id === c.id) ?? c;
                      ui({
                        ask: {
                          title: "Save as new template",
                          label: "Template name",
                          value: latest.subject || "Template",
                          ok: "Save",
                          run: (name) =>
                            void api
                              .templateSave({ name, subject: latest.subject, html: latest.html })
                              .then(() => (toast("Template saved."), api.templates().then(setTemplates))),
                        },
                      });
                    },
                  },
                  ...templates.map((t) => ({
                    label: `Overwrite "${t.name}"`,
                    run: () => (
                      sync(),
                      void api
                        .templateSave({ id: t.id, name: t.name, subject: c.subject, html: editor.current?.innerHTML ?? c.html })
                        .then(() => toast("Template saved."))
                    ),
                  })),
                ],
              },
              ...(templates.length
                ? [
                    {
                      label: "Delete template",
                      submenu: templates.map((t) => ({
                        label: t.name,
                        run: () => void api.templateDelete(t.id).then(() => api.templates().then(setTemplates)),
                      })),
                    },
                  ]
                : []),
            ],
          } as MenuEntry,
        ]
      : []),
    {
      label: "Plain text mode",
      checked: c.plain,
      run: () => (sync(), changeCompose(c.id, plainToggle(useMail.getState().composes.find((x) => x.id === c.id) ?? c, !c.plain))),
    },
    { sep: true },
    {
      label: "Print",
      run: () => void api.windowOpen("print", { compose: serializeCompose(useMail.getState().composes.find((x) => x.id === c.id) ?? c) }, "Print"),
    },
    { label: "Check spelling", run: () => setDialog("spell") },
    ...(onPopOut && !inline ? [{ label: "Open in a new window", run: onPopOut }] : []),
  ];
  const chooseFrom = sendAs.length > 1 || (acct?.aliases.length ?? 0) > 1;
  const sendLabel = useMemo(() => (navigator.platform.includes("Mac") ? "Send (⌘Enter)" : "Send (Ctrl-Enter)"), []);
  return (
    <div
      style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, position: "relative" }}
      onKeyDown={onKey}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files") || e.dataTransfer.types.includes("application/x-courier-threads")) {
          e.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={(e) => {
        if (!(e.currentTarget as Element).contains(e.relatedTarget as Node)) setDropping(false);
      }}
      onDrop={(e) => {
        // Conversations dragged from the list are attached as messages (.eml), as forwarding them would.
        const threads = e.dataTransfer.getData("application/x-courier-threads");
        if (threads) {
          e.preventDefault();
          setDropping(false);
          void attachConversations(c.id, JSON.parse(threads) as { accountId: string; threadIds: string[] });
          return;
        }
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDropping(false);
        const overBody = (e.target as Element).closest?.(".compose-body");
        void addFiles(e.dataTransfer.files, !!overBody);
      }}
    >
      {inline && (
        <div className="compose-head" style={{ background: "transparent" }}>
          <Icon name={c.reply?.kind === "forward" ? "forward" : c.reply?.kind === "reply-all" ? "reply_all" : "reply"} />
          <span className="title" style={{ marginLeft: 8 }}>
            {c.reply?.kind === "forward" ? "Forward" : c.to.map((a) => a.name || a.email).join(", ")}
          </span>
          {onPopOut && <IconButton icon="open_in_new" label="Pop out reply" onClick={onPopOut} />}
        </div>
      )}
      <div className="compose-fields">
        {chooseFrom && (
          <div className="cf-row">
            <span className="lab">From</span>
            <select
              value={c.from}
              onChange={(e) => changeCompose(c.id, { from: e.target.value })}
              style={{ border: 0, background: "transparent", fontSize: 14, flex: 1 }}
              aria-label="From"
            >
              {[...new Set([acct?.email ?? "", ...sendAs, ...(acct?.aliases ?? [])].filter(Boolean))].map((a) => (
                <option key={a} value={a}>
                  {acct?.name ? `${acct.name} <${a}>` : a}
                </option>
              ))}
            </select>
          </div>
        )}
        <RecipientRow
          c={c}
          field="to"
          label="To"
          extra={
            <span className="ccbcc">
              {!c.showCc && (
                <button onClick={() => updateCompose(c.id, { showCc: true })} data-testid="show-cc">
                  Cc
                </button>
              )}
              {!c.showBcc && (
                <button onClick={() => updateCompose(c.id, { showBcc: true })} data-testid="show-bcc">
                  Bcc
                </button>
              )}
            </span>
          }
          autoFocus={c.focus === "to"}
        />
        {c.showCc && <RecipientRow c={c} field="cc" label="Cc" />}
        {c.showBcc && <RecipientRow c={c} field="bcc" label="Bcc" />}
        {(!inline || c.reply?.kind === "forward") && (
          <div className="cf-row subject">
            <input
              className="plain"
              value={c.subject}
              placeholder="Subject"
              aria-label="Subject"
              data-testid="compose-subject"
              onChange={(e) => changeCompose(c.id, { subject: e.target.value })}
            />
          </div>
        )}
      </div>
      <div className="compose-body" onClick={(e) => e.target === e.currentTarget && editor.current?.focus()}>
        <div
          ref={editor}
          className="editor selectable"
          contentEditable
          suppressContentEditableWarning
          spellCheck
          role="textbox"
          aria-multiline="true"
          aria-label="Message Body"
          data-testid="compose-body"
          style={
            c.plain
              ? { fontFamily: "Menlo, monospace", fontSize: 13 }
              : { fontFamily: FONTS[settings.defaultFont.family]?.css, fontSize: SIZES[settings.defaultFont.size]?.css, color: settings.defaultFont.color }
          }
          onInput={sync}
          onBlur={() => (saveRange(), sync())}
          onKeyUp={saveRange}
          onMouseUp={saveRange}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files);
            if (files.length) {
              e.preventDefault();
              void addFiles(files, true);
              return;
            }
            if (c.plain) {
              e.preventDefault();
              document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
            }
          }}
        />
        {c.reply?.quotedHtml && (
          <button
            type="button"
            className="trimmed"
            aria-label="Show trimmed content"
            data-tip="Show trimmed content"
            data-testid="compose-show-quote"
            onClick={() => {
              if (!editor.current) return;
              editor.current.insertAdjacentHTML("beforeend", `<br>${c.reply!.quotedHtml}`);
              changeCompose(c.id, { html: editor.current.innerHTML, reply: { ...c.reply!, quotedHtml: "" } });
            }}
          >
            <Icon name="more_horiz" />
          </button>
        )}
      </div>
      {(c.attachments.length > 0 || c.forwarded.length > 0) && (
        <div className="compose-attachments" data-testid="compose-attachments">
          {c.attachments.map((a) => (
            <div key={a.id} className="c-att">
              <FileIcon mime={a.mime} name={a.name} />
              <span className="grow">{a.name}</span>
              <span className="size">({humanSize(a.size)})</span>
              <IconButton
                icon="close"
                label={`Remove ${a.name}`}
                size="xs"
                onClick={() => changeCompose(c.id, { attachments: c.attachments.filter((x) => x.id !== a.id) })}
              />
            </div>
          ))}
          {c.forwarded.map((f, i) => (
            <div key={`f${i}`} className="c-att">
              <FileIcon mime="message/rfc822" />
              <span className="grow">{f.filename}</span>
              <span className="size">({humanSize(f.raw.length)})</span>
              <IconButton
                icon="close"
                label={`Remove ${f.filename}`}
                size="xs"
                onClick={() => changeCompose(c.id, { forwarded: c.forwarded.filter((_, j) => j !== i) })}
              />
            </div>
          ))}
        </div>
      )}
      {fmt && !c.plain && (
        <div className="fmt-bar" role="toolbar" aria-label="Formatting options" onMouseDown={(e) => e.preventDefault()}>
          <IconButton icon="undo" label="Undo (⌘Z)" onClick={() => exec("undo")} />
          <IconButton icon="redo" label="Redo (⌘Y)" onClick={() => exec("redo")} />
          <span className="fmt-sep" />
          <button
            type="button"
            className="font-pick"
            aria-label="Font"
            data-tip="Font"
            onClick={(e) => (saveRange(), setMenu({ kind: "font", anchor: anchorOf(e.currentTarget) }))}
          >
            Sans Serif <Icon name="arrow_drop_down" size={18} />
          </button>
          <span className="fmt-sep" />
          <IconButton icon="format_size" label="Size" onClick={(e) => (saveRange(), setMenu({ kind: "size", anchor: anchorOf(e.currentTarget) }))} />
          <span className="fmt-sep" />
          <IconButton icon="format_bold" label="Bold (⌘B)" onClick={() => exec("bold")} testId="fmt-bold" />
          <IconButton icon="format_italic" label="Italic (⌘I)" onClick={() => exec("italic")} testId="fmt-italic" />
          <IconButton icon="format_underlined" label="Underline (⌘U)" onClick={() => exec("underline")} />
          <IconButton
            icon="format_color_text"
            label="Text color"
            onClick={(e) => (saveRange(), setMenu({ kind: "color", anchor: anchorOf(e.currentTarget) }))}
          />
          <span className="fmt-sep" />
          <IconButton icon="format_align_left" label="Align" onClick={(e) => (saveRange(), setMenu({ kind: "align", anchor: anchorOf(e.currentTarget) }))} />
          <IconButton icon="format_list_numbered" label="Numbered list (⌘⇧7)" onClick={() => exec("insertOrderedList")} />
          <IconButton icon="format_list_bulleted" label="Bulleted list (⌘⇧8)" onClick={() => exec("insertUnorderedList")} testId="fmt-bullets" />
          <IconButton icon="format_indent_decrease" label="Indent less (⌘[)" onClick={() => exec("outdent")} />
          <IconButton icon="format_indent_increase" label="Indent more (⌘])" onClick={() => exec("indent")} />
          <IconButton icon="format_quote" label="Quote (⌘⇧9)" onClick={() => exec("formatBlock", "blockquote")} />
          <IconButton icon="format_strikethrough" label="Strikethrough (⌘⇧X)" onClick={() => exec("strikeThrough")} />
          <IconButton icon="format_clear" label="Remove formatting (⌘\)" onClick={() => exec("removeFormat")} />
        </div>
      )}
      <div className="compose-bottom">
        <span className="send-split">
          <button type="button" className="send-btn" onClick={() => void doSend()} aria-label={sendLabel} data-tip={sendLabel} data-testid="compose-send">
            Send
          </button>
          <button
            type="button"
            className="send-more"
            aria-label="More send options"
            data-tip="More send options"
            onClick={(e) => setMenu({ kind: "send", anchor: anchorOf(e.currentTarget) })}
            data-testid="send-options"
          >
            <Icon name="arrow_drop_down" />
          </button>
        </span>
        {c.reply && sendAndArchive && (
          // Settings ▸ General ▸ Send and Archive: one click sends the reply and archives the conversation.
          <button
            type="button"
            className="send-archive"
            onClick={() => void doSend({ archive: true })}
            aria-label="Send and archive"
            data-tip="Send and archive"
            data-testid="compose-send-archive"
          >
            <Icon name="send" size={18} />
            <Icon name="archive" size={18} />
          </button>
        )}
        <IconButton icon="text_format" label="Formatting options" on={fmt} onClick={() => setFmt(!fmt)} testId="compose-format" />
        <IconButton icon="attach_file" label="Attach files" onClick={() => fileInput.current?.click()} testId="compose-attach" />
        <IconButton icon="link" label="Insert link (⌘K)" onClick={() => (saveRange(), setDialog("link"))} testId="compose-link" />
        <IconButton
          icon="mood"
          label="Insert emoji (⌘⇧2)"
          onClick={(e) => (saveRange(), setMenu({ kind: "emoji", anchor: anchorOf(e.currentTarget) }))}
          testId="compose-emoji"
        />
        <IconButton icon="image" label="Insert photo" onClick={() => photoInput.current?.click()} testId="compose-photo" />
        <IconButton
          icon="ink_pen"
          label="Insert signature"
          onClick={(e) => setMenu({ kind: "sig", anchor: anchorOf(e.currentTarget) })}
          testId="compose-signature"
        />
        <IconButton icon="more_vert" label="More options" onClick={(e) => setMenu({ kind: "more", anchor: anchorOf(e.currentTarget) })} testId="compose-more" />
        <span className="grow" />
        {c.savedAt && <span className="compose-status">Draft saved</span>}
        <IconButton icon="delete" label="Discard draft (⌘⇧D)" onClick={() => void discardCompose(c.id)} testId="compose-discard" />
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          data-testid="compose-file-input"
          onChange={(e) => (e.target.files && void addFiles(e.target.files), (e.target.value = ""))}
        />
        <input
          ref={photoInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          data-testid="compose-photo-input"
          onChange={(e) => (e.target.files && void addFiles(e.target.files, true), (e.target.value = ""))}
        />
      </div>
      {dropping && <div className="drop-zone">Drop files here</div>}
      {menu?.kind === "send" && (
        <Menu
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
          className="icons"
          items={[
            { label: "Schedule send", icon: "schedule_send", run: () => setDialog("schedule"), testId: "schedule-send" },
            ...(c.reply ? [{ label: "Send & archive", icon: "archive", run: () => void doSend({ archive: true }) }] : []),
          ]}
        />
      )}
      {menu?.kind === "more" && <Menu anchor={menu.anchor} items={moreItems()} onClose={() => setMenu(null)} />}
      {menu?.kind === "sig" && (
        <Menu
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
          items={[
            { label: "Manage signatures", run: () => useMail.setState((s) => ({ route: { ...s.route, settings: "general" } })) },
            { sep: true },
            { label: "No signature", checked: !c.signatureId, run: () => insertSignature(null) },
            ...sigs.map((s) => ({ label: s.name, checked: c.signatureId === s.id, run: () => insertSignature(s) })),
          ]}
        />
      )}
      {menu?.kind === "font" && (
        <Menu
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
          items={Object.entries(FONTS).map(([, f]) => ({ label: f.label, run: () => exec("fontName", f.css) }))}
        />
      )}
      {menu?.kind === "size" && (
        <Menu
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
          items={Object.entries(SIZES).map(([, s]) => ({ label: s.label, run: () => exec("fontSize", s.step) }))}
        />
      )}
      {menu?.kind === "align" && (
        <Menu
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
          className="icons"
          items={[
            { label: "Left (⌘⇧L)", icon: "format_align_left", run: () => exec("justifyLeft") },
            { label: "Center (⌘⇧E)", icon: "format_align_center", run: () => exec("justifyCenter") },
            { label: "Right (⌘⇧R)", icon: "format_align_right", run: () => exec("justifyRight") },
          ]}
        />
      )}
      {menu?.kind === "color" && (
        <Menu anchor={menu.anchor} onClose={() => setMenu(null)}>
          <ColorPicker onPick={(fg, bg) => (fg && exec("foreColor", fg), bg && exec("hiliteColor", bg), setMenu(null))} />
        </Menu>
      )}
      {menu?.kind === "emoji" && <EmojiPicker anchor={menu.anchor} onClose={() => setMenu(null)} onPick={(e) => (exec("insertText", e), setMenu(null))} />}
      {dialog === "link" && (
        <LinkDialog
          initialText={savedRange.current?.toString() ?? ""}
          onClose={() => setDialog(null)}
          onInsert={(text, url) => (exec("insertHTML", `<a href="${url.replace(/"/g, "%22")}">${(text || url).replace(/</g, "&lt;")}</a>`), setDialog(null))}
        />
      )}
      {dialog === "schedule" && <ScheduleDialog onClose={() => setDialog(null)} onPick={(t) => (setDialog(null), void doSend({ sendAt: t }))} />}
      {dialog === "spell" && (
        <SpellDialog
          html={editor.current?.innerHTML ?? c.html}
          onClose={() => setDialog(null)}
          onFix={(word, fix) => {
            const ed = editor.current;
            if (!ed) return;
            const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
              const n = walker.currentNode as Text;
              const i = n.data.indexOf(word);
              if (i >= 0) {
                n.data = n.data.slice(0, i) + fix + n.data.slice(i + word.length);
                break;
              }
            }
            sync();
          }}
        />
      )}
      {dialog && typeof dialog === "object" && "error" in dialog && (
        <Dialog
          title="Error"
          onClose={() => setDialog(null)}
          actions={
            <button className="btn text" onClick={() => setDialog(null)}>
              OK
            </button>
          }
          testId="compose-error"
        >
          {dialog.error}
        </Dialog>
      )}
      {dialog && typeof dialog === "object" && "confirm" in dialog && (
        <Dialog
          title="Send anyway?"
          onClose={() => setDialog(null)}
          testId="compose-confirm"
          actions={
            <>
              <button className="btn text" onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button className="btn text" onClick={() => (setDialog(null), dialog.run())} data-testid="confirm-send">
                OK
              </button>
            </>
          }
        >
          {dialog.confirm}
        </Dialog>
      )}
    </div>
  );
}

function focusEditorStart(el: HTMLElement | null) {
  if (!el) return;
  el.focus();
  const r = document.createRange();
  r.setStart(el, 0);
  r.collapse(true);
  const s = window.getSelection();
  s?.removeAllRanges();
  s?.addRange(r);
}

// ---- recipients ----

/** The people Courier knows (mail you've exchanged), to tick and add in one go. */
function ContactPicker({ title, have, onPick, onClose }: { title: string; have: Address[]; onPick: (people: Address[]) => void; onClose: () => void }) {
  const [all, setAll] = useState<Contact[]>([]);
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => {
    void api
      .contacts("", null, 1000)
      .then((r) => setAll(r))
      .catch(() => {});
  }, []);
  const already = new Set(have.map((a) => a.email.toLowerCase()));
  const f = filter.trim().toLowerCase();
  const shown = all.filter((x) => !already.has(x.email.toLowerCase()) && (!f || x.email.toLowerCase().includes(f) || x.name.toLowerCase().includes(f)));
  const toggle = (email: string) => setPicked((p) => (p.includes(email) ? p.filter((x) => x !== email) : [...p, email]));
  return (
    <Dialog
      title={title}
      onClose={onClose}
      testId="contact-picker"
      actions={
        <>
          <button className="btn text" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn text"
            disabled={!picked.length}
            onClick={() => onPick(all.filter((x) => picked.includes(x.email)).map((x) => ({ name: x.name, email: x.email })))}
            data-testid="contact-picker-add"
          >
            Add{picked.length ? ` (${picked.length})` : ""}
          </button>
        </>
      }
    >
      <input
        className="picker-filter"
        placeholder="Filter by name or address"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        autoFocus
        aria-label="Filter people"
        data-testid="contact-picker-filter"
      />
      <div className="picker-list" role="listbox" aria-multiselectable="true">
        {shown.map((x) => (
          <label key={x.email} className="picker-row" data-testid="contact-picker-row">
            <input type="checkbox" checked={picked.includes(x.email)} onChange={() => toggle(x.email)} />
            <Avatar name={x.name} email={x.email} size={32} />
            <span className="picker-text">
              <span className="picker-name">{x.name || x.email}</span>
              {x.name && <span className="picker-mail">{x.email}</span>}
            </span>
          </label>
        ))}
        {!shown.length && <div className="empty">{all.length ? "No one matches." : "People you exchange mail with show up here."}</div>}
      </div>
    </Dialog>
  );
}

function RecipientRow({
  c,
  field,
  label,
  extra,
  autoFocus,
}: {
  c: ComposeData;
  field: "to" | "cc" | "bcc";
  label: string;
  extra?: React.ReactNode;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState("");
  const [sugg, setSugg] = useState<Contact[]>([]);
  const [on, setOn] = useState(0);
  const [choosing, setChoosing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = c[field];
  useEffect(() => {
    if (autoFocus) setTimeout(() => input.current?.focus(), 30);
  }, []);
  useEffect(() => {
    const q = text.trim();
    if (q.length < 1) return setSugg([]);
    let live = true;
    void api.contacts(q, null, 6).then((r) => {
      if (!live) return;
      const have = new Set(list.map((a) => a.email.toLowerCase()));
      setSugg(r.filter((x) => !have.has(x.email.toLowerCase())));
      setOn(0);
    });
    return () => {
      live = false;
    };
  }, [text]);
  const commit = (raw = text) => {
    const parsed = parseAddressList(raw.replace(/;/g, ","));
    if (!parsed.length) return false;
    changeCompose(c.id, { [field]: [...list, ...parsed] } as Partial<ComposeData>);
    setText("");
    setSugg([]);
    return true;
  };
  const pick = (x: Contact) => {
    changeCompose(c.id, { [field]: [...list, { name: x.name, email: x.email }] } as Partial<ComposeData>);
    setText("");
    setSugg([]);
    input.current?.focus();
  };
  const remove = (i: number) => changeCompose(c.id, { [field]: list.filter((_, j) => j !== i) } as Partial<ComposeData>);
  return (
    <div className="cf-row">
      <button type="button" className="lab lab-btn" onClick={() => setChoosing(true)} title={`Choose people for ${label}`} data-testid={`pick-${field}`}>
        {label}
      </button>
      {choosing && (
        <ContactPicker
          title={label === "To" ? "Choose recipients" : `Choose ${label} recipients`}
          have={list}
          onClose={() => setChoosing(false)}
          onPick={(people) => {
            changeCompose(c.id, { [field]: [...list, ...people] } as Partial<ComposeData>);
            setChoosing(false);
            input.current?.focus();
          }}
        />
      )}
      <span className="rcpts" onClick={() => input.current?.focus()}>
        {list.map((a: Address, i: number) => (
          <span
            key={`${a.email}-${i}`}
            className={["rcpt", /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email) ? "" : "bad"].join(" ")}
            title={a.email}
            data-testid={`rcpt-${field}`}
          >
            <Avatar name={a.name} email={a.email} size={20} />
            {a.name || a.email}
            <button type="button" className="x" aria-label={`Remove ${a.email}`} onClick={(e) => (e.stopPropagation(), remove(i))}>
              <Icon name="close" size={16} />
            </button>
          </span>
        ))}
        <input
          ref={input}
          value={text}
          aria-label={`${label} recipients`}
          data-testid={`compose-${field}`}
          onChange={(e) => {
            const v = e.target.value;
            if (/[,;]\s*$/.test(v)) commit(v);
            else setText(v);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "Tab") {
              if (sugg.length && text.trim()) {
                e.preventDefault();
                pick(sugg[on]);
              } else if (text.trim()) {
                if (e.key === "Enter") e.preventDefault();
                commit();
              }
            } else if (e.key === "Backspace" && !text && list.length) remove(list.length - 1);
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setOn((o) => Math.min(o + 1, sugg.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setOn((o) => Math.max(o - 1, 0));
            } else if (e.key === "Escape") setSugg([]);
          }}
          onBlur={() => setTimeout(() => text.trim() && commit(), 120)}
          onPaste={(e) => {
            const t = e.clipboardData.getData("text/plain");
            if (t.includes("@") && /[,;\n]/.test(t)) {
              e.preventDefault();
              commit(t.replace(/\n/g, ","));
            }
          }}
        />
      </span>
      {extra}
      {sugg.length > 0 && (
        <div className="ac-menu" role="listbox" data-testid="autocomplete">
          {sugg.map((x, i) => (
            <div
              key={x.email}
              role="option"
              aria-selected={i === on}
              className={["ac-item", i === on ? "on" : ""].join(" ")}
              onMouseDown={(e) => (e.preventDefault(), pick(x))}
            >
              <Avatar name={x.name} email={x.email} size={32} />
              <div>
                <div className="n">{x.name || x.email}</div>
                {x.name && <div className="e">{x.email}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- small dialogs ----

const TEXT_COLORS = [
  "#000000",
  "#444444",
  "#666666",
  "#999999",
  "#cccccc",
  "#eeeeee",
  "#f3f3f3",
  "#ffffff",
  "#ff0000",
  "#ff9900",
  "#ffff00",
  "#00ff00",
  "#00ffff",
  "#0000ff",
  "#9900ff",
  "#ff00ff",
  "#cc0000",
  "#e69138",
  "#f1c232",
  "#6aa84f",
  "#45818e",
  "#3d85c6",
  "#674ea7",
  "#a64d79",
];

function ColorPicker({ onPick }: { onPick: (fg: string | null, bg: string | null) => void }) {
  return (
    <div style={{ display: "flex", gap: 16, padding: "8px 12px" }}>
      {(["Background color", "Text color"] as const).map((kind) => (
        <div key={kind}>
          <div className="menu-head" style={{ padding: "0 0 6px" }}>
            {kind}
          </div>
          <div className="color-grid" style={{ padding: 0 }}>
            {TEXT_COLORS.map((col) => (
              <button
                key={col}
                style={{ background: col }}
                aria-label={`${kind} ${col}`}
                onClick={() => (kind === "Text color" ? onPick(col, null) : onPick(null, col))}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function LinkDialog({ initialText, onClose, onInsert }: { initialText: string; onClose: () => void; onInsert: (text: string, url: string) => void }) {
  const [text, setText] = useState(initialText);
  const [url, setUrl] = useState("");
  const fixed = () => {
    const u = url.trim();
    if (!u) return "";
    if (/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(u)) return `mailto:${u}`;
    return /^(https?:|mailto:|tel:)/i.test(u) ? u : `https://${u}`;
  };
  return (
    <Dialog
      title="Edit link"
      onClose={onClose}
      testId="link-dialog"
      actions={
        <>
          <button className="btn text" onClick={onClose}>
            Cancel
          </button>
          <button className="btn text" disabled={!fixed()} onClick={() => onInsert(text, fixed())} data-testid="link-ok">
            OK
          </button>
        </>
      }
    >
      <div className="field">
        <label>Text to display</label>
        <input value={text} onChange={(e) => setText(e.target.value)} data-testid="link-text" />
      </div>
      <div className="field">
        <label>Web address or email address</label>
        <input
          autoFocus
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && fixed() && onInsert(text, fixed())}
          data-testid="link-url"
        />
      </div>
    </Dialog>
  );
}

export function ScheduleDialog({ onClose, onPick }: { onClose: () => void; onPick: (t: number) => void }) {
  const [custom, setCustom] = useState(false);
  const tomorrow = new Date(Date.now() + 86400000);
  const [date, setDate] = useState(
    `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`,
  );
  const [time, setTime] = useState("08:00");
  const when = new Date(`${date}T${time}`);
  return (
    <Dialog
      title={custom ? "Pick date & time" : "Schedule send"}
      onClose={onClose}
      testId="schedule-dialog"
      actions={
        custom ? (
          <>
            <button className="btn text" onClick={() => setCustom(false)}>
              Cancel
            </button>
            <button
              className="btn text"
              disabled={isNaN(when.getTime()) || when.getTime() < Date.now()}
              onClick={() => onPick(when.getTime())}
              data-testid="schedule-custom-ok"
            >
              Schedule send
            </button>
          </>
        ) : undefined
      }
    >
      {custom ? (
        <div style={{ display: "flex", gap: 16 }}>
          <div className="field">
            <label>Date</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} data-testid="schedule-date" />
          </div>
          <div className="field">
            <label>Time</label>
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} data-testid="schedule-time" />
          </div>
        </div>
      ) : (
        <div style={{ margin: "0 -24px", paddingBottom: 12 }}>
          {schedulePresets().map((p) => (
            <button
              key={p.key}
              className="menu-item"
              style={{ padding: "10px 24px" }}
              onClick={() => onPick(p.when.getTime())}
              data-testid={`schedule-${p.key}`}
            >
              <span style={{ flex: 1 }}>{p.label}</span>
              <span className="right" style={{ marginRight: 0 }}>
                {p.detail}
              </span>
            </button>
          ))}
          <div className="menu-sep" />
          <button className="menu-item" style={{ padding: "10px 24px" }} onClick={() => setCustom(true)} data-testid="schedule-pick">
            <Icon name="calendar_today" /> Pick date & time
          </button>
        </div>
      )}
      <div className="hint" style={{ marginTop: 8 }}>
        Courier sends scheduled mail itself, so it needs to be running (it can be in the background) at the scheduled time.
      </div>
    </Dialog>
  );
}

function SpellDialog({ html, onClose, onFix }: { html: string; onClose: () => void; onFix: (word: string, fix: string) => void }) {
  const [issues, setIssues] = useState<{ word: string; suggestions: string[] }[] | null>(null);
  useEffect(() => {
    const text = htmlToText(html);
    void api
      .spellCheck([text])
      .then((r) => {
        const chars = [...text];
        setIssues((r[0] ?? []).map((x) => ({ word: chars.slice(x.start, x.start + x.len).join(""), suggestions: x.suggestions })));
      })
      .catch((e) => (toast(errorText(e)), onClose()));
  }, []);
  return (
    <Dialog
      title="Check spelling"
      onClose={onClose}
      testId="spell-dialog"
      actions={
        <button className="btn text" onClick={onClose}>
          Done
        </button>
      }
    >
      {!issues && "Checking…"}
      {issues && !issues.length && "No spelling suggestions."}
      {issues?.map((x, i) => (
        <div key={i} style={{ margin: "6px 0", color: "var(--text)" }}>
          <b style={{ textDecoration: "underline wavy #d93025" }}>{x.word}</b>{" "}
          {x.suggestions.map((s) => (
            <button key={s} className="btn text sm" onClick={() => (onFix(x.word, s), setIssues((cur) => cur?.filter((_, j) => j !== i) ?? null))}>
              {s}
            </button>
          ))}
        </div>
      ))}
    </Dialog>
  );
}

/** Attach whole conversations' latest messages to a draft (dropped from the list). */
async function attachConversations(composeId: string, drop: { accountId: string; threadIds: string[] }) {
  try {
    const add: { filename: string; raw: Uint8Array }[] = [];
    for (const id of drop.threadIds.slice(0, 20)) {
      const d = await api.thread(drop.accountId, id);
      const m = [...d.messages].reverse().find((x) => !x.labels.includes("DRAFT"));
      if (!m) continue;
      add.push({
        filename: `${
          (m.subject || "message")
            .replace(/[\\/:*?"<>|]+/g, " ")
            .trim()
            .slice(0, 80) || "message"
        }.eml`,
        raw: await api.raw(drop.accountId, m.id),
      });
    }
    const c = useMail.getState().composes.find((x) => x.id === composeId);
    if (c && add.length) changeCompose(composeId, { forwarded: [...c.forwarded, ...add] });
  } catch (e) {
    toast(failureText(`attach that`, e));
  }
}

// ---- emoji ----

let emojiCache: { group: number; emoji: string; label: string }[] | null = null;
const GROUPS = ["Smileys & emotion", "People", "Component", "Animals & nature", "Food & drink", "Travel & places", "Activities", "Objects", "Symbols", "Flags"];
const GROUP_ICONS = ["mood", "emoji_people", "", "pets", "restaurant", "directions_car", "sports_soccer", "lightbulb", "emoji_symbols", "flag"];

function EmojiPicker({ anchor, onClose, onPick }: { anchor: Anchor; onClose: () => void; onPick: (e: string) => void }) {
  const [list, setList] = useState(emojiCache);
  const [group, setGroup] = useState(0);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!emojiCache)
      void import("emojibase-data/en/compact.json").then((m) => {
        const data = (m.default as { unicode: string; label: string; group?: number }[]).filter((x) => x.group !== undefined && x.group !== 2);
        emojiCache = data.map((x) => ({ group: x.group!, emoji: x.unicode, label: x.label }));
        setList(emojiCache);
      });
    const f = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    setTimeout(() => document.addEventListener("mousedown", f), 0);
    return () => document.removeEventListener("mousedown", f);
  }, []);
  // Follows its button when an inline reply scrolls with the conversation.
  const [at, setAt] = useState(anchor);
  useFollowAnchor(ref, anchor, setAt, onClose);
  const shown = (list ?? []).filter((x) => (q ? x.label.includes(q.toLowerCase()) : x.group === group)).slice(0, 400);
  const top = Math.max(8, at.y - 348);
  return createPortal(
    <div
      className="emoji-pop"
      ref={ref}
      style={{ left: Math.min(at.x, window.innerWidth - 344), top }}
      role="dialog"
      aria-label="Insert emoji"
      data-testid="emoji-picker"
    >
      <div className="tabs-e">
        <input
          placeholder="Search emoji"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ flex: 1, border: 0, outline: 0, background: "transparent", padding: "0 6px" }}
          autoFocus
        />
      </div>
      {!q && (
        <div className="tabs-e">
          {GROUPS.map((g, i) =>
            GROUP_ICONS[i] ? <IconButton key={g} icon={GROUP_ICONS[i]} label={g} size="xs" on={group === i} onClick={() => setGroup(i)} /> : null,
          )}
        </div>
      )}
      <div className="grid">
        {shown.map((x) => (
          <button key={x.emoji} title={x.label} aria-label={x.label} onClick={() => onPick(x.emoji)}>
            {x.emoji}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}

// ---- pop-out handoff ----

export function serializeCompose(c: ComposeData) {
  const att = (a: Attachment) => ({ ...a, data: base64Encode(a.data) });
  return {
    ...c,
    attachments: c.attachments.map(att),
    inlineImages: Object.fromEntries(Object.entries(c.inlineImages).map(([k, v]) => [k, att(v)])),
    forwarded: c.forwarded.map((f) => ({ filename: f.filename, raw: base64Encode(f.raw) })),
    labels: c.labels ?? [],
  };
}

export function deserializeCompose(x: ReturnType<typeof serializeCompose>): ComposeData {
  const att = (a: Omit<Attachment, "data"> & { data: string }): Attachment => ({ ...a, data: base64Decode(a.data) });
  // Blob URLs don't cross windows: recreate them and rewrite the HTML.
  let html = x.html;
  const inlineImages: Record<string, Attachment> = {};
  for (const [url, img] of Object.entries(x.inlineImages)) {
    const a = att(img);
    const fresh = URL.createObjectURL(new Blob([a.data as BlobPart], { type: a.mime }));
    inlineImages[fresh] = a;
    html = html.split(url).join(fresh);
  }
  return {
    ...x,
    id: newComposeId(),
    html,
    attachments: x.attachments.map(att),
    inlineImages,
    forwarded: x.forwarded.map((f) => ({ filename: f.filename, raw: base64Decode(f.raw) })),
    labels: x.labels ?? [],
    placement: "dock",
    minimized: false,
    fullscreen: false,
  };
}

export function adoptCompose(x: ReturnType<typeof serializeCompose>) {
  const c = deserializeCompose(x);
  addCompose(c);
  return c;
}

export { ui };
