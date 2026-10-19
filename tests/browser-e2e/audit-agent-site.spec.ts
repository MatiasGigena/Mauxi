import { expect, test } from "@playwright/test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { launch, text, toolCall } from "../helpers/fake-provider";

const SignOutCounter = Type.Object({ signOuts: Type.Integer() });
const ToolMessages = Type.Object({ messages: Type.Array(Type.Object({ role: Type.String(), content: Type.Unknown() })) });

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

test("the agent cannot audit an excluded route, even when the user audited it last", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const state = await mkdtemp(path.join(os.tmpdir(), "mauxi-audit-excluded-"));

  const { page, requests, close } = await launch(state, request => [
    toolCall("responsive_audit", "{}"),
    toolCall("responsive_audit", JSON.stringify({ route: "/api/logout" })),
  ][request - 1] ?? text("Both audits were refused as excluded routes."), {}, "/audit-lab.html");

  try {
    const active = (await page.evaluate(() => window.mauxi!.getBootstrap())).active!;
    const signOuts = async () => Value.Parse(SignOutCounter, await (await fetch(new URL("/audit-lab-signouts.json", active.origin))).json()).signOuts;
    const before = await signOuts();

    // The user may audit an excluded route from the panel; it becomes the default route of the agent's next audit.
    const login = await page.evaluate(workspaceId => window.mauxi!.auditRun({ workspaceId, route: "/login" }), active.workspaceId);
    expect(login.route).toBe("/login");

    await page.getByLabel("Message", { exact: true }).fill("Re-run the audit, then audit the sign-out endpoint");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("log", { name: "Agent response" })).toContainText("Both audits were refused", { timeout: 150_000 });
    await expect.poll(async () => (await page.evaluate(() => window.mauxi!.agentBootstrap())).runState, { timeout: 60_000 }).toBe("idle");

    expect(requests).toHaveLength(3);
    expect(requests[1]).toContain("/login cannot be audited (Auth, API, action or credential route)");
    expect(requests[2]).toContain("/api/logout cannot be audited (Auth, API, action or credential route)");
    const after = await signOuts();
    await writeFile(testInfo.outputPath("agent-excluded-routes.json"), JSON.stringify({ userAudit: login.route, toolResults: requests.slice(1).map((body) => JSON.stringify(Value.Parse(ToolMessages, JSON.parse(body)).messages.filter((message) => message.role === "tool").at(-1)?.content)), signOuts: { before, after } }, null, 2));
    expect(after).toBe(before);
  } finally { await close(); }
});
