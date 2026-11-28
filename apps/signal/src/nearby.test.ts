import { describe, expect, it } from "vitest";
import { deriveClientIp, nearbyGroupKey, normalizeClientIp } from "./nearby.js";

describe("nearby network grouping", () => {
  it("normalizes IPv4, mapped IPv4, and IPv6 /64", () => {
    expect(normalizeClientIp("192.0.2.1")).toBe("192.0.2.1");
    expect(normalizeClientIp("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(normalizeClientIp("127.0.0.1")).toBe("loopback");
    expect(normalizeClientIp("127.0.0.2")).toBe("loopback");
    expect(normalizeClientIp("::1")).toBe("loopback");
    expect(normalizeClientIp("::ffff:127.0.0.1")).toBe("loopback");
    expect(nearbyGroupKey("a-secret-that-is-long-enough", "127.0.0.1")).toBe(nearbyGroupKey("a-secret-that-is-long-enough", "::1"));
    expect(normalizeClientIp("2001:db8:abcd:12::1")).toBe(normalizeClientIp("2001:db8:abcd:12::ffff"));
    expect(nearbyGroupKey("a-secret-that-is-long-enough", "2001:db8:abcd:12::1")).not.toBe(nearbyGroupKey("a-secret-that-is-long-enough", "2001:db8:abcd:13::1"));
    expect(nearbyGroupKey("another-secret-long-enough", "192.0.2.1")).not.toBe(nearbyGroupKey("a-secret-that-is-long-enough", "192.0.2.1"));
  });
  it("selects trusted XFF entries from the right", () => {
    expect(deriveClientIp("spoof,client,proxy", "socket", 0)).toBe("socket");
    expect(deriveClientIp("spoof,client,proxy", "socket", 1)).toBe("proxy");
    expect(deriveClientIp("spoof,client,proxy", "socket", 2)).toBe("client");
    expect(deriveClientIp(undefined, "socket", 1)).toBe("socket");
  });
});
