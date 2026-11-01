import { describe, expect, it, vi } from "vitest";
import { DatabaseHealth, waitForDatabase } from "./readiness.js";

describe("database readiness", () => {
  it("retries transient startup failures with backoff until the database wakes", async () => {
    let attempts = 0;
    await waitForDatabase(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("database is waking");
      },
      { wait: async () => undefined },
    );
    expect(attempts).toBe(3);
  });

  it("reports waking for a slow database probe and down after the wake window", async () => {
    vi.useFakeTimers();
    let resolveQuery: (() => void) | undefined;
    const health = new DatabaseHealth(
      () => new Promise<void>((resolve) => { resolveQuery = resolve; }),
      15_000,
      2500,
      () => Date.now(),
    );
    const first = health.status();
    await vi.advanceTimersByTimeAsync(2500);
    await expect(first).resolves.toBe("waking");
    resolveQuery?.();
    await Promise.resolve();
    await expect(health.status()).resolves.toBe("up");

    const failing = new DatabaseHealth(
      async () => { throw new Error("still unavailable"); },
      15_000,
      2500,
    );
    await expect(failing.status()).resolves.toBe("waking");
    vi.advanceTimersByTime(15_001);
    await expect(failing.status()).resolves.toBe("down");
    vi.useRealTimers();
  });
});
