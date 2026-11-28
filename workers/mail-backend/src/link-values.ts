export type LinkLocationRef = { kind: 'deployment' | 'workspace'; id: string };
export type StoredFileLink = { location: LinkLocationRef; key: string; fingerprint: string; uploadId?: string };

/** A link host: a lowercase DNS name of at least two labels, no port. */
export function isLinkHost(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 253) return false;
  const labels = value.split('.');
  return labels.length >= 2 && labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) && !/^\d+$/.test(labels.at(-1)!);
}

const encoder = new TextEncoder();
/** A name as uploads take it (contract section 8.4): 1 to 255 UTF-8 bytes, no control characters, `/` or `\`. */
export const isLinkFileName = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && encoder.encode(value).byteLength <= 255 && !/[\p{Cc}/\\]/u.test(value);

export const isLinkUploadId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
