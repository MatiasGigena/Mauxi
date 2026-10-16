import { _electron as electron, expect, test } from "@playwright/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";

interface ChatDelta {
  role?: "assistant";
  content?: string;
  tool_calls?: Array<{ index: number; id: string; type: "function"; function: { name: string; arguments: string } }>;
}

test("after handoff the agent receives selections, searches one file and lists targets without knowing the workspace ID", async ({}, testInfo) => {
  const state = await mkdtemp(path.join(os.tmpdir(), "mauxi-handoff-"));
  const requests: string[] = [];

  const server = createServer((request, response) => {
    let body = ""; request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      requests.push(body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: ChatDelta, finish: string | null) => `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 1, model: "handoff", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

      const tool = [
        { name: "workspace_search", arguments: JSON.stringify({ path: "src/components/ProofCard.tsx", query: "Run action" }) },
        { name: "browser_targets", arguments: "{}" },
      ][requests.length - 1];

      if (tool) {
        response.end(chunk({ role: "assistant", tool_calls: [{ index: 0, id: `tool-${requests.length}`, type: "function", function: tool }] }, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n");

        return;
      }

      response.end(chunk({ role: "assistant", content: "Checked the selected target." }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
    });
  });

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = Value.Parse(Type.Object({ port: Type.Number() }), server.address());
  const profile = path.join(state, "config", "Mauxi", "pi-profile");
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, "models.json"), JSON.stringify({ providers: { "handoff-local": {
    baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "local-placeholder", api: "openai-completions",
    models: [{ id: "handoff", name: "Handoff local fake", reasoning: false, input: ["text", "image"], contextWindow: 100_000, maxTokens: 1_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  await writeFile(path.join(profile, "model-preference.json"), JSON.stringify({ defaultProvider: "handoff-local", defaultModel: "handoff" }));

  const app = await electron.launch({ args: [path.resolve("dist-electron/main.js")], env: { ...process.env, MAUXI_TEST_MODE: "1", MAUXI_RENDERER_URL: "http://127.0.0.1:44173", MAUXI_STATE_DIR: path.join(state, "recovery"), XDG_CONFIG_HOME: path.join(state, "config") } });

  try {
    let page = await app.firstWindow();
    const discovery = await page.evaluate(root => window.mauxi!.inspectProjectPath(root), path.resolve("."));
    const plan = discovery.plans.find(candidate => candidate.appRoot.endsWith("/fixtures/vite"))!;
    const next = app.waitForEvent("window");
    await page.evaluate(request => window.mauxi!.confirmProject(request), { discoveryId: discovery.discoveryId, planId: plan.id, mode: "start" as const });
    page = await next;
    await expect(page.locator(".bridge-ready")).toHaveCount(2, { timeout: 45_000 });
    await expect.poll(async () => (await page.evaluate(() => window.mauxi!.agentBootstrap())).selectedModel).toBe("handoff-local/handoff");

    const desktop = page.frameLocator('[data-testid="desktop-preview"]');
    await page.getByRole("button", { name: "Select in Desktop", exact: true }).click();
    await expect.poll(() => desktop.locator("html").evaluate(node => getComputedStyle(node).cursor)).toBe("crosshair");
    const frame = (await page.getByTestId("desktop-preview").boundingBox())!;

    const point = await desktop.getByTestId("known-target").evaluate(node => {
      const r = node.getBoundingClientRect();

      return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: innerWidth, height: innerHeight };
    });

    await page.mouse.click(frame.x + point.x * frame.width / point.width, frame.y + point.y * frame.height / point.height);
    await expect(page.locator(".selection-chip")).toHaveCount(1);
    await page.getByRole("button", { name: "Select in Desktop", exact: true }).click();

    await page.getByRole("button", { name: "Give agent control", exact: true }).click();
    await expect(page.getByRole("button", { name: "Take back control", exact: true })).toBeVisible();
    await page.getByLabel("Message", { exact: true }).fill("Check this selected target in the previews");
    await page.getByRole("button", { name: "Send", exact: true }).click();

    await expect(page.getByRole("log", { name: "Agent response" })).toContainText("Checked the selected target.", { timeout: 30_000 });
    await expect(page.getByText(/selections are stale/)).toHaveCount(0);
    expect(requests).toHaveLength(3);
    expect(requests[0]).toContain("Selection 1 [desktop]");
    expect(requests[1]).not.toContain("ENOTDIR");
    expect(requests[1]).toMatch(/ProofCard\.tsx:\d+: [^"]*Run action/);
    expect(requests[2]).not.toContain("Stale agent workspace");
    expect(requests[2]).toContain('\\"owner\\":\\"agent\\"');
    expect(requests[2]).toContain('\\"previewId\\":\\"mobile\\"');
    await expect(page.getByRole("button", { name: "Give agent control", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("handoff-sent.png") });
  } finally {
    await app.close();
    server.close();
  }
});
