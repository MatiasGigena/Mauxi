import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { build } from "esbuild";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { RouteDiscovery } from "../../src/application/audit-contract";
import type { DiscoveryRequest } from "../../src/infrastructure/audit/route-discovery";

declare global { var auditDiscovery: (request: DiscoveryRequest) => Promise<RouteDiscovery>; }

test("plain page links remain discoverable when the same route also has a download link", async ({}, testInfo) => {
  const requests: string[] = [];

  const server = createServer((request, response) => {
    const route = request.url ?? "/";
    requests.push(route);
    response.setHeader("Content-Type", "text/html");

    if (route === "/download-first") response.end('<a download href="/guide.html">Save guide</a><a href="/guide.html">Read guide</a><a download href="/offline.html">Offline only</a>');
    else if (route === "/plain-first") response.end('<a href="/guide.html">Read guide</a><a download href="/guide.html">Save guide</a><a download href="/offline.html">Offline only</a>');
    else if (route === "/guide.html") response.end('<h1>Guide</h1><a href="/chapter.html">Chapter</a>');
    else response.end("<h1>Chapter</h1>");
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = Value.Parse(Type.Object({ port: Type.Integer() }), server.address());
  const origin = `http://127.0.0.1:${address.port}`;
  const entry = testInfo.outputPath("discovery.mjs");
  let application: ElectronApplication | undefined;

  try {
    await build({ stdin: { contents: `
      import { app, BrowserWindow } from "electron";
      import { discoverRoutes } from "./src/infrastructure/audit/route-discovery";
      import { confine } from "./src/infrastructure/audit/navigation-fence";
      globalThis.auditDiscovery = async request => {
        const window = new BrowserWindow({ show: false, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false } });
        try { return await discoverRoutes(window, request, new AbortController().signal, confine(window, request.origin, request.url)); }
        finally { window.destroy(); }
      };
      app.on("window-all-closed", () => {});
    `, resolveDir: process.cwd() }, bundle: true, platform: "node", format: "esm", external: ["electron"], outfile: entry });
    application = await electron.launch({ args: [entry], env: { ...process.env, XDG_CONFIG_HOME: testInfo.outputPath("profile") } });
    const results: RouteDiscovery[] = [];

    for (const route of ["/download-first", "/plain-first"]) {
      results.push(await application.evaluate((_electron, request) => globalThis.auditDiscovery(request), { url: origin + route, route, origin, depth: 2 }));
    }

    await writeFile(testInfo.outputPath("discovery.json"), JSON.stringify({ requests, results }, null, 2));

    for (const [index, result] of results.entries()) {
      expect(result.routes.map((item) => item.route)).toEqual([index ? "/plain-first" : "/download-first", "/guide.html", "/chapter.html"]);
      expect(result.excluded).toEqual([{ route: "/offline.html", reason: "Download link" }]);
    }

    expect(requests).not.toContain("/offline.html");
  } finally {
    await application?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
