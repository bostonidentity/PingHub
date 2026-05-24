export const SCHEMA_VERSION = 4;

export const MIGRATIONS: readonly { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS environments (
        name TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        tenant_url TEXT NOT NULL,
        username TEXT NOT NULL,
        client_id TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT 'slate',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS op_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        env_name TEXT NOT NULL,
        op_kind TEXT NOT NULL,
        scope TEXT,
        status TEXT NOT NULL,
        message TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        snapshot_dir TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_op_history_env ON op_history(env_name, started_at DESC);
    `
  },
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS promotion_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        source_env TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS promotion_task_items (
        task_id INTEGER NOT NULL,
        realm TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        PRIMARY KEY (task_id, realm, resource_type, resource_id),
        FOREIGN KEY (task_id) REFERENCES promotion_tasks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_promotion_tasks_status ON promotion_tasks(status, updated_at DESC);
    `
  },
  {
    version: 4,
    sql: `
      ALTER TABLE op_history ADD COLUMN target_env TEXT;
    `
  }
] as const;
