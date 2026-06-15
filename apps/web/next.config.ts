import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@answer-generator/db", "@answer-generator/shared"],
  experimental: {
    externalDir: true
  }
};

export default nextConfig;
