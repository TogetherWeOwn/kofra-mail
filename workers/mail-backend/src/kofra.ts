import { AwsClient } from 'aws4fetch';
import { MAX_RAW_BYTES, readExact, sha256 } from './bytes.ts';
import { workspaceMailBucket } from './directory.ts';
import { isObjectDigest, parseObjectKey } from './object-key.ts';

export type KofraConfig = Partial<Record<
  'KOFRA_S3_ENDPOINT' | 'KOFRA_S3_ACCESS_KEY_ID' | 'KOFRA_S3_SECRET_ACCESS_KEY', string>>;

function objectDigest(key: string): string | null {
  if (key.startsWith('drafts/')) {
    const digest = key.slice('drafts/'.length);
    return isObjectDigest(digest) ? digest : null;
  }
  return parseObjectKey(key)?.digest ?? null;
}

export function isObjectKey(key: string): boolean {
  return objectDigest(key) !== null;
}

export function kofra(config: KofraConfig, workspaceId: string) {
  const { KOFRA_S3_ENDPOINT: endpoint, KOFRA_S3_ACCESS_KEY_ID: accessKeyId,
    KOFRA_S3_SECRET_ACCESS_KEY: secretAccessKey } = config;
  if (!endpoint || !accessKeyId || !secretAccessKey) throw new Error('Kofra mail object store unavailable for workspace');
  const bucket = workspaceMailBucket(workspaceId);
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Invalid Kofra mail object store configuration');
  }
  const s3 = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto', retries: 0 });
  async function request(method: 'GET' | 'PUT', key: string, body?: Uint8Array<ArrayBuffer>): Promise<Response> {
    const keyDigest = objectDigest(key);
    if (!keyDigest) throw new Error('Invalid mail object key');
    let headers: Record<string, string> | undefined;
    if (body) {
      const digest = await sha256(body);
      if (digest !== keyDigest) throw new Error('Mail object digest mismatch');
      headers = { 'content-type': 'application/octet-stream', 'x-amz-content-sha256': digest };
    }
    // The client signs a fixed origin, bucket and validated path; never follow redirects.
    let response: Response;
    try {
      response = await s3.fetch(`${url.origin}/${bucket}/${key}`, { method, body, headers, redirect: 'manual' });
    } catch {
      throw new Error(`Kofra object ${method} failed`);
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new Error(`Kofra object ${method} failed (${response.status})`);
    }
    return response;
  }
  return {
    async put(key: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
      const response = await request('PUT', key, bytes);
      await response.body?.cancel();
    },
    async get(key: string): Promise<Uint8Array<ArrayBuffer>> {
      const response = await request('GET', key);
      const size = response.headers.get('content-length');
      if (!response.body || !size || !/^\d+$/.test(size) || Number(size) > MAX_RAW_BYTES) {
        void response.body?.cancel().catch(() => {});
        throw new Error('Invalid Kofra object size');
      }
      return readExact(response.body, Number(size), MAX_RAW_BYTES);
    },
  };
}
