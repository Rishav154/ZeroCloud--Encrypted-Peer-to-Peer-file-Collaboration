import type { Pool } from "pg";

export type DatabaseState = "up" | "waking" | "down";

export async function waitForDatabase(
  attempt: () => Promise<unknown>,
  options: { timeoutMs?: number; wait?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const wait = options.wait ?? delay;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  let backoffMs = 250;
  while (Date.now() < deadline) {
    try {
      await attempt();
      return;
    } catch (error) {
      lastError = error;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await wait(Math.min(backoffMs, remainingMs));
    backoffMs = Math.min(backoffMs * 2, 2000);
  }
  throw new Error("Database did not become ready within 15 seconds", {
    cause: lastError,
  });
}

export async function waitForPool(pool: Pick<Pool, "query">): Promise<void> {
  await waitForDatabase(() => pool.query("SELECT 1"));
}

export class DatabaseHealth {
  private pending: Promise<DatabaseState> | null = null;
  private failedAt: number | null = null;
  private lastState: DatabaseState = "up";

  constructor(
    private readonly query: () => Promise<unknown>,
    private readonly downAfterMs = 15_000,
    private readonly responseTimeoutMs = 2500,
    private readonly now: () => number = Date.now,
  ) {}

  async status(): Promise<DatabaseState> {
    const probe = this.pending ?? this.startProbe();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timed = new Promise<DatabaseState>((resolve) => {
      timeout = setTimeout(() => resolve(this.pendingState()), this.responseTimeoutMs);
    });
    const state = await Promise.race([probe, timed]);
    if (timeout) clearTimeout(timeout);
    return state;
  }

  private startProbe(): Promise<DatabaseState> {
    const probe = this.query()
      .then(() => {
        this.failedAt = null;
        this.lastState = "up";
        return this.lastState;
      })
      .catch(() => {
        this.failedAt ??= this.now();
        this.lastState = this.pendingState();
        return this.lastState;
      })
      .finally(() => {
        if (this.pending === probe) this.pending = null;
      });
    this.pending = probe;
    return probe;
  }

  private pendingState(): DatabaseState {
    if (this.failedAt === null) {
      this.failedAt = this.now();
      this.lastState = "waking";
    }
    return this.now() - this.failedAt < this.downAfterMs ? "waking" : "down";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
