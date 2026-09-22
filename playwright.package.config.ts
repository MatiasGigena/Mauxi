import { defineConfig } from "@playwright/test";

// No renderer dev server: exercise the actual AppImage and its bundled SDK.
export default defineConfig({
  testDir: "tests/package-e2e",
  outputDir: "test-results/package",
  timeout: 180_000,
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: { trace: "retain-on-failure" },
});
