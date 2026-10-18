import { expect, test } from "@playwright/test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { launch, text, toolCall } from "../helpers/fake-provider";

test("the agent audits several routes in one batch and unsafe routes are refused", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const state = await mkdtemp(path.join(os.tmpdir(), "mauxi-audit-site-"));

  const { page, requests, close } = await launch(state, request => [
    toolCall("responsive_audit", JSON.stringify({ routes: ["/audit-lab-about.html", "/api/logout"] })),
    toolCall("responsive_audit", JSON.stringify({ routes: ["/audit-lab-about.html", "/audit-lab-blog.html#top"] })),
  ][request - 1] ?? text("The about page is clean; the journal has one reflow bug at 320–576px."), {}, "/audit-lab.html");

  try {
    await page.getByLabel("Message", { exact: true }).fill("Check the about and journal pages for responsive bugs");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("log", { name: "Agent response" })).toContainText("one reflow bug", { timeout: 150_000 });
    await expect.poll(async () => (await page.evaluate(() => window.mauxi!.agentBootstrap())).runState, { timeout: 60_000 }).toBe("idle");

    expect(requests).toHaveLength(3);
    expect(requests[0]).toContain("routes");
    // The unsafe route refuses the whole batch before anything loads.
    expect(requests[1]).toContain("/api/logout cannot be audited (Auth, API, action or credential route)");
    // The second batch runs both pages; the hash is dropped.
    expect(requests[2]).toContain('\\"route\\":\\"/audit-lab-about.html\\",\\"status\\":\\"done\\"');
    expect(requests[2]).toContain('\\"route\\":\\"/audit-lab-blog.html\\",\\"status\\":\\"done\\",\\"summary\\":{\\"bug\\":1,\\"review\\":0,\\"intentional\\":0');

    // The agent's batch opens the All pages summary in the panel.
    const panel = page.getByRole("complementary", { name: "Responsive audit" });
    const rows = panel.getByRole("list", { name: "Audited pages" });
    await expect(rows.locator(".site-page")).toHaveCount(2);
    await expect(rows.locator('[data-route="/audit-lab-blog.html"] [data-kind=bug]')).toHaveText("1 bug");
    await expect(rows.locator('[data-route="/audit-lab-about.html"] [data-kind=bug]')).toHaveText("0 bugs");
    await page.screenshot({ path: testInfo.outputPath("agent-site-audit.png") });
    await writeFile(testInfo.outputPath("agent-site-requests.json"), JSON.stringify(requests.slice(1).map((body) => body.slice(-6_000)), null, 2));
  } finally { await close(); }
});
