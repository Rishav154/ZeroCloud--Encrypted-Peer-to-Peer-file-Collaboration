import { describe, expect, it } from "vitest";
import { parseEnvironment } from "./environment.js";

const validProduction = {
  NODE_ENV: "production",
  PORT: "4000",
  DATABASE_URL: "postgresql://app:password@pool.example.test/app",
  DIRECT_DATABASE_URL: "postgresql://app:password@db.example.test/app",
  DATABASE_SSL: "true",
  ALLOWED_ORIGIN: "https://app.example.test",
  WEB_ORIGIN: "https://app.example.test",
  JWT_SECRET: "production-test-secret-that-is-long-enough-123",
  NEARBY_SECRET: "nearby-production-test-secret-is-long-enough-123",
};

describe("production environment validation", () => {
  it("accepts a complete secure production configuration", () => {
    expect(parseEnvironment(validProduction).NODE_ENV).toBe("production");
  });

  it.each([
    ["short JWT secret", { JWT_SECRET: "short" }, "JWT_SECRET"],
    ["example JWT placeholder", { JWT_SECRET: "replace-this-with-a-random-secret-at-least-32-chars" }, "placeholder"],
    ["HTTP allowed origin", { ALLOWED_ORIGIN: "http://example.test" }, "HTTPS"],
    ["HTTP web origin", { WEB_ORIGIN: "http://example.test" }, "HTTPS"],
    ["missing application URL", { DATABASE_URL: undefined }, "DATABASE_URL"],
  ])("rejects %s", (_label, override, expected) => {
    const values = { ...validProduction, ...override };
    try {
      parseEnvironment(values);
      throw new Error("Expected production config validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(expected);
    }
  });

  it("allows localhost HTTP origins in development", () => {
    const local = parseEnvironment({
      ...validProduction,
      NODE_ENV: "development",
      ALLOWED_ORIGIN: "http://localhost:3000",
      WEB_ORIGIN: "http://localhost:3000",
    });
    expect(local.ALLOWED_ORIGIN).toBe("http://localhost:3000");
  });
});
