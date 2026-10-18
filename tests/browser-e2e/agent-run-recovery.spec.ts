import { expect, test, type Page } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { launch, stalledEdit, text, toolCall, unavailable } from "../helpers/fake-provider";

async function handOffAndSend(page: Page, prompt: string) {
  await page.getByRole("button", { name: "Give agent control", exact: true }).click();
  await expect(page.getByRole("button", { name: "Take back control", exact: true })).toBeVisible();
  await page.getByLabel("Message", { exact: true }).fill(prompt);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}

const settled = (page: Page) => expect.poll(async () => (await page.evaluate(() => window.mauxi!.agentBootstrap())).runState, { timeout: 60_000 }).toBe("idle");
const snapshot = (page: Page) => page.evaluate(() => window.mauxi!.agentBootstrap());

test("malformed tool arguments are returned to the model without revoking preview control or failing the run", async ({}, testInfo) => {
  const state = await mkdtemp(path.join(os.tmpdir(), "mauxi-recovery-"));

  const { page, requests, close } = await launch(state, request => [
    toolCall("workspace_edit", JSON.stringify({ path: "src/App.tsx", oldText: "Mauxi", ".newText": "Mauxi!" })),
    toolCall("workspace_search", JSON.stringify({ query: "" })),
    toolCall("browser_targets", "{}"),
  ][request - 1] ?? text("Recovered from malformed arguments."));

  try {
    await handOffAndSend(page, "Polish the heading");
    await expect(page.getByRole("log", { name: "Agent response" })).toContainText("Recovered from malformed arguments.", { timeout: 30_000 });
    await settled(page);
    expect(requests).toHaveLength(4);
    expect(requests[1]).toContain("Validation failed for tool \\\"workspace_edit\\\"");
    expect(requests[2]).toContain("Validation failed for tool \\\"workspace_search\\\"");
    expect(requests[3]).toContain('\\"owner\\":\\"agent\\"');
    const final = await snapshot(page);
    expect(final.error).toBeUndefined();
    expect(final.status).toBe("Ready");
    await expect(page.locator(".send-error")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("malformed-arguments-recovered.png") });
  } finally { await close(); }
});

test("a turn-budget stop explains the limit instead of showing a raw abort", async ({}, testInfo) => {
  const state = await mkdtemp(path.join(os.tmpdir(), "mauxi-recovery-"));
  const { page, requests, close } = await launch(state, () => toolCall("workspace_list", "{}"));

  try {
    await handOffAndSend(page, "Keep exploring");
    const reason = "Stopped: the request reached its 40-turn limit; partial changes were kept for review.";
    await expect(page.getByRole("log", { name: "Agent response" })).toContainText(reason, { timeout: 60_000 });
    await settled(page);
    expect(requests.length).toBeGreaterThanOrEqual(40);
    expect(requests.length).toBeLessThanOrEqual(41);
    const final = await snapshot(page);
    expect(final.error?.message).toBe(reason);
    await expect(page.getByText(/operation was aborted|Request was aborted/i)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Give agent control", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("turn-budget-stop.png") });
  } finally { await close(); }
});

test("a stalled model stream is cut off and retried once", async ({}, testInfo) => {
  const state = await mkdtemp(path.join(os.tmpdir(), "mauxi-recovery-"));
  const { page, requests, close } = await launch(state, request => request === 1 ? stalledEdit : request === 2 ? toolCall("browser_targets", "{}") : text("Recovered after the stalled stream."), { MAUXI_TEST_STREAM_IDLE_MS: "2000" });

  try {
    await handOffAndSend(page, "Polish the heading");
    await expect(page.getByRole("log", { name: "Agent response" })).toContainText("Recovered after the stalled stream.", { timeout: 60_000 });
    await settled(page);
    expect(requests).toHaveLength(3);
    expect(requests[2]).toContain('\\"owner\\":\\"agent\\"');
    const final = await snapshot(page);
    expect(final.error).toBeUndefined();
    expect(final.status).toBe("Ready");
    await expect(page.getByRole("log", { name: "Agent response" })).not.toContainText(/stopped sending data|timed out/i);
    await page.screenshot({ path: testInfo.outputPath("stalled-stream-retried.png") });
  } finally { await close(); }
});

test("a stream that stalls again ends with a clear reason", async ({}, testInfo) => {
  const state = await mkdtemp(path.join(os.tmpdir(), "mauxi-recovery-"));
  const { page, requests, close } = await launch(state, () => stalledEdit, { MAUXI_TEST_STREAM_IDLE_MS: "2000" });

  try {
    await handOffAndSend(page, "Polish the heading");
    const reason = "The model stopped sending data for 2 seconds (timed out).";
    await expect(page.getByRole("log", { name: "Agent response" })).toContainText(reason, { timeout: 60_000 });
    await settled(page);
    expect(requests).toHaveLength(2);
    expect((await snapshot(page)).error?.message).toBe(reason);
    await expect(page.getByText(/operation was aborted|Request was aborted/i)).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("stalled-stream-failed.png") });
  } finally { await close(); }
});

test("a transient provider error is retried without revoking control or failing the run", async ({}, testInfo) => {
  const state = await mkdtemp(path.join(os.tmpdir(), "mauxi-recovery-"));
  const { page, requests, close } = await launch(state, request => [unavailable, toolCall("browser_targets", "{}")][request - 1] ?? text("Recovered after the provider retry."));

  try {
    await handOffAndSend(page, "Polish the heading");
    await expect(page.getByRole("log", { name: "Agent response" })).toContainText("Recovered after the provider retry.", { timeout: 60_000 });
    await settled(page);
    expect(requests).toHaveLength(3);
    expect(requests[2]).toContain('\\"owner\\":\\"agent\\"');
    const final = await snapshot(page);
    expect(final.error).toBeUndefined();
    expect(final.status).toBe("Ready");
    await expect(page.locator(".send-error")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("provider-retry-recovered.png") });
  } finally { await close(); }
});

test("malformed browser actions still return preview control to the user", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "mauxi-recovery-"));

  const { page, requests, close } = await launch(state, request => [
    toolCall("browser_action", JSON.stringify({ previewId: "desktop", operation: "screenshot" })),
    toolCall("browser_targets", "{}"),
  ][request - 1] ?? text("Reported the revoked handoff."));

  try {
    await handOffAndSend(page, "Check the preview");
    await expect(page.getByRole("log", { name: "Agent response" })).toContainText("Reported the revoked handoff.", { timeout: 30_000 });
    await settled(page);
    expect(requests[1]).toContain("Validation failed for tool \\\"browser_action\\\"");
    expect(requests[2]).not.toContain('\\"owner\\":\\"agent\\"');
  } finally { await close(); }
});
