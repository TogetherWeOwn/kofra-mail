// Link storage locations (docs/m3-outbound-plan.md, M3-15a): where file-link
// objects live. A location is immutable once created; only its credentials
// rotate. Nothing in this module logs or reads a secret.

/** The fields of one S3-compatible location. */
export interface LinkLocationFields {
  /** `https://<host>`, normalised: no port, path, query, fragment or user information. */
  endpoint: string;
  region: string;
  bucket: string;
  /** `''` or a key prefix ending in `/`. */
  prefix: string;
  pathStyle: boolean;
}

/**
 * Zones refused for every endpoint, with all their subdomains (the C3 guard's
 * private-use zones, plus `workers.dev`). Configuration can only add to them.
 */
export const REQUIRED_REFUSED_ZONES: readonly string[] = Object.freeze(['localhost', 'local', 'internal', 'arpa', 'workers.dev']);

const MAX_ENDPOINT_BYTES = 512;
const label = /^(?!-)[a-z\d-]{1,63}(?<!-)$/;
const utf8 = new TextEncoder();

/** Lowercase, drop one trailing dot and require LDH labels; undefined if not a DNS name. */
function dnsName(value: string, minLabels: number): string | undefined {
  let name = value.toLowerCase();
  if (name.endsWith('.')) name = name.slice(0, -1);
  if (name.length === 0 || name.length > 253) return undefined;
  const labels = name.split('.');
  if (labels.length < minLabels || !labels.every(part => label.test(part))) return undefined;
  // A final label that is numeric or hex would make the name an IPv4 address.
  const last = labels[labels.length - 1];
  if (/^\d+$/.test(last) || /^0x[\da-f]*$/.test(last)) return undefined;
  return name;
}

const within = (host: string, zone: string) => host === zone || host.endsWith(`.${zone}`);

/** Every refused zone, normalised; undefined if any configured zone is invalid (fail closed). */
export function refusedZones(extra: readonly unknown[]): string[] | undefined {
  if (!Array.isArray(extra)) return undefined;
  const zones = [...REQUIRED_REFUSED_ZONES, ...extra].map(zone => typeof zone === 'string' ? dnsName(zone, 1) : undefined);
  return zones.every((zone): zone is string => zone !== undefined) ? zones : undefined;
}

/** True if `host` is a DNS name outside every refused zone. */
export function hostAllowed(host: string, zones: readonly string[]): boolean {
  if (host.startsWith('[') || /^[\d.]+$/.test(host)) return false;
  const name = dnsName(host, 2);
  return name !== undefined && name === host && !zones.some(zone => within(name, zone));
}

/**
 * The endpoint rules of the C3 SSRF guard: `https:` on port 443, a DNS name
 * (no IP literal) outside every refused zone, and no user information, path,
 * query or fragment. Returns the normalised origin, or undefined if refused.
 */
