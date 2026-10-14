import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/resource-e2e", timeout: 90_000, workers: 1, fullyParallel: false,
  outputDir: "test-results/resources", reporter: [["list"]],
  use: { trace: "retain-on-failure" },
  webServer: { command: "npx vite --host 127.0.0.1 --port 44173 --strictPort", url: "http://127.0.0.1:44173", reuseExistingServer: true, timeout: 120_000 },
});
