import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/lifecycle-e2e",
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { trace: "retain-on-failure" },
  webServer: [
    { command: "npx vite --host 127.0.0.1 --port 44173 --strictPort", url: "http://127.0.0.1:44173", reuseExistingServer: false, timeout: 120_000 },
  ],
});
