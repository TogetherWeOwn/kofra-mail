import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';

export async function migrateDirectory(db: D1Database): Promise<void> {
  for (const name of ['0001_directory.sql', '0002_outbox.sql', '0003_delivery_claims.sql',
    '0004_mailbox_replay.sql', '0005_delivery_fencing.sql', '0006_mail_alerts.sql',
    '0007_backup_watermark.sql']) {
    const sql = await readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
    // Keep the semicolons inside the SQLite trigger bodies.
    const statements = sql.split(/;\s*\n(?=\s*(?:CREATE |ALTER |--|$))/).filter(s => s.trim());
    await db.batch(statements.map(s => db.prepare(s)));
  }
}

export async function seedDirectory(db: D1Database, workspaceId: string, mailboxIds: string[]): Promise<void> {
  await db.prepare(`INSERT INTO domains VALUES ('d1', ?, 'example.test', 'primary', NULL, 'ready', 'ready')`)
    .bind(workspaceId).run();
  for (const id of mailboxIds) {
    const address = `${id}@example.test`;
    await db.batch([
      db.prepare('INSERT INTO mailboxes (id, workspace_id, user_id, primary_address) VALUES (?, ?, ?, ?)')
        .bind(id, workspaceId, `user-${id}`, address),
      db.prepare("INSERT INTO addresses VALUES (?, ?, 'mailbox', ?, 'primary', 'allowed')")
        .bind(address, workspaceId, id),
    ]);
  }
}
