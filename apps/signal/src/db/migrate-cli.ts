import { Pool } from "pg";
import { config } from "../config.js";
import { migrateDatabase } from "./migrate.js";

const pool = new Pool({ connectionString: config.DATABASE_URL });
try {
  const applied = await migrateDatabase(pool);
  console.info(
    applied.length
      ? `Applied migrations: ${applied.join(", ")}`
      : "Database is already up to date",
  );
} catch (error) {
  console.error(
    `Database migration failed: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
