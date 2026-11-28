// A local, in-process fake of an S3-compatible endpoint, for tests only. It
// verifies SigV4 signatures, enforces per-key permissions and can be made
// public, redirecting or broken. No real provider or credential is involved.
import { AwsV4Signer } from 'aws4fetch';

export type S3Op = 'HeadBucket' | 'PutObject' | 'GetObject' | 'DeleteObject' | 'DeleteObjectVersion' | 'ListObjects' | 'CreateMultipart'
  | 'UploadPart' | 'ListParts' | 'CompleteMultipart' | 'AbortMultipart';
export const ALL_OPS: readonly S3Op[] = ['HeadBucket', 'PutObject', 'GetObject', 'DeleteObject', 'DeleteObjectVersion', 'ListObjects',
  'CreateMultipart', 'UploadPart', 'ListParts', 'CompleteMultipart', 'AbortMultipart'];
export const READ_OPS: readonly S3Op[] = ['GetObject'];
export const MULTIPART_OPS: readonly S3Op[] = ['CreateMultipart', 'UploadPart', 'ListParts', 'CompleteMultipart', 'AbortMultipart'];

export interface FakeKey { secret: string; ops: Set<S3Op> }
export interface FakeS3Options {
  host: string;
  bucket: string;
  region?: string;
  pathStyle?: boolean;
  keys: Record<string, FakeKey>;
  /** Anonymous operations the bucket allows (a public bucket). */
  anonymous?: S3Op[];
  /** Answer this status (with a Location header) to every request. */
  redirect?: number;
  /** Answer a 200 error document to CompleteMultipartUpload. */
  completeError?: boolean;
  /** Keep every written version; a DELETE without `versionId` only adds a delete marker. */
  versioning?: boolean;
}

export interface FakeCall { op: S3Op | 'unknown'; key: string; signedBy: string | null; status: number }

