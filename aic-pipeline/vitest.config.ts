import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
    globals: false,
    clearMocks: true,
    restoreMocks: true,
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      provider: "v8",
      all: true,
      include: ["src/**/*.{ts,tsx,js}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/**/*.d.ts",
        "src/**/*.tsx", // React components — not unit-tested today
        "src/vendor/**/UPSTREAM.md",
      ],
      reporter: ["text-summary", "text"],
    },
  },
});
