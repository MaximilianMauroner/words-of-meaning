import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@openai/codex-sdk", "better-sqlite3"],
};

export default nextConfig;
