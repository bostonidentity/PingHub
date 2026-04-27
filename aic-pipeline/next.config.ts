import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  devIndicators: false,
  turbopack: {
    root: path.resolve(__dirname),
  },
  serverExternalPackages: ["axios"],
  webpack: (config, { dev }) => {
    if (dev) {
      // 730K+ JSON files in environments/ overwhelm the file watcher.
      // Exclude it from Webpack's watch — API routes read these at runtime.
      config.watchOptions = {
        ...config.watchOptions,
        ignored: [
          ...(Array.isArray(config.watchOptions?.ignored) ? config.watchOptions.ignored : []),
          "**/environments/**",
        ],
      };
    }
    return config;
  },
};

export default nextConfig;
