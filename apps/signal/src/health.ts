import type { RequestHandler } from "express";
import type { DatabaseHealth } from "./db/readiness.js";

export type HealthConfig = {
  BUILD_SHA: string;
  BUILD_TIME: string;
};

export function createHealthHandler(
  database: Pick<DatabaseHealth, "status">,
  config: HealthConfig,
  startedAt: number,
  now: () => number = Date.now,
  nearbyCounts: () => { sockets: number; enabled: number; groups: number } = () => ({ sockets: 0, enabled: 0, groups: 0 }),
): RequestHandler {
  return async (_request, response) => {
    const db = await database.status();
    const statusCode = db === "down" ? 503 : 200;
    response.setHeader("Cache-Control", "no-store");
    response.status(statusCode).json({
      status: db === "up" ? "ok" : db,
      uptime: Math.floor((now() - startedAt) / 1000),
      db,
      build: { sha: config.BUILD_SHA, time: config.BUILD_TIME },
      nearby: nearbyCounts(),
    });
  };
}