export function linkEndpoint(input: unknown, zones: readonly string[] | undefined): string | undefined {
  if (zones === undefined || typeof input !== 'string' || utf8.encode(input).length > MAX_ENDPOINT_BYTES) return undefined;
  // Controls and spaces are refused before parsing, which would silently drop some of them.
  if (/[\u0000- \u007f\\]/.test(input) || !/^https:\/\//i.test(input)) return undefined;
  const authority = input.slice('https://'.length).split(/[/?#]/, 1)[0];
  if (authority.includes('@')) return undefined;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  // The parser normalises an explicit `:443` to the default port, '' here.
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return undefined;
  if (url.pathname !== '/' || url.search || url.hash) return undefined;
  // The WHATWG parser has already turned every IPv4 form into dotted decimal and IPv6 into brackets.
  if (!hostAllowed(url.hostname, zones)) return undefined;
  return url.origin;
}

export type FieldProblem = { ok: false; field: string; reason: 'invalid' | 'endpoint' };
export type FieldsResult = { ok: true; fields: LinkLocationFields } | FieldProblem;

const bucketName = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const regionName = /^[a-z0-9][a-z0-9-]{0,31}$/;
const prefixChars = /^[A-Za-z0-9!_.*'()/-]{1,256}$/;

function validPrefix(value: string): boolean {
  if (value === '') return true;
  if (!prefixChars.test(value) || !value.endsWith('/') || value.startsWith('/')) return false;
  return value.slice(0, -1).split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}

function validBucket(value: string, pathStyle: boolean): boolean {
  if (!bucketName.test(value) || value.includes('..') || /^\d+\.\d+\.\d+\.\d+$/.test(value)) return false;
  // A virtual-hosted bucket is a DNS label under the endpoint, so a dot would break TLS.
  return pathStyle || !value.includes('.');
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const LOCATION_FIELD_NAMES = ['endpoint', 'region', 'bucket', 'prefix', 'pathStyle'] as const;

/**
 * Validates a location's fields. Shape errors name the field; an endpoint that
 * breaks the guard (including a virtual-hosted name inside a refused zone) is
 * reported as `endpoint`.
 */
export function locationFields(input: unknown, zones: readonly string[] | undefined): FieldsResult {
  if (!isRecord(input)) return { ok: false, field: '', reason: 'invalid' };
  const { endpoint, region, bucket, prefix = '', pathStyle } = input;
  if (typeof endpoint !== 'string') return { ok: false, field: '/endpoint', reason: 'invalid' };
  if (typeof region !== 'string' || !regionName.test(region)) return { ok: false, field: '/region', reason: 'invalid' };
  if (typeof pathStyle !== 'boolean') return { ok: false, field: '/pathStyle', reason: 'invalid' };
  if (typeof bucket !== 'string' || !validBucket(bucket, pathStyle)) return { ok: false, field: '/bucket', reason: 'invalid' };
  if (typeof prefix !== 'string' || !validPrefix(prefix)) return { ok: false, field: '/prefix', reason: 'invalid' };
  const origin = linkEndpoint(endpoint, zones);
  if (!origin) return { ok: false, field: '/endpoint', reason: 'endpoint' };
  if (!pathStyle && !hostAllowed(`${bucket}.${new URL(origin).hostname}`, zones!)) return { ok: false, field: '/endpoint', reason: 'endpoint' };
  return { ok: true, fields: { endpoint: origin, region, bucket, prefix, pathStyle } };
}

/** SHA-256 (hex) of a location's fields: the same location always has the same fingerprint. */
export async function locationFingerprint(fields: LinkLocationFields): Promise<string> {
  const canonical = JSON.stringify(['kofra-mail/link-location/v1', fields.endpoint, fields.region, fields.bucket, fields.prefix, fields.pathStyle]);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(canonical)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

/** A deployment location id: stable, chosen by the operator, never reused for other fields. */
export const isLocationId = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(value);

export interface DeploymentLocations {
  current: string;
  locations: Map<string, LinkLocationFields>;
}

/**
 * Parses `LINK_LOCATIONS`: `{ "current": "<id>", "locations": { "<id>": { endpoint, region,
 * bucket, prefix, pathStyle } } }`. Only the operator sets it, so the deployment's own
 * storage domain is allowed; the required zones are still refused. Undefined if absent
 * or invalid: links are then off for workspaces without an override.
 */
export function deploymentLocations(raw: unknown): DeploymentLocations | undefined {
  if (typeof raw !== 'string' || raw.length > 64 * 1024) return undefined;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  if (!isRecord(value) || !isLocationId(value.current) || !isRecord(value.locations)) return undefined;
  if (Object.keys(value).some(key => key !== 'current' && key !== 'locations')) return undefined;
  const zones = refusedZones([]);
  const locations = new Map<string, LinkLocationFields>();
  for (const [id, entry] of Object.entries(value.locations)) {
    if (!isLocationId(id) || !isRecord(entry) || Object.keys(entry).some(key => !(LOCATION_FIELD_NAMES as readonly string[]).includes(key))) return undefined;
    const parsed = locationFields(entry, zones);
    if (!parsed.ok) return undefined;
    locations.set(id, parsed.fields);
  }
  if (!locations.has(value.current) || locations.size > 32) return undefined;
  return { current: value.current, locations };
}
