import { defineConfig } from "vitest/config";

/**
 * Test discovery at the repo root, independent of the renderer Vite
 * root in `vite.config.ts`: pipeline tests (.sandcastle, docs) and
 * product tests (src/**, including the renderer's tsx tests) run in a
 * plain node environment.
 */
export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", ".sandcastle/**/*.test.ts", "docs/**/*.test.ts"],
  },
});
