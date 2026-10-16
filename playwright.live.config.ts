import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/live-acceptance",
  outputDir: "test-results/live",
  timeout: 4 * 60 * 60_000,
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: { trace: "off" },
});
