import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(() => ({
  plugins: [
    react(),
    // Mauxi development integration is inserted here.
  ],
  server: { strictPort: true },
  build: { outDir: "dist" },
}));
