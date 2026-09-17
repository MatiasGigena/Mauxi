import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/turbopack-e2e",
  timeout: 90_000,
  workers: 1,
  reporter: [["list"]],
  webServer: {
    command: "cd fixtures/next && npx next dev --turbopack --hostname 127.0.0.1 --port 45001",
    url: "http://127.0.0.1:45001",
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
