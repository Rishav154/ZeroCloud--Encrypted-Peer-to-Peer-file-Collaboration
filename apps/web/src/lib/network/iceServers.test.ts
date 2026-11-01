import { describe, expect, it, vi } from "vitest";
import { IceServerCache } from "./iceServers";

describe("ICE credential cache", () => {
  it("fetches authenticated server-issued credentials and refreshes near expiry", async () => {
    let now = 1000;
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        iceServers: [{ urls: "turn:relay.example.test", username: "first", credential: "short-lived-1" }],
        ttlSeconds: 120,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        iceServers: [{ urls: "turn:relay.example.test", username: "second", credential: "short-lived-2" }],
        ttlSeconds: 120,
      }), { status: 200 }));
    const cache = new IceServerCache(fetcher, () => now);
    const first = await cache.get("test-token");
    expect(first.iceServers[0]?.username).toBe("first");
    expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual({ authorization: "Bearer test-token" });
    now += 91_000;
    const second = await cache.get("test-token");
    expect(second.iceServers[0]?.username).toBe("second");
    expect(fetcher).toHaveBeenCalledTimes(2);
    cache.clear();
  });
});
