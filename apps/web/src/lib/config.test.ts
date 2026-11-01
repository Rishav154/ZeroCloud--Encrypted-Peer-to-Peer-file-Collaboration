import { describe, expect, it } from "vitest";
import { validateProductionSignalUrl } from "../../scripts/check-production-config.mjs";

describe("production web build configuration", () => {
  it("accepts secure WebSocket endpoints in production", () => {
    expect(() => validateProductionSignalUrl({
      VERCEL_ENV: "production",
      NEXT_PUBLIC_SIGNAL_URL: "wss://signal.example.test/ws",
    })).not.toThrow();
  });

  it.each([undefined, "ws://signal.example.test/ws", "https://signal.example.test/ws"])(
    "rejects a missing or insecure production signalling URL (%s)",
    (signalUrl) => {
      expect(() => validateProductionSignalUrl({
        DEPLOY_ENV: "production",
        NEXT_PUBLIC_SIGNAL_URL: signalUrl,
      })).toThrow(/NEXT_PUBLIC_SIGNAL_URL/);
    },
  );

  it("allows localhost WebSocket URLs outside production", () => {
    expect(() => validateProductionSignalUrl({
      NODE_ENV: "development",
      NEXT_PUBLIC_SIGNAL_URL: "ws://localhost:4000/ws",
    })).not.toThrow();
  });
});
