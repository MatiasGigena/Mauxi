import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const REDIRECTS = new Map([["/audit-lab-account.html", "/audit-lab-profile.html"], ["/audit-lab-profile.html", "/api/logout"]]);

/**
 * Site audit fixture: /audit-lab-account.html redirects through an allowed page to the sign-out endpoint, which audits
 * must never request. /audit-lab-signouts.json reports how often it was hit.
 */
function signOutTrap(): Plugin {
  let signOuts = 0;

  return {
    name: "audit-lab-sign-out-trap",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? "").split("?")[0];
        const redirect = REDIRECTS.get(path);

        if (redirect) {
          response.writeHead(302, { Location: redirect }).end();

          return;
        }

        if (path === "/api/logout") {
          signOuts++;
          response.writeHead(204).end();

          return;
        }

        if (path === "/audit-lab-signouts.json") response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ signOuts }));
        else next();
      });
    },
  };
}

export default defineConfig(() => ({
  plugins: [
    react(),
    signOutTrap(),
    // Mauxi development integration is inserted here.
  ],
  server: { strictPort: true },
  build: { outDir: "dist" },
}));
