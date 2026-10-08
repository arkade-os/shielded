import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const keyFor = (value: string) => {
  if (!/^[a-f\d]{64}$/i.test(value)) throw new Error('Configured storage key must be 64 hexadecimal characters from a cryptographically random source.');
  return Buffer.from(value, 'hex');
};

/** Whether opening failed only because another process still owns the store, as during a rolling deploy. */
export const isStorageLocked = (error: unknown): boolean =>
  error instanceof Error && (/database is locked/i.test(error.message) || isStorageLocked(error.cause));

export class EngineStore {
  private readonly db: DatabaseSync;
  private closed = false;

  private constructor(dbPath: string, key: Buffer) {
    this.db = new DatabaseSync(dbPath);
    try {
      chmodSync(dbPath, 0o600);
      this.db.exec('PRAGMA busy_timeout=500; PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS checkpoint (id INTEGER PRIMARY KEY CHECK (id=1), iv BLOB NOT NULL, tag BLOB NOT NULL, ciphertext BLOB NOT NULL); BEGIN EXCLUSIVE; COMMIT');
    } catch (error) { this.db.close(); throw new Error('Storage is locked or unavailable; another engine may own this data directory.', { cause: error }); }
    this.key = key;
  }
  private key!: Buffer;

  static open(directory: string, storageKey?: string): EngineStore {
    const root = resolve(directory);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    const dbPath = join(root, 'shielded.sqlite');
    const keyPath = join(root, '.key');
    let key: Buffer;
    if (storageKey !== undefined) key = keyFor(storageKey);
    else if (existsSync(keyPath)) {
      key = readFileSync(keyPath);
      if (key.length !== 32) throw new Error('Storage key file is invalid; refusing to initialize empty state.');
    } else {
      key = randomBytes(32);
      const fd = openSync(keyPath, 'wx', 0o600);
      try { writeFileSync(fd, key); fsyncSync(fd); } finally { closeSync(fd); }
      chmodSync(keyPath, 0o600);
    }
    return new EngineStore(dbPath, key);
  }

  load<T>(): T | undefined {
    const row = this.db.prepare('SELECT iv, tag, ciphertext FROM checkpoint WHERE id=1').get() as
      { iv: Uint8Array; tag: Uint8Array; ciphertext: Uint8Array } | undefined;
    if (!row) return undefined;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, row.iv);
      decipher.setAuthTag(row.tag);
      return JSON.parse(Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8')) as T;
    } catch { throw new Error('Stored state failed authentication; refusing to reset or overwrite it.'); }
  }

  save(value: unknown): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO checkpoint(id,iv,tag,ciphertext) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET iv=excluded.iv, tag=excluded.tag, ciphertext=excluded.ciphertext')
        .run(iv, cipher.getAuthTag(), ciphertext);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
