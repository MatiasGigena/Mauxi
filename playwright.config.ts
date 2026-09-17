import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { trace: "retain-on-failure" },
  webServer: [
    { command: "npm run dev -w @mauxi-fixture/vite", url: "http://127.0.0.1:45173", reuseExistingServer: false, timeout: 120_000 },
    { command: "npm run dev -w @mauxi-fixture/next", url: "http://127.0.0.1:45000", reuseExistingServer: false, timeout: 180_000 },
    { command: "npx vite --host 127.0.0.1 --port 44173 --strictPort", url: "http://127.0.0.1:44173", reuseExistingServer: false, timeout: 120_000 },
  ],
});
