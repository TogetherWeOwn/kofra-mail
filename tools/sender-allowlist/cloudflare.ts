export const WORKER_NAME = 'mail-send';
const API = 'https://api.cloudflare.com/client/v4';
const PARAM_LIMIT = 100;
const ID = /^[a-z0-9_-]+$/i;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class CloudflareMail {
  private readonly directoryUrl: string;
  private readonly deploymentsUrl: string;
  private readonly authorization: string;
  private readonly request: typeof fetch;

  constructor(env: NodeJS.ProcessEnv, request = fetch) {
    this.request = request;
    const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_D1_DATABASE_ID: database, CLOUDFLARE_API_TOKEN: token } = env;
    if (!account || !ID.test(account) || !database || !ID.test(database) || !token?.trim()) {
      throw new Error('Missing or invalid Cloudflare credentials');
    }
    const base = `${API}/accounts/${account}`;
    this.directoryUrl = `${base}/d1/database/${database}/query`;
    this.deploymentsUrl = `${base}/workers/scripts/${WORKER_NAME}/deployments`;
    this.authorization = `Bearer ${token}`;
  }

  private async result(url: string, options: RequestInit = {}): Promise<unknown> {
    const response = await this.request(url, {
      ...options,
      headers: { authorization: this.authorization, ...options.headers },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Cloudflare request failed');
    }
    const body: unknown = await response.json();
    if (!isRecord(body) || body.success !== true) throw new Error('Cloudflare request failed');
    return body.result;
  }

  async query(sql: string, params: string[]): Promise<Record<string, unknown>> {
    if (params.length > PARAM_LIMIT) throw new Error('D1 parameter limit exceeded');
    const result = await this.result(this.directoryUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sql, params }),
    });
    if (!Array.isArray(result) || result.length !== 1 || !isRecord(result[0]) || result[0].success !== true) {
      throw new Error('D1 statement failed');
    }
    return result[0];
  }

  async isActiveVersion(version: string): Promise<boolean> {
    const result = await this.result(this.deploymentsUrl);
    // Wrangler's deployments status uses the first (latest) entry from this endpoint.
    if (!isRecord(result) || !Array.isArray(result.deployments) || !isRecord(result.deployments[0])) return false;
    const { versions } = result.deployments[0];
    return Array.isArray(versions) && versions.length === 1 && isRecord(versions[0])
      && versions[0].version_id === version && versions[0].percentage === 100;
  }
}
