import { expect, test } from "@playwright/test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { launch, text, toolCall } from "../helpers/fake-provider";

const LAB_CSS = path.resolve("fixtures/vite/src/audit-lab/audit-lab.css");
const PLANTED = "width: 600px; /* planted: fixed width */";
const FIXED = "max-width: 600px; flex-wrap: wrap;";

test("the agent fixes an attached audit finding and verifies it with responsive_audit", async ({}, testInfo) => {
  const original = await readFile(LAB_CSS, "utf8");
  expect(original).toContain(PLANTED);
  const state = await mkdtemp(path.join(os.tmpdir(), "mauxi-audit-agent-"));

  const { page, requests, close } = await launch(state, request => [
    toolCall("responsive_audit", JSON.stringify({ route: "/audit-lab.html" })),
    toolCall("workspace_edit", JSON.stringify({ path: "src/audit-lab/audit-lab.css", oldText: PLANTED, newText: FIXED })),
    toolCall("responsive_audit", "{}"),
  ][request - 1] ?? text("The pricing row now wraps, and responsive_audit reports the overflow as resolved."), {}, "/audit-lab.html");

  try {
    // The workspace audited the lab when it opened.
    const panel = page.getByRole("complementary", { name: "Responsive audit" });
    const card = panel.locator('.finding-card:has-text("Horizontal scroll at 320–")').first();
    await expect(card).toBeVisible({ timeout: 90_000 });
    const title = await card.locator(".finding-heading strong").innerText();
    await card.locator(".finding-summary").click();
    await card.getByRole("button", { name: "Fix with agent" }).click();
    await expect(page.getByRole("list", { name: "Attached findings" }).getByRole("listitem")).toHaveText([title]);

    // An empty draft with attached findings sends the default fix-and-verify instruction.
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("log", { name: "Agent response" })).toContainText("reports the overflow as resolved", { timeout: 120_000 });
    await expect.poll(async () => (await page.evaluate(() => window.mauxi!.agentBootstrap())).runState, { timeout: 60_000 }).toBe("idle");

    expect(requests).toHaveLength(4);
    expect(requests[0]).toContain("<audit_findings>");
    expect(requests[0]).toContain("data-testid pricing-table");
    expect(requests[0]).toContain("PricingTable.tsx");
    expect(requests[0]).toContain("responsive_audit");
    expect(requests[1]).toContain('\\"route\\":\\"/audit-lab.html\\"');
    expect(requests[1]).toContain("pricing-table");
    expect(requests[3]).toContain('\\"resolved\\":[{');
    expect(requests[3]).toContain(title);
    expect(await readFile(LAB_CSS, "utf8")).toContain(FIXED);

    // The agent's verification run updates the panel and clears the fixed attachment.
    await expect(panel.getByRole("button", { name: /Resolved since last run/ })).toBeVisible();
    await expect(panel.locator(".resolved-group")).toContainText(title);
    await expect(page.getByRole("list", { name: "Attached findings" })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("agent-fixed-finding.png") });
    await writeFile(testInfo.outputPath("agent-requests.json"), JSON.stringify(requests.map((body) => body.slice(0, 20_000)), null, 2));
  } finally {
    await close();
    await writeFile(LAB_CSS, original);
  }
});
