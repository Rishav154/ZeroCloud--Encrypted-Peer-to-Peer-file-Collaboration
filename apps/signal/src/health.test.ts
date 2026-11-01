import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createHealthHandler } from "./health.js";

describe("health endpoint", () => {
  it("reports a slow database as waking with HTTP 200", async () => {
    const app = express();
    app.get("/health", createHealthHandler(
      { status: async () => "waking" },
      { BUILD_SHA: "abc123", BUILD_TIME: "2026-11-01T00:00:00.000Z" },
      1000,
      () => 5000,
    ));
    const response = await request(app).get("/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "waking",
      uptime: 4,
      db: "waking",
      build: { sha: "abc123", time: "2026-11-01T00:00:00.000Z" },
    });
  });

  it("reports a down database with HTTP 503", async () => {
    const app = express();
    app.get("/health", createHealthHandler(
      { status: async () => "down" },
      { BUILD_SHA: "abc123", BUILD_TIME: "now" },
      Date.now(),
    ));
    const response = await request(app).get("/health");
    expect(response.status).toBe(503);
    expect(response.body.db).toBe("down");
  });
});
