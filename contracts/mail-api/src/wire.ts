import type { Limits } from './limits.ts';

/** Opaque server id: 1 to 64 characters of `[A-Za-z0-9_-]`. Clients never parse ids. */
export type Id = string;
/** RFC 3339 UTC timestamp with a `Z` suffix, for example `2026-11-22T14:36:00.000Z`. */
export type UTCDate = string;
/** Opaque change marker for the whole mailbox. Any write returns a new value. */
export type State = string;

export interface Address { name: string; email: string }
/** In requests the display name is optional. */
export interface AddressInput { name?: string; email: string }

// ---------------------------------------------------------------- session

export interface Session {
  /** The account user id (`sub` of the suite's sign-in), never an email address. */
  user: { id: Id; name: string };
  /**
   * The one mailbox this session reads and writes; URLs never name a mailbox.
   * Absent when the user has no mailbox yet (for example a new workspace's
   * first admin): then every user route answers 403 `forbidden`, admin routes still work.
   */
  mailbox?: { id: Id; primaryAddress: string };
  workspace: { id: Id; role: 'member' | 'admin' };
  /** Sent back as `X-CSRF-Token` on every non-GET request. */
  csrfToken: string;
  /** Last interactive sign-in step; admin writes need it to be at most 10 minutes old. */
  authTime: UTCDate;
  limits: Limits;
  features: Features;
  state: State;
}

export interface Features {
  /** Save to Drive and Attach from Drive (needs the Drive picker and per-action tokens). */
  drive: boolean;
  /** Formatted (HTML) bodies through the content origin. */
  htmlContent: boolean;
  /** Outbound sends, undo and draft attachments. Omitted by older implementations. */
  m3?: boolean;
}

// ---------------------------------------------------------------- views, threads, messages

/** Where a message lives. Each message is in exactly one folder. */
export type Folder = 'inbox' | 'archive' | 'spam' | 'trash';

/**
 * A listing. A thread is in a view when at least one of its messages qualifies:
 * - `inbox`, `spam`, `trash`: a message in that folder;
 * - `archive`: no message in `inbox`, and a message in `archive`;
 * - `sent`: a message with `sent: true` outside Spam and Trash;
 * - `starred`: a starred message outside Spam and Trash;
 * - `all`: a message outside Spam and Trash.
 */
export type View = 'inbox' | 'starred' | 'sent' | 'archive' | 'spam' | 'trash' | 'all';
export const VIEWS = ['inbox', 'starred', 'sent', 'archive', 'spam', 'trash', 'all'] as const satisfies readonly View[];

export interface ViewCount { view: View; unreadThreads: number }
export interface ViewList { items: ViewCount[]; drafts: number; state: State }

export interface ThreadQuery {
  view: View;
  /** Narrow the view to threads with a qualifying message carrying this label. */
  labelId?: Id;
  /** Search query (README "Search"); at most `limits.queryBytes`. */
  q?: string;
  /** IANA time zone for `before:` and `after:`; UTC when absent. */
  tz?: string;
  cursor?: string;
  /** 1 to `limits.pageSizeMax`; default `limits.pageSizeDefault`. */
  limit?: number;
}

export interface Page<T> {
  items: T[];
  /** `null` on the last page. Valid only with the same query parameters. */
  nextCursor: string | null;
}
/** A page of mailbox data, with the mailbox state it was read at. */
export interface MailboxPage<T> extends Page<T> { state: State }

/** Summary fields are computed over the thread's qualifying messages for the requested view. */
export interface ThreadSummary {
  id: Id;
  subject: string;
  snippet: string;
  /** Latest `receivedAt` of a qualifying message; listings sort by `lastDate` desc, then `id` desc. */
  lastDate: UTCDate;
  /** Sender of the latest qualifying message. */
  from: Address;
  count: number;
  unread: boolean;
  starred: boolean;
  /** Folders of all the thread's messages, each once, in `Folder` declaration order. */
  folders: Folder[];
  labelIds: Id[];
  hasAttachments: boolean;
  /** Spam and Trash views only: the earliest time a qualifying message expires. */
  expiresAt?: UTCDate;
}

export type VerdictLevel = 'none' | 'spam' | 'suspicious' | 'phishing';
export type VerdictReason =
  | 'own_domain_without_dmarc_pass'
  | 'lookalike_domain'
  | 'link_text_mismatch'
  | 'dangerous_attachment'
  | 'spam_score'
  | 'user_reported';
/** For `phishing` the client shows the warning and the content origin disables links. */
export interface Verdict { level: VerdictLevel; reasons: VerdictReason[] }

export interface MessageAttachment {
  /** Index of the MIME part within the message; addresses the attachment with the message id. */
  part: number;
  name: string;
  /** Declared type; downloads are always served as `application/octet-stream`. */
  type: string;
  size: number;
  /** Shown inline in the formatted body (a `cid:` image). */
  inline: boolean;
}

export type SendSummaryState = 'sending' | 'sent' | 'partial' | 'failed' | 'delayed';

export interface Message {
  id: Id;
  threadId: Id;
  folder: Folder;
  unread: boolean;
  starred: boolean;
  labelIds: Id[];
  /** Written by this mailbox through the send path. */
  sent: boolean;
  from: Address;
  replyTo?: Address[];
  to: Address[];
  cc: Address[];
  /** Only on this mailbox's own sent copies. */
  bcc?: Address[];
  /** The message's `Date` header, or `receivedAt` when absent or invalid. */
  date: UTCDate;
  receivedAt: UTCDate;
  subject: string;
  /** Plain text, at most `limits.messageTextBytes`. */
  text: string;
  textTruncated: boolean;
  /** A formatted body exists. `getBodyUrl` serves every message: HTML sanitised, plain text escaped. */
  hasHtml: boolean;
  /** The formatted body references remote images (blocked until the user asks). */
  remoteImages: boolean;
  size: number;
  attachments: MessageAttachment[];
  verdict: Verdict;
  /** Only on sent copies: the delivery outcome (`getSend` has per-recipient detail). */
  send?: { id: Id; state: SendSummaryState };
}

