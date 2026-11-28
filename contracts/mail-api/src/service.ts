import type {
  AdminMailbox, Alias, AliasInput, ContentUrl, Conversation, Domain, DomainInput, Draft, DraftInput, DriveImport,
  DriveImportInput, DriveSave, Id, Identity, Label, LinkLocation, LinkLocationCredentials, LinkLocationInput, LinkLocationList,
  MailboxInput, MailboxPage, MailboxPatch, Member, Page, Send, SendQuery, Session, Settings, State, ThreadQuery, ThreadSummary, ThreadUpdate, Upload, ViewList,
} from './wire.ts';

/** `Idempotency-Key`: 1 to 64 characters of `[A-Za-z0-9_-]`, new per user action, reused on retry. */
export interface Idempotent { idempotencyKey: string }
/** `If-Match`: the `revision` the client last read. */
export interface Conditional { ifMatch: string }

export interface UploadInput { name: string; type: string; bytes: Blob }

/**
 * The Mail API. One method per HTTP route in `ROUTES`; the method name is the
 * operation name. An instance is bound to one authenticated session: user
 * methods act on that session's mailbox, admin methods on its workspace.
 * Failures throw `MailApiError` with a catalogue code.
 *
 * Implemented by the in-memory fake (`@kofra/mail-core`), the backend
 * (`/api/v1` on the mail app host) and the browser's HTTP client.
 */
export interface MailService {
  getSession(): Promise<Session>;

  listViews(): Promise<ViewList>;
  listThreads(query: ThreadQuery): Promise<MailboxPage<ThreadSummary>>;
  getThread(threadId: Id): Promise<Conversation>;
  updateThreads(update: ThreadUpdate): Promise<{ state: State }>;
  getBodyUrl(messageId: Id, input: { remoteImages: boolean }): Promise<ContentUrl>;
  getAttachmentUrl(messageId: Id, part: number): Promise<ContentUrl>;
  saveAttachmentToDrive(messageId: Id, part: number, options: Idempotent): Promise<DriveSave>;

  listLabels(): Promise<{ items: Label[]; state: State }>;
  createLabel(input: { name: string }, options: Idempotent): Promise<Label>;
  renameLabel(labelId: Id, input: { name: string }): Promise<Label>;
  deleteLabel(labelId: Id): Promise<void>;

  listIdentities(): Promise<{ items: Identity[] }>;
  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;

  listDrafts(query: { cursor?: string; limit?: number }): Promise<MailboxPage<Draft>>;
  getDraft(draftId: Id): Promise<Draft>;
  createDraft(input: DraftInput, options: Idempotent): Promise<Draft>;
  replaceDraft(draftId: Id, input: DraftInput, options: Conditional): Promise<Draft>;
  deleteDraft(draftId: Id, options?: Partial<Conditional>): Promise<void>;
  sendDraft(draftId: Id, options: Idempotent & Conditional): Promise<Send>;
  listSends(query: SendQuery): Promise<MailboxPage<Send>>;
  getSend(sendId: Id): Promise<Send>;
  undoSend(sendId: Id, options: Idempotent): Promise<Draft>;

  createUpload(input: UploadInput, options: Idempotent): Promise<Upload>;
  deleteUpload(uploadId: Id): Promise<void>;
  importFromDrive(input: DriveImportInput, options: Idempotent): Promise<DriveImport>;

  listDomains(): Promise<{ items: Domain[] }>;
  addDomain(input: DomainInput, options: Idempotent): Promise<Domain>;
  listMailboxes(query: { cursor?: string; limit?: number }): Promise<Page<AdminMailbox>>;
  createMailbox(input: MailboxInput, options: Idempotent): Promise<AdminMailbox>;
  updateMailbox(mailboxId: Id, patch: MailboxPatch): Promise<AdminMailbox>;
  createAlias(input: AliasInput, options: Idempotent): Promise<Alias>;
  deleteAlias(address: string): Promise<void>;
  listMembers(query: { cursor?: string; limit?: number }): Promise<Page<Member>>;
  listLinkLocations(): Promise<LinkLocationList>;
  createLinkLocation(input: LinkLocationInput, options: Idempotent): Promise<LinkLocation>;
  rotateLinkLocationCredentials(locationId: Id, input: LinkLocationCredentials): Promise<LinkLocation>;
  deleteLinkLocation(locationId: Id): Promise<void>;
}

export type Operation = keyof MailService;
