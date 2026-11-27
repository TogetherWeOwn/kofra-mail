// The account quota gate as the send path sees it (docs/m3-outbound-plan.md,
// section 2.4, consumer steps 2 and 3a, and M3-6). The consumer reserves and
// confirms; the mailbox releases refused or never-authorized charges and asks
// for the reset time.

// A send attempt's fence: the mailbox's recovery epoch and the send's attempt.
export type SendFence = { epoch: number; attempt: number };

// Reservations are keyed by (workspace, mailbox, sendId, recipient, quota day,
// fence): a sendId is unique only within a mailbox. Recipients are ledger
// indexes, never addresses.
export type QuotaScope = { workspaceId: string; mailboxId: string; sendId: string };

// `day` names the quota day the charge sits in and `dayEnd` is when that day
// ends on the quota object's clock (the consumer passes it to
// authorizeDispatch). `exhausted`: the gate that refused this request (daily
// or monthly) opens again at `resetAt`; the consumer passes it to delaySend. `stale`: the fence is older than the newest fence seen for a
// recipient, or it was released.
export type QuotaAnswer =
  | { status: 'ok'; day: string; dayEnd: number }
  | { status: 'exhausted'; resetAt: number }
  | { status: 'stale' };

export interface QuotaPort {
  // Consumer step 2, one call: releases the reservations of every fence in
  // `release` (an absent one is a no-op), advances the newest fence of each
  // recipient to `fence` and reserves every recipient under it, all or
  // nothing. A reservation expires by itself at `expiresAt` unless confirmed.
  // The releases take effect also when the reservation is refused: the fences
  // stay listed until a Mark acknowledges them, and releasing again is a no-op.
  reserve(scope: QuotaScope, fence: SendFence, recipients: number[], release: SendFence[], expiresAt: number): Promise<QuotaAnswer>;
  // Consumer step 3a: confirms the fence's reservation, re-reserving an
  // expired one and moving a charge from an ended quota day to the current one.
  confirm(scope: QuotaScope, fence: SendFence, recipients: number[]): Promise<QuotaAnswer>;
  // Releases every reservation of each fence, in whatever quota day it sits,
  // and invalidates the fence for later reservations and confirmations.
  // Idempotent.
  release(scope: QuotaScope, fences: SendFence[]): Promise<void>;
  // The end of the current quota day, on the quota object's clock: the
  // provider's daily limit resets then. (A refused reservation carries the
  // reset of the gate that refused it in its `exhausted` answer.)
  resetAt(): Promise<number>;
}

// Both Workers must address the same object in the mail-backend namespace.
export type SendQuotaBinding = { getByName(name: string): QuotaPort };
export const accountSendQuota = (binding: SendQuotaBinding): QuotaPort => binding.getByName('account');

export const fenceKey = ({ epoch, attempt }: SendFence) => `${epoch}:${attempt}`;
export const sameFence = (a: SendFence | null | undefined, b: SendFence | null | undefined) =>
  !!a && !!b && a.epoch === b.epoch && a.attempt === b.attempt;
// Fences order by recovery epoch first, then by attempt.
export const fenceBefore = (a: SendFence, b: SendFence) => a.epoch < b.epoch || (a.epoch === b.epoch && a.attempt < b.attempt);
export const validFence = (value: unknown): value is SendFence => {
  const fence = value as Partial<SendFence> | null;
  return !!fence && typeof fence === 'object' && Number.isSafeInteger(fence.epoch) && fence.epoch! >= 0 &&
    Number.isSafeInteger(fence.attempt) && fence.attempt! >= 1;
};
