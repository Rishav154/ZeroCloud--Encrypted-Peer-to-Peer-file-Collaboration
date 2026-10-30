import type { NextConfig } from "next";
import dotenv from "dotenv";

dotenv.config({ path: "../../.env" });

const nextConfig: NextConfig = {
  transpilePackages: ["@zerocloud/shared"],
  experimental: { useTypeScriptCli: false },
};

export default nextConfig;
