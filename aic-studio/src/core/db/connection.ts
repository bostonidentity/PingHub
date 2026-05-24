import Database from "better-sqlite3";
import type { Database as BetterSqliteDatabase } from "better-sqlite3";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema";

export function openDatabase(path: string): BetterSqliteDatabase {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const currentVersion = readVersion(db);
  for (const m of MIGRATIONS) {
    if (m.version > currentVersion) {
      db.exec(m.sql);
    }
  }
  if (currentVersion !== SCHEMA_VERSION) {
    db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?)").run(String(SCHEMA_VERSION));
  }
  return db;
}

function readVersion(db: BetterSqliteDatabase): number {
  try {
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  } catch {
    return 0;
  }
}
