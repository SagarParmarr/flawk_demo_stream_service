import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DemoRepository, DemoSession } from '../domain/demo.js';

interface Row { payload: string }

export class SqliteDemoRepository implements DemoRepository {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS demo_sessions (
        id TEXT PRIMARY KEY,
        owner_id INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        UNIQUE(owner_id, idempotency_key)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_demo_per_owner
        ON demo_sessions(owner_id)
        WHERE status IN ('starting', 'default_live', 'selected_live', 'stopping');
    `);
  }

  find(id: string): DemoSession | null {
    return this.decode(this.db.prepare('SELECT payload FROM demo_sessions WHERE id = ?').get(id) as Row | undefined);
  }

  findActiveByOwner(ownerId: number): DemoSession | null {
    return this.decode(this.db.prepare(`SELECT payload FROM demo_sessions
      WHERE owner_id = ? AND status IN ('starting', 'default_live', 'selected_live', 'stopping')`).get(ownerId) as Row | undefined);
  }

  findByIdempotencyKey(ownerId: number, key: string): DemoSession | null {
    return this.decode(this.db.prepare('SELECT payload FROM demo_sessions WHERE owner_id = ? AND idempotency_key = ?').get(ownerId, key) as Row | undefined);
  }

  listNonterminal(): DemoSession[] {
    const rows = this.db.prepare(`SELECT payload FROM demo_sessions WHERE status IN
      ('starting', 'default_live', 'selected_live', 'stopping')`).all() as unknown as Row[];
    return rows.map((row) => JSON.parse(row.payload) as DemoSession);
  }

  create(session: DemoSession): void {
    this.db.prepare(`INSERT INTO demo_sessions (id, owner_id, idempotency_key, status, payload)
      VALUES (?, ?, ?, ?, ?)`).run(session.id, session.ownerId, session.idempotencyKey, session.status, JSON.stringify(session));
  }

  save(session: DemoSession): void {
    const result = this.db.prepare('UPDATE demo_sessions SET status = ?, payload = ? WHERE id = ?')
      .run(session.status, JSON.stringify(session), session.id);
    if (result.changes !== 1) throw new Error('Demo session disappeared');
  }

  close(): void { this.db.close(); }

  private decode(row: Row | undefined): DemoSession | null {
    return row ? JSON.parse(row.payload) as DemoSession : null;
  }
}
