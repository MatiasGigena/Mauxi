import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/turbopack-e2e",
  outputDir: "test-results/turbopack",
  timeout: 90_000,
  workers: 1,
  reporter: [["list"]],
  use: { trace: "retain-on-failure" },
  webServer: [
    {
      command: "cd fixtures/next && npx next dev --turbopack --hostname 127.0.0.1 --port 45001",
      url: "http://127.0.0.1:45001",
      reuseExistingServer: false,
      timeout: 180_000,
    },
    // The audit lab spec runs the workspace renderer in proof mode (?fixture=next-turbopack).
    { command: "npx vite --host 127.0.0.1 --port 44173 --strictPort", url: "http://127.0.0.1:44173", reuseExistingServer: false, timeout: 120_000 },
  ],
});
