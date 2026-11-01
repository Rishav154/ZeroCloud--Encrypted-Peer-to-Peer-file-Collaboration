import { config } from "../config.js";
import { createDatabasePool } from "./pool.js";
import { migrateDatabase } from "./migrate.js";

const pool = createDatabasePool(config.DIRECT_DATABASE_URL, { ...config, DB_POOL_MAX: 1 });
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