export function fakeS3(options: FakeS3Options) {
  const region = options.region ?? 'auto';
  const objects = new Map<string, Uint8Array<ArrayBuffer>>();
  const uploads = new Map<string, Map<number, Uint8Array<ArrayBuffer>>>();
  // Stored versions (with versioning on): delete markers are not kept here.
  const versions: { key: string; versionId: string }[] = [];
  const markers: { key: string; versionId: string }[] = [];
  let versionCounter = 0;
  const write = (key: string, body: Uint8Array<ArrayBuffer>): Record<string, string> => {
    objects.set(key, body);
    if (!options.versioning) return {};
    const versionId = `v${++versionCounter}`;
    versions.push({ key, versionId });
    return { 'x-amz-version-id': versionId };
  };
  const calls: FakeCall[] = [];
  let uploadCounter = 0;

  const xml = (body: string, status = 200) => new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`,
    { status, headers: { 'content-type': 'application/xml' } });
  const error = (code: string, status: number) => xml(`<Error><Code>${code}</Code><Message>fake ${code}</Message></Error>`, status);

  async function signer(request: Request, body: Uint8Array<ArrayBuffer>): Promise<string | null | false> {
    const auth = request.headers.get('authorization');
    if (!auth) return null;
    const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(auth);
    if (!match) return false;
    const [, keyId, , signedRegion, signedHeaders] = match;
    const key = options.keys[keyId];
    const datetime = request.headers.get('x-amz-date');
    if (!key || signedRegion !== region || !datetime) return false;
    const headers = new Headers();
    for (const name of signedHeaders.split(';')) if (name !== 'host') headers.set(name, request.headers.get(name) ?? '');
    const expected = await new AwsV4Signer({ method: request.method, url: request.url, headers, body, accessKeyId: keyId,
      secretAccessKey: key.secret, service: 's3', region, datetime }).authHeader();
    return expected === auth ? keyId : false;
  }

  function locate(url: URL): { bucket: string; key: string } | undefined {
    if (options.pathStyle ?? true) {
      if (url.hostname !== options.host) return undefined;
      const [, bucket, ...rest] = url.pathname.split('/');
      return { bucket, key: rest.map(decodeURIComponent).join('/') };
    }
    if (url.hostname !== `${options.bucket}.${options.host}`) return undefined;
    return { bucket: options.bucket, key: url.pathname.slice(1).split('/').map(decodeURIComponent).join('/') };
  }

  function operation(method: string, key: string, query: URLSearchParams): S3Op | 'unknown' {
    if (!key) return method === 'HEAD' ? 'HeadBucket' : method === 'GET' && query.get('list-type') === '2' ? 'ListObjects' : 'unknown';
    if (method === 'POST' && query.has('uploads')) return 'CreateMultipart';
    if (method === 'PUT' && query.has('uploadId') && query.has('partNumber')) return 'UploadPart';
    if (method === 'GET' && query.has('uploadId')) return 'ListParts';
    if (method === 'POST' && query.has('uploadId')) return 'CompleteMultipart';
    if (method === 'DELETE' && query.has('uploadId')) return 'AbortMultipart';
    if (method === 'DELETE' && query.has('versionId') && query.size === 1) return 'DeleteObjectVersion';
    if (query.size) return 'unknown';
    return ({ PUT: 'PutObject', GET: 'GetObject', HEAD: 'GetObject', DELETE: 'DeleteObject' } as const)[method as 'PUT'] ?? 'unknown';
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.protocol !== 'https:') throw new TypeError('fake endpoint is https only');
    if (options.redirect) return new Response(null, { status: options.redirect, headers: { location: 'https://elsewhere.example/' } });
    const where = locate(url);
    if (!where) throw new TypeError('fetch failed: unknown fake host');
    const body = new Uint8Array(await request.arrayBuffer());
    const op = operation(request.method, where.key, url.searchParams);
    const signedBy = await signer(request, body);
    const record = (response: Response) => {
      calls.push({ op, key: where.key, signedBy: signedBy || null, status: response.status });
      return response;
    };
    if (where.bucket !== options.bucket) return record(error('NoSuchBucket', 404));
    if (op === 'unknown') return record(error('NotImplemented', 501));
    if (signedBy === false) return record(error('SignatureDoesNotMatch', 403));
    const allowed = signedBy === null ? (options.anonymous ?? []).includes(op) : options.keys[signedBy].ops.has(op);
    if (!allowed) return record(error('AccessDenied', 403));
    const uploadId = url.searchParams.get('uploadId') ?? '';
    switch (op) {
      case 'HeadBucket': return record(new Response(null, { status: 200 }));
      case 'PutObject': return record(new Response(null, { status: 200, headers: { etag: '"put"', ...write(where.key, body) } }));
      case 'GetObject': {
        const value = objects.get(where.key);
        if (!value) return record(error('NoSuchKey', 404));
        return record(new Response(request.method === 'HEAD' ? null : value, { status: 200 }));
      }
      case 'DeleteObject': {
        objects.delete(where.key);
        if (!options.versioning) return record(new Response(null, { status: 204 }));
        // Versioned: the versions stay; a delete marker hides them.
        const markerId = `m${++versionCounter}`;
        markers.push({ key: where.key, versionId: markerId });
        return record(new Response(null, { status: 204, headers: { 'x-amz-version-id': markerId, 'x-amz-delete-marker': 'true' } }));
      }
      case 'DeleteObjectVersion': {
        const versionId = url.searchParams.get('versionId');
        const index = versions.findIndex(v => v.key === where.key && v.versionId === versionId);
        if (index !== -1) versions.splice(index, 1);
        const marker = markers.findIndex(v => v.key === where.key && v.versionId === versionId);
        if (marker !== -1) markers.splice(marker, 1);
        if (!versions.some(v => v.key === where.key)) objects.delete(where.key);
        return record(new Response(null, { status: 204 }));
      }
      case 'ListObjects': {
        const prefix = url.searchParams.get('prefix') ?? '';
        const keys = [...objects.keys()].filter(k => k.startsWith(prefix)).map(k => `<Contents><Key>${k}</Key></Contents>`).join('');
        return record(xml(`<ListBucketResult>${keys}</ListBucketResult>`));
      }
      case 'CreateMultipart': {
        const id = `upload-${++uploadCounter}`;
        uploads.set(id, new Map());
        return record(xml(`<InitiateMultipartUploadResult><Bucket>${options.bucket}</Bucket><Key>${where.key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`));
      }
      case 'UploadPart': {
        const parts = uploads.get(uploadId);
        if (!parts) return record(error('NoSuchUpload', 404));
        const number = Number(url.searchParams.get('partNumber'));
        parts.set(number, body);
        return record(new Response(null, { status: 200, headers: { etag: `"part-${number}"` } }));
      }
      case 'ListParts': {
        const parts = uploads.get(uploadId);
        if (!parts) return record(error('NoSuchUpload', 404));
        return record(xml(`<ListPartsResult>${[...parts.keys()].map(n => `<Part><PartNumber>${n}</PartNumber><ETag>"part-${n}"</ETag></Part>`).join('')}</ListPartsResult>`));
      }
      case 'CompleteMultipart': {
        const parts = uploads.get(uploadId);
        if (!parts) return record(error('NoSuchUpload', 404));
        if (options.completeError) return record(xml('<Error><Code>InternalError</Code></Error>'));
        const headers = write(where.key, new Uint8Array(Buffer.concat([...parts.values()])));
        uploads.delete(uploadId);
        const done = xml(`<CompleteMultipartUploadResult><Key>${where.key}</Key><ETag>"done"</ETag></CompleteMultipartUploadResult>`);
        for (const [name, value] of Object.entries(headers)) done.headers.set(name, value);
        return record(done);
      }
      case 'AbortMultipart': uploads.delete(uploadId); return record(new Response(null, { status: 204 }));
    }
  }

  return { fetch: handle, objects, uploads, versions, markers, calls };
}
