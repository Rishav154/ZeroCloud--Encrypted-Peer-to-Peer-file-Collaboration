import { describe, expect, it } from "vitest";
import { ConnectionLimits } from "./connectionLimits.js";

describe("WebSocket connection limits", () => {
  it("caps active sockets per IP and releases the count on close", () => {
    const limits = new ConnectionLimits(2, 10);
    expect(limits.acquireIp("203.0.113.4")).toBe(true);
    expect(limits.acquireIp("203.0.113.4")).toBe(true);
    expect(limits.acquireIp("203.0.113.4")).toBe(false);
    limits.releaseIp("203.0.113.4");
    expect(limits.acquireIp("203.0.113.4")).toBe(true);
  });

  it("caps authenticated sockets per user and releases the count on close", () => {
    const limits = new ConnectionLimits(20, 2);
    expect(limits.acquireUser("user-1")).toBe(true);
    expect(limits.acquireUser("user-1")).toBe(true);
    expect(limits.acquireUser("user-1")).toBe(false);
    limits.releaseUser("user-1");
    expect(limits.acquireUser("user-1")).toBe(true);
  });
});
