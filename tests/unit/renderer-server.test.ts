import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import { get } from "node:http";
import path from "node:path";
import { expect, it } from "vitest";
import { startRendererServer } from "../../src/infrastructure/electron/renderer-server";

it("serves only packaged assets on loopback, rejecting filesystem paths, writes and foreign hosts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mauxi-renderer-"));
  let server: Awaited<ReturnType<typeof startRendererServer>> | undefined;

  try {
    const directory = path.join(root, "ui"); await mkdir(path.join(directory, "assets"), { recursive: true });
    await writeFile(path.join(root, "secret.txt"), "must stay private");
    await writeFile(path.join(directory, "index.html"), '<script src="./assets/app.js"></script>');
    await writeFile(path.join(directory, "assets/app.js"), "globalThis.fixture = true;");
    server = await startRendererServer(directory);
    const response = await fetch(server.url);
    expect(response.status).toBe(200);
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(await response.text()).toContain("./assets/app.js");
    const asset = new URL("assets/app.js", server.url);
    expect(await (await fetch(asset)).text()).toBe("globalThis.fixture = true;");
    expect(await (await fetch(asset, { method: "HEAD" })).text()).toBe("");
    expect((await fetch(asset, { method: "POST", body: "overwrite" })).status).toBe(405);

    const foreignHost = await new Promise<number | undefined>((resolve, reject) => {
      get(server!.url, { headers: { Host: "attacker.invalid" } }, response => { response.resume(); resolve(response.statusCode); }).on("error", reject);
    });

    expect(foreignHost).toBe(403);

    for (const name of ["../secret.txt", "assets/%2e%2e%2f%2e%2e%2fsecret.txt", "file:///etc/passwd", "unknown.html"]) {
      expect((await fetch(new URL(name.replace(/^file:/, "file%3A"), server.url))).status).toBe(404);
    }

    await server.close(); server = undefined;
    await expect(fetch(asset)).rejects.toThrow();
  } finally { await server?.close(); await rm(root, { recursive: true, force: true }); }
});
