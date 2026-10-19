import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/production-e2e",
  outputDir: "test-results/production",
  timeout: 30_000,
  workers: 1,
  reporter: [["list"]],
  use: { trace: "retain-on-failure", launchOptions: { executablePath: process.env.MAUXI_CHROMIUM_PATH || undefined } },
  webServer: [
    { command: "node node_modules/vite/bin/vite.js preview fixtures/vite --host 127.0.0.1 --port 45273 --strictPort", url: "http://127.0.0.1:45273", reuseExistingServer: false },
    { command: "node node_modules/next/dist/bin/next start fixtures/next --hostname 127.0.0.1 --port 45274", url: "http://127.0.0.1:45274", reuseExistingServer: false },
  ],
});
