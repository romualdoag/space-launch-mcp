import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 150_000,
    hookTimeout: 30_000,
    // Frio persistente nunca toca disco em teste — :memory: por worker.
    env: { SPACE_LAUNCH_CACHE_PATH: ":memory:" },
  },
});
