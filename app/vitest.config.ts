import { defineConfig } from "vitest/config";

// npm test — every headless TypeScript suite (pure modules + round trips). Fixed time zone for date tests.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    env: { TZ: "America/New_York" },
    reporters: ["default"],
  },
});
