import { describe, expect, it } from "vitest";
import nextConfig from "../../../next.config";
import { buildContentSecurityPolicy } from "./csp";

describe("web security headers", () => {
  it("includes required static response headers in next.config", async () => {
    const rules = await nextConfig.headers?.();
    const headers = rules?.flatMap((rule) => rule.headers) ?? [];
    const values = new Map(headers.map((header) => [header.key.toLowerCase(), header.value]));
    expect(values.get("referrer-policy")).toBe("no-referrer");
    expect(values.get("x-content-type-options")).toBe("nosniff");
    expect(values.get("x-frame-options")).toBe("DENY");
    expect(values.get("permissions-policy")).toContain("camera=()");
    expect(values.get("cross-origin-opener-policy")).toBe("same-origin");
  });

  it("builds a nonce CSP from configured API, signalling, and ICE hosts", () => {
    const policy = buildContentSecurityPolicy("dGVzdC1ub25jZQ==", {
      apiUrl: "https://signal.example.test/api",
      signalUrl: "wss://signal.example.test/ws",
      iceUrls: "stun:stun.example.test:3478,turn:relay.example.test:80,turns:relay.example.test:443?transport=tcp",
      production: true,
    });
    expect(policy).toContain("script-src 'self' 'nonce-dGVzdC1ub25jZQ==' 'strict-dynamic'");
    expect(policy).not.toContain("'unsafe-inline'");
    expect(policy).toContain("https://signal.example.test");
    expect(policy).toContain("wss://signal.example.test");
    expect(policy).toContain("stun://stun.example.test:3478");
    expect(policy).toContain("turn://relay.example.test:80");
    expect(policy).toContain("turns://relay.example.test:443");
    expect(policy).toContain("frame-ancestors 'none'");
  });
});
