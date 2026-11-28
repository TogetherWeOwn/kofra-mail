// A compact, per-message verdict derived at ingest from the first Cloudflare
// Authentication-Results field (isolated and bounded at ingress). It is kept with
// the message, its journal event and the snapshot, so it outlives the outbox row.
//   pass       DMARC passed for the domain of the single parsed From address
//   unaligned  DMARC passed, but for another domain (or From is not one address)
//   <result>   any other DMARC result, such as fail, none, temperror or permerror
//   none       no Cloudflare result or no DMARC result in it
//   internal   a child delivery of this workspace's own send (M3-8), set only
//              from the delivery row's source column, never from any header
export const AUTH_VERDICT = /^[a-z]{1,16}$/;
export const INTERNAL_VERDICT = 'internal';

// `singleFrom` is false unless the message has exactly one From field naming exactly one mailbox.
export function authVerdict(results: string | null, from: string, singleFrom = true): string {
  if (!results) return 'none';
  const dmarc = /(?:^|;)\s*dmarc=([a-z]+)([^;]*)/i.exec(results);
  if (!dmarc) return 'none';
  const result = dmarc[1].toLowerCase();
  // A header can never claim the internal verdict.
  if (!AUTH_VERDICT.test(result) || result === INTERNAL_VERDICT) return 'none';
  if (result !== 'pass') return result;
  const headerFrom = /(?:^|\s)header\.from=([^\s;()]+)/i.exec(dmarc[2])?.[1].toLowerCase();
  const address = from.trim();
  if (!singleFrom || !headerFrom || !address || /[,\s]/.test(address)) return 'unaligned';
  const domain = address.slice(address.lastIndexOf('@') + 1).toLowerCase();
  return domain === headerFrom ? 'pass' : 'unaligned';
}
