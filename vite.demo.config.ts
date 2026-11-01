import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The Stageshow product demo of the Mauxi main view (demo/), served apart from the app.
export default defineConfig({
  root: "demo",
  base: "./",
  plugins: [react()],
  server: { host: "127.0.0.1", port: 44180, strictPort: true },
  build: { outDir: "../dist/demo", emptyOutDir: true },
});
