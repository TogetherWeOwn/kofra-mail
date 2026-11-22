import { AwsClient } from 'aws4fetch';
import { MAX_RAW_BYTES, readExact } from './bytes.ts';

export type KofraConfig = Partial<Record<
  'KOFRA_S3_ENDPOINT' | 'KOFRA_S3_ACCESS_KEY_ID' | 'KOFRA_S3_SECRET_ACCESS_KEY' |
  'KOFRA_MAIL_BUCKET' | 'KOFRA_MAIL_WORKSPACE_ID', string>>;

export function isObjectKey(key: string): boolean {
  return /^(raw|attachments|drafts)\/[a-f0-9]{64}$/.test(key);
}

export function kofra(config: KofraConfig, workspaceId: string) {
  const { KOFRA_S3_ENDPOINT: endpoint, KOFRA_S3_ACCESS_KEY_ID: accessKeyId,
    KOFRA_S3_SECRET_ACCESS_KEY: secretAccessKey, KOFRA_MAIL_BUCKET: bucket,
    KOFRA_MAIL_WORKSPACE_ID: scope } = config;
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket || !scope || workspaceId !== scope) {
    throw new Error('Kofra mail object store unavailable for workspace');
  }
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('Invalid Kofra mail object store configuration');
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
