import { describe, expect, it, vi } from "vitest";
import { IceServerService, type IceConfig } from "./iceServers.js";

const providerConfig: IceConfig = {
  ICE_MODE: "provider",
  STUN_URLS: "stun:stun.example.test:3478, stun:stun2.example.test:3478",
  TURN_APP_NAME: "demo",
  TURN_PROVIDER_SECRET: "provider-secret-for-test-only",
  TURN_CREDENTIAL_TTL_SECONDS: 3600,
};

describe("ICE server service", () => {
  it("issues and caches provider credentials without returning the provider secret", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        username: "short-lived-user",
        password: "short-lived-pass",
        expiryInSeconds: 3600,
        apiKey: "credential-api-key",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { urls: "stun:provider.test:80" },
        { urls: ["turn:provider.test:80", "turns:provider.test:443" ] },
      ]), { status: 200 }));
    const service = new IceServerService(providerConfig, fetcher, () => 1000);

    const first = await service.get();
    const second = await service.get();
    expect(first).toEqual(second);
    expect(first.ttlSeconds).toBe(3600);
    expect(first.iceServers).toEqual([
      { urls: "stun:stun.example.test:3478" },
      { urls: "stun:stun2.example.test:3478" },
      {
        urls: ["turn:provider.test:80", "turns:provider.test:443"],
        username: "short-lived-user",
        credential: "short-lived-pass",
      },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const createUrl = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(createUrl.searchParams.get("secretKey")).toBe("provider-secret-for-test-only");
    expect(first).not.toHaveProperty("secretKey");
  });

  it("serves static server-side credentials when ICE_MODE=static", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const service = new IceServerService({
      ICE_MODE: "static",
      STUN_URLS: "stun:stun.local:3478",
      TURN_CREDENTIAL_TTL_SECONDS: 900,
      ICE_STATIC_URLS: "turn:static.local:80,turn:static.local:443?transport=tcp",
      ICE_STATIC_USERNAME: "static-user",
      ICE_STATIC_CREDENTIAL: "static-password",
    }, fetcher);
    await expect(service.get()).resolves.toEqual({
      iceServers: [
        { urls: "stun:stun.local:3478" },
        {
          urls: ["turn:static.local:80", "turn:static.local:443?transport=tcp"],
          username: "static-user",
          credential: "static-password",
        },
      ],
      ttlSeconds: 900,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
