export type MailboxId = 'inbox' | 'sent' | 'drafts' | 'archive' | 'spam' | 'trash';
export type Mailbox = { id: MailboxId; name: string; unread: number };
export type Address = { name: string; email: string };
export type Identity = Address & { primary: boolean };
export type Attachment = { id: string; name: string; size: number; type: string; link?: string };
export type Label = { id: string; name: string };
export type Message = {
  id: string; from: Address; to: Address[]; date: string; subject: string;
  text: string; attachments: Attachment[]; remoteImages?: boolean;
};
export type Thread = {
  id: string; subject: string; snippet: string; date: string; from: Address;
  mailboxId: MailboxId; labelIds: string[]; starred: boolean; unread: boolean;
  count: number; hasAttachments: boolean; expiresAt?: number;
};
export type Conversation = Thread & { messages: Message[] };
export type ThreadFilter = { mailboxId?: MailboxId; labelId?: string; query?: string; starred?: boolean };
export type ThreadUpdate = { mailboxId?: MailboxId; unread?: boolean; starred?: boolean; labelId?: string; labelled?: boolean };
export type Draft = {
  id?: string; replyToThreadId?: string; from: string; to: string[]; cc: string[];
  bcc: string[]; subject: string; body: string; attachments: Attachment[];
};
export type PendingSend = { id: string; undoUntil: number };
export type Settings = { signature: string; undoSeconds: 5 | 10 | 20 | 30; defaultFrom: string };
export type DriveFile = { id: string; name: string; size: number; type: string };
export type Domain = { name: string; status: 'Active' | 'Pending'; kind: 'Primary' | 'Alias' };
export type DirectoryUser = Address & { aliases: string[] };
export type Group = { email: string; name: string; members: number; moderated: boolean };

/** In-process UI port; not an HTTP or JMAP wire specification. */
export interface MailApi {
  listMailboxes(): Promise<Mailbox[]>;
  listThreads(filter: ThreadFilter): Promise<Thread[]>;
  getThread(id: string): Promise<Conversation | undefined>;
  updateThread(id: string, update: ThreadUpdate): Promise<void>;
  listLabels(): Promise<Label[]>;
  createLabel(name: string): Promise<Label>;
  listIdentities(): Promise<Identity[]>;
  listDrafts(): Promise<Draft[]>;
  saveDraft(draft: Draft): Promise<Draft>;
  discardDraft(id: string): Promise<void>;
  send(draft: Draft): Promise<PendingSend>;
  undoSend(id: string): Promise<Draft | undefined>;
  uploadAttachment(file: Blob, name: string): Promise<Attachment>;
  downloadAttachment(id: string): Promise<Blob>;
  listDriveFiles(): Promise<DriveFile[]>;
  attachFromDrive(id: string, mode: 'copy' | 'link'): Promise<Attachment>;
  saveToDrive(id: string): Promise<void>;
  getSettings(): Promise<Settings>;
  updateSettings(settings: Settings): Promise<void>;
  listDomains(): Promise<Domain[]>;
  addDomain(name: string, kind: Domain['kind']): Promise<void>;
  listUsers(): Promise<DirectoryUser[]>;
  addUser(user: Address): Promise<void>;
  addAlias(userEmail: string, alias: string): Promise<void>;
  listGroups(): Promise<Group[]>;
  addGroup(group: Group): Promise<void>;
}
