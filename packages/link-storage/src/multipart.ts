import type { S3Credentials } from './credentials.ts';
import type { LinkLocationFields } from './location.ts';
import { boundedText, bucketUrl, discard, objectUrl, s3Request, type Fetcher } from './s3.ts';

const identifier = /^[A-Za-z0-9._~+/=-]{1,1024}$/;
const etag = /^"?[\x21\x23-\x7e]{1,128}"?$/;
const entities: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
const decode = (value: string) => value.replace(/&(?:amp|lt|gt|quot|apos);/g, entity => entities[entity]);
const encode = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
declare const FixedLengthStream: new (length: number) => {
  readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array>;
};
const badReply = (): never => { throw new Error('Unexpected link storage response'); };
const tag = (xml: string, name: string) => new RegExp(`<${name}>([^<>]*)</${name}>`).exec(xml)?.[1];
const root = (xml: string, name: string) => new RegExp(`^\\s*(?:<\\?xml[^?]*\\?>\\s*)?<${name}(?:\\s+[^>]*)?>([\\s\\S]*)</${name}>\\s*$`).exec(xml)?.[1];
function length(raw: string | undefined | null): number | undefined {
  if (!raw || !/^(0|[1-9][0-9]*)$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** A multipart provider call never preserves caller headers or retries a streamed body. */
export class LinkMultipart {
  private readonly fields: LinkLocationFields;
  private readonly credentials: S3Credentials;
  private readonly key: string;
  private readonly fetcher: Fetcher;
  constructor(fields: LinkLocationFields, credentials: S3Credentials, key: string, fetcher: Fetcher = request => fetch(request)) {
    this.fields = fields;
    this.credentials = credentials;
    this.key = key;
    this.fetcher = fetcher;
  }

  private call(method: 'GET' | 'HEAD' | 'PUT' | 'POST' | 'DELETE', params?: Record<string, string>,
    body?: string | ReadableStream<Uint8Array>, headers?: Record<string, string>, bucket = false) {
    const url = bucket ? bucketUrl(this.fields) : objectUrl(this.fields, this.key);
    if (params) url.search = new URLSearchParams(params).toString();
    return s3Request(this.fetcher, this.fields, this.credentials, url, { method, body, headers, timeoutMs: method === 'PUT' || method === 'POST' ? 60_000 : 20_000 });
  }

  private async xml(response: Response, name: string) {
    if (!response.ok) { discard(response); return badReply(); }
    const xml = root(await boundedText(response, 128 * 1024) ?? '', name);
    return xml === undefined ? badReply() : xml;
  }

  async create(): Promise<string> {
    const xml = await this.xml(await this.call('POST', { uploads: '' }, undefined, { 'content-type': 'application/octet-stream' }), 'InitiateMultipartUploadResult');
    const id = tag(xml, 'UploadId');
    return id && identifier.test(id) ? id : badReply();
  }

  async part(uploadId: string, partNumber: number, body: ReadableStream<Uint8Array>, bytes: number): Promise<void> {
    // The native pipe enforces length at the stream boundary as well as on the HTTP header.
    const fixed = new FixedLengthStream(bytes);
    const pumping = body.pipeTo(fixed.writable);
    void pumping.catch(() => {}); // The provider can reject while the native pipe is already failing.
    // fetch can reject before consuming a byte; stop the pipe in that case.
    const reader = fixed.readable;
    try {
      const response = await this.call('PUT', { uploadId, partNumber: String(partNumber) }, reader, { 'content-length': String(bytes) });
      discard(response);
      if (!response.ok) return badReply();
      await pumping;
    } catch (error) {
      void reader.cancel().catch(() => {});
      throw error;
    }
  }

  async parts(uploadId: string): Promise<{ number: number; size: number; etag: string }[] | null> {
    const response = await this.call('GET', { uploadId });
    if (response.status === 404) { discard(response); return null; }
    const xml = await this.xml(response, 'ListPartsResult');
    if (tag(xml, 'IsTruncated') === 'true') return badReply();
    const parts = [];
    for (const [, part] of xml.matchAll(/<Part>([\s\S]*?)<\/Part>/g)) {
      const number = length(tag(part, 'PartNumber')), size = length(tag(part, 'Size')), entityTag = decode(tag(part, 'ETag') ?? '');
      if (!number || size === undefined || !etag.test(entityTag)) return badReply();
      parts.push({ number, size, etag: entityTag });
    }
    return parts;
  }

  async complete(uploadId: string, parts: readonly { number: number; etag: string }[]): Promise<string | null> {
    const xml = `<CompleteMultipartUpload>${parts.map(part => `<Part><PartNumber>${part.number}</PartNumber><ETag>${encode(part.etag)}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
    const response = await this.call('POST', { uploadId }, xml, { 'content-type': 'application/xml' });
    const version = this.version(response);
    // Complete can return HTTP 200 with an Error body.
    await this.xml(response, 'CompleteMultipartUploadResult');
    return version;
  }

  private version(response: Response): string | null {
    const value = response.headers.get('x-amz-version-id');
    if (value !== null && !identifier.test(value)) return badReply();
    return value;
  }

  async head(): Promise<{ size: number; version: string | null } | null> {
    const response = await this.call('HEAD');
    discard(response);
    if (response.status === 404) return null;
    const size = length(response.headers.get('content-length'));
    return response.ok && size !== undefined ? { size, version: this.version(response) } : badReply();
  }

  async sessions(): Promise<{ ids: string[]; truncated: boolean }> {
    // Prefix matching alone must never abort another object's multipart session.
    const xml = await this.xml(await this.call('GET', { uploads: '', prefix: this.key, 'max-uploads': '32' }, undefined, undefined, true), 'ListMultipartUploadsResult');
    const ids = [];
    for (const [, part] of xml.matchAll(/<Upload>([\s\S]*?)<\/Upload>/g)) {
      if (decode(tag(part, 'Key') ?? '') !== this.key) continue;
      const id = tag(part, 'UploadId');
      if (!id || !identifier.test(id)) return badReply();
      ids.push(id);
    }
    return { ids, truncated: tag(xml, 'IsTruncated') === 'true' };
  }

  async abort(uploadId: string): Promise<void> {
    const response = await this.call('DELETE', { uploadId });
    discard(response);
    if (!response.ok && response.status !== 404) return badReply();
  }

  async delete(version: string | null): Promise<void> {
    const response = await this.call('DELETE', version ? { versionId: version } : undefined);
    discard(response);
    if (!response.ok && response.status !== 404) return badReply();
  }
}
