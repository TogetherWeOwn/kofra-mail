import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';

export const account = 'fixture-account';
export const database = 'fixture-database';
export const token = 'fixture-token';
export const version = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const otherVersion = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const exampleDomain = 'directory-fixture.test';
export const quotedAddress = `o'neil@${exampleDomain}`;
export const credentials = {
  CLOUDFLARE_ACCOUNT_ID: account,
  CLOUDFLARE_D1_DATABASE_ID: database,
  CLOUDFLARE_API_TOKEN: token,
};

export async function directoryFixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../../../workers/mail-backend/migrations/0001_directory.sql', import.meta.url), 'utf8'));
  function mailbox(id: string, workspace: string) {
    db.prepare('INSERT INTO mailboxes (id, workspace_id, user_id, primary_address) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING')
      .run(id, workspace, id, `${id}@mailbox-fixture.test`);
  }
  const calls: { sql: string; params: string[] }[] = [];
  const events: string[] = [];
  const control = {
    deployments: [{ versions: [{ version_id: version, percentage: 100 }] }],
    failQuery: false,
  };
  const d1Path = `/client/v4/accounts/${account}/d1/database/${database}/query`;
  const deploymentPath = `/client/v4/accounts/${account}/workers/scripts/mail-send/deployments`;
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== `Bearer ${token}`) throw new Error('missing fixture authorization');
      res.setHeader('content-type', 'application/json');
      if (req.url === deploymentPath && req.method === 'GET') {
        events.push('verify');
        res.end(JSON.stringify({ success: true, result: { deployments: control.deployments } }));
        return;
      }
      if (req.url !== d1Path || req.method !== 'POST') throw new Error('unexpected fixture route');
      const body: Buffer[] = [];
      for await (const chunk of req) body.push(chunk);
      const { sql, params } = JSON.parse(Buffer.concat(body).toString('utf8'));
      if (typeof sql !== 'string' || !Array.isArray(params) || params.length > 100) {
        throw new Error('fixture rejects invalid D1 statement');
      }
      calls.push({ sql, params });
      if (control.failQuery) throw new Error(quotedAddress);
      const stmt = db.prepare(sql);
      if (/^SELECT/.test(sql)) {
        res.end(JSON.stringify({ success: true, result: [{ success: true, results: stmt.all(...params) }] }));
      } else {
        events.push(sql.includes("SET send_as_policy = 'pending'") ? 'lower' : 'promote');
        const { changes } = stmt.run(...params);
        res.end(JSON.stringify({ success: true, result: [{ success: true, results: [], meta: { changes } }] }));
      }
    } catch (error) {
      res.statusCode = 400;
      res.end(JSON.stringify({ success: false, errors: [{ message: String(error) }] }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind a TCP port');
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  });
  return {
    db, calls, events, control, origin,
    request: ((input, options) => fetch(origin + new URL(String(input)).pathname, options)) as typeof fetch,
    mailbox,
    domain(name = exampleDomain, sendingState = 'active') {
      db.prepare(`INSERT INTO domains (id, name, workspace_id, kind, routing_state, sending_state)
        VALUES (?, ?, 'wk', 'primary', 'active', ?)`).run(name, name, sendingState);
    },
    address(name: string, policy = 'pending', workspace = 'wk', target = `mailbox-${workspace}`) {
      mailbox(target, workspace);
      db.prepare(`INSERT INTO addresses (address_norm, workspace_id, send_as_policy, target_id, target_kind, kind)
        VALUES (?, ?, ?, ?, 'mailbox', 'alias')`).run(name, workspace, policy, target);
    },
    policy(name: string): string | undefined {
      return db.prepare('SELECT send_as_policy FROM addresses WHERE address_norm = ?').get(name)?.send_as_policy as string | undefined;
    },
    setPolicy(name: string, policy: string) {
      db.prepare('UPDATE addresses SET send_as_policy = ? WHERE address_norm = ?').run(policy, name);
    },
  };
}
