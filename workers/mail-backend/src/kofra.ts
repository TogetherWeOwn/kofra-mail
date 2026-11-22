import { AwsClient } from 'aws4fetch';
import { MAX_RAW_BYTES, readExact } from './bytes.ts';
import { workspaceMailBucket } from './directory.ts';
import { parseObjectKey } from './object-key.ts';

export type KofraConfig = Partial<Record<
  'KOFRA_S3_ENDPOINT' | 'KOFRA_S3_ACCESS_KEY_ID' | 'KOFRA_S3_SECRET_ACCESS_KEY', string>>;

export function isObjectKey(key: string): boolean {
  return parseObjectKey(key) !== null || /^drafts\/[a-f0-9]{64}(?![\s\S])/.test(key);
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
    if (!isObjectKey(key)) throw new Error('Invalid mail object key');
    // The client signs a fixed origin, bucket and validated path; never follow redirects.
    let response: Response;
    try {
      response = await s3.fetch(`${url.origin}/${bucket}/${key}`, { method, body, redirect: 'manual',
        headers: body ? { 'content-type': 'application/octet-stream' } : undefined });
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
