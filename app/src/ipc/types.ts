// Shapes exchanged with the Rust side (serde camelCase).
import type { Address } from "../core/addresses";

export type AccountKind = "gmail" | "imap";

export interface ServerConfig {
  host: string;
  port: number;
  security: "tls" | "starttls" | "plain";
  username: string;
}

export interface ImapAccountConfig {
  imap: ServerConfig;
  smtp: ServerConfig;
  saveSent: boolean;
  initialWindow: number;
}

export interface Account {
  id: string;
  kind: AccountKind;
  email: string;
  name: string;
  color: string;
  position: number;
  photo: string | null;
  needsReauth: boolean;
  aliases: string[];
  config: Record<string, unknown>;
}

export interface Label {
  accountId: string;
  id: string;
  name: string;
  type: "system" | "user";
  bg: string | null;
  fg: string | null;
  labelListVisibility: string | null; // labelShow | labelHide | labelShowIfUnread
  messageListVisibility: string | null; // show | hide
  threadsTotal: number;
  threadsUnread: number;
  messagesTotal: number;
  messagesUnread: number;
  imapPath: string | null;
  imapDelimiter: string | null;
  special: string | null;
}

export interface AttachmentMeta {
  name: string;
  mime: string;
  size: number;
}

export interface Participant {
  name: string;
  email: string;
  unread: boolean;
  draft: boolean;
}

export interface ThreadSummary {
  accountId: string;
  threadId: string;
  subject: string;
  snippet: string;
  lastDate: number;
  messageCount: number;
  unread: boolean;
  starred: boolean;
  starType: string | null;
  important: boolean;
  labels: string[];
  participants: Participant[];
  hasAttachments: boolean;
  attachments: AttachmentMeta[];
  snoozedUntil: number | null;
  muted: boolean;
  messageIds: string[];
  draftIds: string[];
  outboxId: number | null;
  scheduledAt: number | null;
  listUnsubscribe: boolean;
}

export interface ViewQuery {
  accountId: string; // or "all"
  label?: string | null;
  category?: string | null;
  query?: string | null;
  page: number;
  pageSize: number;
  pageToken?: string | null;
  mode?: "cache" | "server";
  conversations: boolean;
}

export interface ViewResult {
  threads: ThreadSummary[];
  total: number;
  estimate: boolean;
  hasMore: boolean;
  nextPageToken: string | null;
  source: "cache" | "server";
}

export interface MessageRow {
  accountId: string;
  id: string;
  threadId: string;
  internalDate: number;
  fromName: string;
  fromEmail: string;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo: Address[];
  deliveredTo: string;
  subject: string;
  snippet: string;
  size: number;
  attachments: AttachmentMeta[];
  messageId: string;
  inReplyTo: string;
  references: string[];
  listUnsubscribe: string;
  listUnsubscribePost: string;
  listId: string;
  labels: string[];
  imapFolder: string | null;
  hasRaw: boolean;
  starType: string | null;
  draftId: string | null;
}

export interface ThreadDetail {
  accountId: string;
  threadId: string;
  messages: MessageRow[];
  snoozedUntil: number | null;
  muted: boolean;
}

export interface OutboxRow {
  id: number;
  accountId: string;
  sendAt: number;
  status: string;
  attempts: number;
  error: string | null;
  threadId: string | null;
  draftId: string | null;
  scheduled: boolean;
  subject: string;
  recipients: string[];
  fromEmail: string;
  createdAt: number;
  snippet: string;
}

export interface Contact {
  name: string;
  email: string;
  times: number;
  lastUsed: number;
}

export interface Discovered {
  kind: "gmail" | "imap";
  provider: string;
  config: ImapAccountConfig | null;
  source: string;
  help: string | null;
}

export interface Template {
  id: string;
  accountId: string | null;
  name: string;
  subject: string;
  html: string;
}

export interface Signature {
  id: string;
  name: string;
  html: string;
}

export interface AppInfo {
  version: string;
  e2e: boolean;
  dataDir: string;
  online: boolean;
  platform: string;
}

export interface SpellIssue {
  start: number;
  len: number;
  suggestions: string[];
}
