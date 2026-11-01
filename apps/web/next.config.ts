import type { NextConfig } from "next";
import dotenv from "dotenv";

dotenv.config({ path: "../../.env" });

const nextConfig: NextConfig = {
  transpilePackages: ["@zerocloud/shared"],
  experimental: { useTypeScriptCli: false },
  env: {
    NEXT_PUBLIC_BUILD_SHA:
      process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.BUILD_SHA ?? "local",
    NEXT_PUBLIC_BUILD_TIME: process.env.BUILD_TIME ?? new Date().toISOString(),
  },
  async headers() {
    const securityHeaders = [
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()" },
      { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
      ...(process.env.NODE_ENV === "production"
        ? [{ key: "Strict-Transport-Security", value: "max-age=31536000" }]
        : []),
    ];
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
