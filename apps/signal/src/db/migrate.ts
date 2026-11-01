import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const migrationDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

export const MIGRATION_ADVISORY_LOCK = [73_072_026, 8] as const;

export async function migrateDatabase(
  pool: Pick<Pool, "connect">,
  directory = migrationDirectory,
): Promise<string[]> {
  const client = await pool.connect();
  const appliedNow: string[] = [];
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock($1, $2)", [...MIGRATION_ADVISORY_LOCK]);
    locked = true;
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const files = (await readdir(directory))
      .filter((file) => /^\d+_[a-z0-9_-]+\.sql$/i.test(file))
      .sort();
    for (const filename of files) {
      const exists = await client.query(
        "SELECT 1 FROM schema_migrations WHERE filename = $1",
        [filename],
      );
      if (exists.rowCount) continue;

      const sql = await readFile(join(directory, filename), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [filename],
        );
        await client.query("COMMIT");
        appliedNow.push(filename);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return appliedNow;
  } finally {
    try {
      if (locked) {
        await client.query("SELECT pg_advisory_unlock($1, $2)", [...MIGRATION_ADVISORY_LOCK]);
      }
    } finally {
      client.release();
    }
  }
}
