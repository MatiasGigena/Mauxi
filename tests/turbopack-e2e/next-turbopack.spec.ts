import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

let application: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  application = await electron.launch({
    args: [path.resolve("dist-electron/main.js")],
    env: { ...process.env, MAUXI_PROOF: "1" },
  });
  page = await application.firstWindow();
  await page.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => { await application?.close(); });

test("Next.js Turbopack loads the Mauxi bridge without changing next.config", async () => {
  expect(await readFile(path.resolve("fixtures/next/next.config.mjs"), "utf8")).not.toContain("mauxi-owned");

  const message = await page.evaluate(async () => {
    const session = crypto.randomUUID();

    const ready = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for the Turbopack bridge")), 30_000);
      window.addEventListener("message", (event) => {
        if (event.origin !== "http://127.0.0.1:45001") return;
        const value = event.data as Record<string, unknown>;

        if (value.protocol !== "mauxi-preview-v1" || value.kind !== "ready" || value.session !== session) return;
        clearTimeout(timeout);
        resolve(value);
      });
    });

    const url = new URL("http://127.0.0.1:45001");
    url.searchParams.set("mauxiSession", session);
    url.searchParams.set("mauxiPreview", "desktop");
    url.searchParams.set("mauxiParent", "null");
    const frame = document.createElement("iframe");
    frame.src = url.toString();
    document.body.append(frame);

    return ready;
  });

  expect(message.reactGrab).toBe(true);
  expect(message.url).toContain("mauxiPreview=desktop");
});
