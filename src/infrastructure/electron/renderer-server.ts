import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

/** Serve only packaged UI bytes on an ephemeral loopback origin. Using the
 * preview's scheme/site permits ordinary SameSite cookies while distinct ports
 * retain the same-origin boundary. This server has no filesystem or IPC API. */
export async function startRendererServer(directory: string) {
  const assets = new Map<string, { body: Buffer; type: string }>();
  const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
  async function collect(relative = "") {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await collect(name);
      else if (entry.isFile() && types[path.extname(name)]) assets.set(name, { body: await readFile(path.join(directory, name)), type: types[path.extname(name)] });
    }
  }
  await collect();
  if (!assets.has("index.html")) throw new Error("Packaged renderer is missing index.html");
  const prefix = `/${randomUUID()}/`;
  let host = "";
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    if (request.headers.host !== host) { response.writeHead(403); response.end(); return; }
    if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405); response.end(); return; }
    let asset: { body: Buffer; type: string } | undefined;
    try {
      const url = new URL(request.url!, `http://${host}`);
      if (url.host === host && url.pathname.startsWith(prefix)) asset = assets.get(url.pathname.slice(prefix.length));
    } catch { /* malformed or unknown names cannot reach the filesystem */ }
    if (!asset) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "Content-Type": asset.type, "Content-Length": asset.body.length });
    response.end(request.method === "HEAD" ? undefined : asset.body);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw new Error("Renderer loopback address unavailable"); }
  host = `127.0.0.1:${address.port}`;
  server.unref();
  return {
    url: `http://${host}${prefix}index.html`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}
