import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import dotenv from "dotenv";
import { describe, expect, it } from "vitest";
import { migrateDatabase } from "./migrate.js";

dotenv.config({ path: "../../.env" });

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for migration tests");
if (new URL(databaseUrl).pathname.replace(/^\//, "") !== "zerocloud_test") {
  throw new Error("Migration tests require the isolated zerocloud_test database");
}

describe("migration runner", () => {
  it("serializes concurrent runners and applies a migration once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zerocloud-migrations-"));
    const filename = `998_parallel_${crypto.randomUUID().replaceAll("-", "")}.sql`;
    const tableName = `migration_probe_${crypto.randomUUID().replaceAll("-", "")}`;
    const sql = `CREATE TABLE ${tableName} (id integer PRIMARY KEY);`;
    await writeFile(join(directory, filename), sql, "utf8");
    const firstPool = new Pool({ connectionString: databaseUrl });
    const secondPool = new Pool({ connectionString: databaseUrl });
    try {
      const results = await Promise.all([
        migrateDatabase(firstPool, directory),
        migrateDatabase(secondPool, directory),
      ]);
      expect(results.flat()).toEqual([filename]);
      expect(results.filter((result) => result.length === 1)).toHaveLength(1);
      const probe = await firstPool.query(`SELECT to_regclass($1) AS name`, [tableName]);
      expect(probe.rows[0]?.name).toBe(tableName);
      await firstPool.query("DELETE FROM schema_migrations WHERE filename = $1", [filename]);
      await firstPool.query(`DROP TABLE ${tableName}`);
    } finally {
      await Promise.all([firstPool.end(), secondPool.end()]);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
