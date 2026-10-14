import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";

const LoopbackAddress = Type.Object({ port: Type.Integer() });

export async function startRendererServer(directory: string) {
  const assets = new Map<string, { body: Buffer; type: string }>();
  const types = new Map([[".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"], [".css", "text/css; charset=utf-8"], [".png", "image/png"], [".svg", "image/svg+xml"], [".woff2", "font/woff2"]]);

  async function collect(relative = "") {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      const type = types.get(path.extname(name));

      if (entry.isDirectory()) await collect(name);
      else if (entry.isFile() && type) assets.set(name, { body: await readFile(path.join(directory, name)), type });
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

    if (request.headers.host !== host) { response.writeHead(403); response.end();

    return; }

    if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405); response.end();

    return; }

    let asset: { body: Buffer; type: string } | undefined;

    try {
      const url = new URL(request.url!, `http://${host}`);

      if (url.host === host && url.pathname.startsWith(prefix)) asset = assets.get(url.pathname.slice(prefix.length));
    } catch {}

    if (!asset) { response.writeHead(404); response.end();

    return; }

    response.writeHead(200, { "Content-Type": asset.type, "Content-Length": asset.body.length });
    response.end(request.method === "HEAD" ? undefined : asset.body);
  });

  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();

  if (!Value.Check(LoopbackAddress, address)) { server.close(); throw new Error("Renderer loopback address unavailable"); }

  host = `127.0.0.1:${address.port}`;
  server.unref();

  return {
    url: `http://${host}${prefix}index.html`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}
