import type { MailService } from './service.ts';
import type { Address, Id } from './wire.ts';

/**
 * Who a conformance case calls as. All four are in one workspace.
 * - `member`: owns mailbox A; workspace role `member`.
 * - `other`: owns mailbox B; role `member`. Used to prove isolation.
 * - `admin`: owns mailbox C; role `admin`, signed in within the last minute.
 * - `staleAdmin`: the same admin with an `authTime` 11 minutes old.
 */
export type Principal = 'member' | 'other' | 'admin' | 'staleAdmin';

export interface TestAttachment { name: string; type: string; bytes: Uint8Array; inline?: boolean }

/** An inbound message, delivered as if it had passed inbound checks. */
export interface TestMessage {
  from: Address;
  to: Address[];
  cc?: Address[];
  subject: string;
  text: string;
  /** A formatted body; with `remoteImages` it references one remote image. */
  html?: string;
  remoteImages?: boolean;
  attachments?: TestAttachment[];
  /** Thread with an earlier delivered message (In-Reply-To / References). */
  inReplyTo?: Id;
}

/**
 * What an implementation supplies to run the conformance suite. The fake
 * implements it in memory. The backend implements it over HTTP against a local
 * workerd, with `deliver` going through the inbound path and `advance` running
 * the mailbox timers.
 */
export interface ConformanceHarness {
  as(principal: Principal): MailService;
  /** Deliver to a principal's mailbox (default `member`). */
  deliver(message: TestMessage, to?: Principal): Promise<{ threadId: Id; messageId: Id }>;
  /** Move the service clock forward and run every timer that is due. */
  advance(ms: number): Promise<void>;
  /** Origin that `getBodyUrl` and `getAttachmentUrl` must answer on. */
  contentOrigin: string;
  /** A pick id the Drive picker would issue to `member` for one file, or undefined when `features.drive` is false. */
  drivePick?(): Promise<string>;
  close?(): Promise<void>;
}
