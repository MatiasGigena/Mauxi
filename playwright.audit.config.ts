import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/audit-e2e", timeout: 180_000, workers: 1, fullyParallel: false,
  outputDir: "test-results/audit", reporter: [["list"]],
  use: { trace: "retain-on-failure" },
  webServer: [
    { command: "npm run dev -w @mauxi-fixture/vite", url: "http://127.0.0.1:45173", reuseExistingServer: true, timeout: 120_000 },
    { command: "npx vite --host 127.0.0.1 --port 44173 --strictPort", url: "http://127.0.0.1:44173", reuseExistingServer: true, timeout: 120_000 },
  ],
});
