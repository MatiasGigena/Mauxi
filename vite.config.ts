/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  server: { strictPort: true },
  build: { outDir: "dist/renderer" },
  // Checkpoint and fake-provider tests spawn Python helpers and real file I/O; alone they take 4-8 s, so the 5 s default flakes on a loaded host.
  test: { testTimeout: 20_000, hookTimeout: 20_000 },
});
