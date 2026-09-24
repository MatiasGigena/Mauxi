import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/setup-e2e",
  outputDir: "test-results/setup",
  timeout: 45_000,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:44173", trace: "retain-on-failure" },
  webServer: { command: "npx vite --host 127.0.0.1 --port 44173 --strictPort", url: "http://127.0.0.1:44173", reuseExistingServer: true },
});
