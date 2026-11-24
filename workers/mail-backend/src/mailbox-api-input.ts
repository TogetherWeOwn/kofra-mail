import { hasHeaderControl } from '../../../contracts/mail-api/src/headers.ts';
import { LIMITS } from '../../../contracts/mail-api/src/limits.ts';
import type { MailErrorCode, Problem } from '../../../contracts/mail-api/src/errors.ts';

export type MailboxApiError = Omit<Problem, 'type' | 'title' | 'status' | 'requestId'>;
export class ApiFault extends Error {
  constructor(readonly problem: MailboxApiError) { super(problem.code); }
}
export function fail(code: MailErrorCode, extra?: Omit<MailboxApiError, 'code'>): never {
  throw new ApiFault({ code, ...extra });
}
export function invalid(field: string, code: NonNullable<Problem['errors']>[number]['code'] = 'invalid'): never {
  return fail('invalid_request', { errors: [{ field, code }] });
}
const encoder = new TextEncoder();
export function utf8(text: string): Uint8Array<ArrayBuffer> { return new Uint8Array(encoder.encode(text)); }
export function object(input: unknown, allowed: readonly string[], field = ''): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid(field);
  for (const key of Object.keys(input)) if (!allowed.includes(key)) fail('unknown_field');
  return input as Record<string, unknown>;
}
export function text(input: unknown, max: number, field: string, header = false): string {
  if (typeof input !== 'string') return invalid(field, input === undefined ? 'required' : 'invalid');
  if (header && hasHeaderControl(input)) fail('invalid_header', { errors: [{ field, code: 'invalid' }] });
  if (input.length > max || utf8(input).byteLength > max) return invalid(field, 'too_long');
  return input;
}
export function requireId(value: unknown, field: string): string {
  if (!isId(value)) return invalid(field);
  return value;
}
export function isId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}
export function need<T>(value: T | null | undefined): T {
  if (value == null) return fail('not_found');
  return value;
}
export function pageLimit(input: string | undefined): number {
  if (input === undefined) return LIMITS.pageSizeDefault;
  if (!/^\d{1,3}$/.test(input) || Number(input) < 1 || Number(input) > LIMITS.pageSizeMax) return invalid('/limit');
  return Number(input);
}
export function iso(value: number): string { return new Date(value).toISOString(); }

// Only inputs transported as JSON can reach this helper. Sorting object keys
// gives semantically identical request bodies the same durable fingerprint.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function encode64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function makeCursor(scope: string, position: readonly [number, string]): string {
  return encode64(utf8(JSON.stringify([scope, ...position])));
}
export function cursorPosition(cursor: string | undefined, scope: string): [number, string] | undefined {
  if (cursor === undefined) return;
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(cursor)) return fail('invalid_cursor');
  try {
    const raw = Uint8Array.from(atob(cursor.replaceAll('-', '+').replaceAll('_', '/')), ch => ch.charCodeAt(0));
    if (encode64(raw) !== cursor) return fail('invalid_cursor');
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw));
    if (!Array.isArray(value) || value.length !== 3 || value[0] !== scope ||
        !Number.isSafeInteger(value[1]) || value[1] < 0 || value[1] > 8.64e15 || !isId(value[2])) return fail('invalid_cursor');
    return [value[1] as number, value[2]];
  } catch { return fail('invalid_cursor'); }
}
