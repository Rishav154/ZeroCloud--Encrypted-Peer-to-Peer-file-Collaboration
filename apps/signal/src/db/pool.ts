import { Pool, type PoolConfig } from "pg";
import type { AppConfig } from "../config.js";

export function createDatabasePool(
  connectionString: string,
  config: Pick<AppConfig, "DATABASE_SSL" | "DB_POOL_MAX" | "DB_IDLE_TIMEOUT_MS" | "DB_CONNECTION_TIMEOUT_MS">,
): Pool {
  const connectionOptions: PoolConfig = {
    connectionString: removeSslModeParameter(connectionString),
    max: config.DB_POOL_MAX,
    idleTimeoutMillis: config.DB_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: config.DB_CONNECTION_TIMEOUT_MS,
    ...(config.DATABASE_SSL === "true"
      ? { ssl: { rejectUnauthorized: true } }
      : {}),
  };
  return new Pool(connectionOptions);
}

function removeSslModeParameter(connectionString: string): string {
  const parsed = new URL(connectionString);
  parsed.searchParams.delete("sslmode");
  return parsed.toString();
}
