import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/package-e2e",
  outputDir: "test-results/package",
  timeout: 180_000,
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: { trace: "retain-on-failure" },
});