export interface Conversation { thread: ThreadSummary; messages: Message[]; state: State }

/** Set semantics, never toggles, so a repeated call has the same effect. */
export interface ThreadChange {
  folder?: Folder;
  unread?: boolean;
  starred?: boolean;
  addLabelIds?: Id[];
  removeLabelIds?: Id[];
}

/** Applies to every message of each thread, all or nothing. */
export interface ThreadUpdate { ids: Id[]; set: ThreadChange }

export interface ContentUrl {
  /** Absolute URL on the content origin; put it only in a sandboxed iframe or a download link. */
  url: string;
  expiresAt: UTCDate;
}

// ---------------------------------------------------------------- labels, identities, settings

export interface Label { id: Id; name: string }

export type IdentityKind = 'primary' | 'alias' | 'alias_domain' | 'group';
export interface Identity {
  email: string;
  name: string;
  kind: IdentityKind;
  primary: boolean;
  /** A primary or alias is `active` only when it is in the deployed sender allow-list; it starts `pending`. */
  sendAs: 'active' | 'pending';
}

export interface Settings {
  signature: string;
  undoSeconds: 5 | 10 | 20 | 30;
  /** An active identity, or the pending primary when there is no active identity. Setting it explicitly requires an active identity. */
  defaultFrom: string;
  /** Reply from the address the message was sent to, when it is one of ours. */
  replyFromReceivedAddress: boolean;
}

// ---------------------------------------------------------------- drafts, uploads, sends

export interface Upload {
  id: Id;
  name: string;
  type: string;
  size: number;
  sha256: string;
  /** Released at this time unless a draft refers to it. */
  expiresAt: UTCDate;
}

export type DraftAttachmentRef =
  | { kind: 'upload'; uploadId: Id }
  | { kind: 'message'; messageId: Id; part: number }
  | { kind: 'link'; url: string; name: string };

export type DraftAttachment =
  | { kind: 'upload'; uploadId: Id; name: string; type: string; size: number }
  | { kind: 'message'; messageId: Id; part: number; name: string; type: string; size: number }
  | { kind: 'link'; url: string; name: string };

export interface DraftInput {
  from: string;
  to: AddressInput[];
  cc: AddressInput[];
  bcc: AddressInput[];
  subject: string;
  /** Plain text. */
  body: string;
  /** Our id of the message being answered; the server sets In-Reply-To, References and the thread. */
  inReplyTo?: Id;
  /** Our id of the message being forwarded. */
  forwardOf?: Id;
  attachments: DraftAttachmentRef[];
}

export interface Draft extends Omit<DraftInput, 'attachments'> {
  id: Id;
  /** Changes on every write; send it as `If-Match`. */
  revision: string;
  updatedAt: UTCDate;
  attachments: DraftAttachment[];
}

/** Server-internal steps between `pending` and `sending` (release, enqueue) report as `sending`. */
export type SendState = 'pending' | 'sending' | 'sent' | 'partial' | 'failed' | 'delayed' | 'cancelled';
export type RecipientState = 'pending' | 'sent' | 'failed' | 'suppressed';

export interface RecipientStatus {
  email: string;
  state: RecipientState;
  /** For `failed`: a provider-neutral reason, for example `rejected`, `invalid_address`, `quota`. */
  reason?: string;
}

export interface Send {
  id: Id;
  /** The draft id restored by undo. */
  draftId: Id;
  state: SendState;
  createdAt: UTCDate;
  /** Undo is possible until the server releases the message, never before this time. */
  undoUntil: UTCDate;
  /** Milliseconds left at response time (0 unless `pending`), so clients need not trust their clock. */
  undoRemainingMs: number;
  /** The sent copy in this mailbox, once released. */
  messageId?: Id;
  /** For `delayed`: when the server will try again. */
  delayedUntil?: UTCDate;
  recipients: RecipientStatus[];
}

export interface SendQuery { active?: boolean; cursor?: string; limit?: number }

/** Result of a Drive pick: copies become uploads, links become link attachments. */
export interface DriveImport { attachments: DraftAttachment[] }
export interface DriveImportInput {
  /** Issued by the Drive-hosted picker; it names the picked files and expires in 5 minutes. */
  pickId: string;
  mode: 'copy' | 'link';
}
export interface DriveSave { driveFileId: Id; name: string }

// ---------------------------------------------------------------- admin

export type ServiceState = 'off' | 'pending' | 'active';

export interface Domain {
  name: string;
  kind: 'primary' | 'secondary' | 'alias';
  /** For `alias`: the domain it maps to. */
  aliasOf?: string;
  routing: ServiceState;
  sending: ServiceState;
}
export interface DomainInput { name: string; kind: 'secondary' | 'alias'; aliasOf?: string }

export interface Alias { address: string; mailboxId: Id; sendAs: ServiceState }

export interface AdminMailbox {
  id: Id;
  primaryAddress: string;
  displayName: string;
  /** The workspace member who owns it; chosen by an admin, never matched by email. */
  ownerUserId: Id;
  aliases: Alias[];
}
export interface MailboxInput { primaryAddress: string; displayName: string; ownerUserId: Id }
export interface MailboxPatch { displayName?: string; ownerUserId?: Id }
export interface AliasInput { mailboxId: Id; address: string; sendAs: boolean }

export interface Member { id: Id; name: string; email: string; status: 'active' | 'invited'; hasMailbox: boolean }
