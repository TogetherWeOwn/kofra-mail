import type { MailService } from './service.ts';
import type { Address, Id } from './wire.ts';

/**
 * Who a conformance case calls as. The first five are in workspace W1.
 * - `member`: owns mailbox A; workspace role `member`.
 * - `other`: owns mailbox B; role `member`. Used to prove isolation.
 * - `admin`: owns mailbox C; role `admin`, signed in within the last minute.
 * - `staleAdmin`: the same admin with an `authTime` 11 minutes old.
 * - `newAdmin`: role `admin`, signed in within the last minute, no mailbox.
 * - `foreignAdmin`: role `admin` of a second workspace W2 with its own
 *   mailbox, signed in within the last minute. Used to prove workspace isolation.
 * W1 also has one invited member without a mailbox, listed by `listMembers`.
 */
export type Principal = 'member' | 'other' | 'admin' | 'staleAdmin' | 'newAdmin' | 'foreignAdmin';

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
  /** The message's `Message-ID` header, bracketed; the harness makes a unique one when absent. */
  messageId?: string;
}

/**
 * Header fields of a sent copy's stored MIME: lower-case names, unfolded
 * values. The stored copy carries the same `In-Reply-To`, `References` and
 * address headers as the provider request.
 */
export type SentHeaders = Record<string, string>;

/** Drive fault injection, for implementations whose Drive is a local stand-in. */
export interface DriveFaults {
  /**
   * The next `saveAttachmentToDrive` commits its file at Drive and then fails
   * with 503 `unavailable`, as if the reply was lost before Mail recorded it.
   */
  loseNextSaveReply(): Promise<void>;
  /**
   * The next `saveAttachmentToDrive` commits its file at Drive and then Mail
   * crashes: no result is stored and only the in-progress marker remains. The
   * call itself fails with 503 `unavailable`.
   */
  crashNextSaveAfterDrive(): Promise<void>;
  /** Files Drive holds for `member`. */
  savedFiles(): Promise<number>;
}

/**
 * What an implementation supplies to run the conformance suite. The fake
 * implements it in memory. The backend implements it over HTTP against a local
 * workerd, with `deliver` going through the inbound path and `advance` running
 * the mailbox timers.
 */
export interface ConformanceHarness {
  /** True by default. Set false to run the M2-W gate instead of outbound cases. */
  m3?: boolean;
  as(principal: Principal): MailService;
  /** Fixture-only promotion of a primary to simulate the deployed allow-list. */
  activatePrimary(address: string): Promise<void>;
  /** Deliver to a principal's mailbox (default `member`). */
  deliver(message: TestMessage, to?: Principal): Promise<{ threadId: Id; messageId: Id }>;
  /** Move the service clock forward and run every timer that is due. */
  advance(ms: number): Promise<void>;
  /** Origin that `getBodyUrl` and `getAttachmentUrl` must answer on. */
  contentOrigin: string;
  /** The stored header fields of a sent copy in `member`'s mailbox (`Message.sent`); `not_found` otherwise. */
  sentHeaders(messageId: Id): Promise<SentHeaders>;
  /** A pick id the Drive picker would issue to `member` for one file, or undefined when `features.drive` is false. */
  drivePick?(): Promise<string>;
  /** Present when `features.drive` is on and Drive can be faulted locally. */
  driveFaults?: DriveFaults;
  /** The problem `type` prefix this deployment is configured with; `PROBLEM_TYPE_PREFIX` when absent. */
  problemTypePrefix?: string;
  /** The account service's current credential epoch for a principal, when the harness can read it. */
  credentialEpoch?(principal: Principal): Promise<number>;
  close?(): Promise<void>;
}
