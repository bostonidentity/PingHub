import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  devIndicators: false,
  output: "standalone",
  outputFileTracingIncludes: {
    "**/*": ["./src/vendor/**/*"]
  },
  turbopack: {
    root: path.resolve(__dirname),
  },
  serverExternalPackages: ["axios", "better-sqlite3"],
};

export default nextConfig;
