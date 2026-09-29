import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentDialog, AgentEvent } from "../../src/application/agent-contract";
import { PiAgentHost } from "../../src/infrastructure/agent/pi-agent-host";

const roots: string[] = [];
const hosts: PiAgentHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.dispose()));
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function setup(openBrowser = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined)) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mauxi-oauth-")); roots.push(root);
  const runtime = await ModelRuntime.create({ authPath: path.join(root, "auth.json"), modelsPath: null });
  const host = new PiAgentHost("login-test", process.cwd(), path.join(root, "profile"), path.join(root, "captures"), runtime, undefined, openBrowser);
  hosts.push(host);
  await host.initialize();
  const events: AgentEvent[] = [];
  let current: AgentDialog | undefined;
  const off = host.subscribe(event => {
    events.push(event);
    if (event.type === "dialog") current = event.dialog;
    if (event.type === "dialog-dismissed" && current?.id === event.id) current = undefined;
  });
  const respond = (dialog: AgentDialog, value?: string) => host.respondToDialog({ workspaceId: "login-test", dialogId: dialog.id, value, cancelled: value === undefined });
  const dialog = async (kind: AgentDialog["kind"]) => {
    await vi.waitFor(() => expect(current?.kind).toBe(kind));
    return current!;
  };
  const login = () => host.login({ workspaceId: "login-test", providerId: "openai-codex", type: "oauth" });
  return { host, runtime, events, off, respond, dialog, login, openBrowser, current: () => current };
}

function mockTokenExchange() {
  const access = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64")}.signature`;
  const fetch = vi.fn(async (url: string | URL | Request) => {
    if (String(url) !== "https://auth.openai.com/oauth/token") throw new Error("Unexpected network request in OAuth test");
    return new Response(JSON.stringify({ access_token: access, refresh_token: "test-refresh-secret", expires_in: 3600 }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

it("opens the browser once and retains its link on Pi's immediate manual-code prompt", async () => {
  const test = await setup();
  const fetch = mockTokenExchange();
  const login = test.login();
  test.respond(await test.dialog("select"), "browser");
  const manual = await test.dialog("manual_code");
  await vi.waitFor(() => expect(test.openBrowser).toHaveBeenCalledTimes(1));
  const url = test.openBrowser.mock.calls[0][0];
  expect(manual.links).toEqual([{ url, label: "Open sign-in" }]);
  const state = new URL(url).searchParams.get("state");
  test.respond(manual, `http://localhost:1455/auth/callback?code=test-code&state=${state}`);
  await login;
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(test.current()).toBeUndefined();
  const snapshot = await test.host.snapshot();
  expect(snapshot.providers.find(provider => provider.id === "openai-codex")?.authenticated).toBe(true);
  expect(snapshot.models.filter(model => model.provider === "openai-codex" && model.available).map(model => model.id))
    .toEqual(expect.arrayContaining(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]));
  expect(JSON.stringify(snapshot)).not.toContain("test-refresh-secret");
});

it("accepts the local browser callback and dismisses manual input without treating it as cancellation", async () => {
  const test = await setup();
  const localFetch = globalThis.fetch;
  mockTokenExchange();
  const login = test.login();
  test.respond(await test.dialog("select"), "browser");
  const manual = await test.dialog("manual_code");
  const state = new URL(manual.links![0].url).searchParams.get("state");
  const response = await localFetch(`http://127.0.0.1:1455/auth/callback?code=test-code&state=${state}`);
  expect(response.status).toBe(200);
  await response.text();
  await login;
  expect(test.current()).toBeUndefined();
  expect((await test.host.snapshot()).error).toBeUndefined();
});

it("keeps manual sign-in usable after a browser-launch failure", async () => {
  const test = await setup(vi.fn().mockRejectedValue(new Error("No browser handler")));
  const login = test.login();
  const rejected = expect(login).rejects.toThrow(/cancelled/i);
  test.respond(await test.dialog("select"), "browser");
  await test.dialog("manual_code");
  await vi.waitFor(() => expect(test.current()?.warning).toContain("Could not open your default browser"));
  expect(test.current()?.links?.[0].label).toBe("Open sign-in");
  test.respond(test.current()!);
  await rejected;
  expect(test.current()).toBeUndefined();
});

it("cancels pending login on UI disconnect and permits a fresh attempt", async () => {
  const test = await setup();
  const login = test.login();
  const rejected = expect(login).rejects.toThrow(/cancelled/i);
  test.respond(await test.dialog("select"), "browser");
  await test.dialog("manual_code");
  await expect(test.login()).rejects.toThrow(/already in progress/i);
  test.off();
  await rejected;
  const off = test.host.subscribe(event => {
    if (event.type === "dialog" && event.dialog.kind === "select") test.respond(event.dialog);
  });
  await expect(test.login()).rejects.toThrow(/cancelled/i);
  off();
});

it("retains a cancellable link through progress and dismisses all notices on completion", async () => {
  const test = await setup();
  vi.spyOn(test.runtime, "login").mockImplementation(async (_provider, _type, interaction) => {
    interaction.notify({ type: "auth_url", url: "https://example.com/login" });
    interaction.notify({ type: "progress", message: "Waiting for browser sign-in" });
    expect(test.current()).toMatchObject({ kind: "progress", cancellable: true, links: [{ url: "https://example.com/login", label: "Open sign-in" }] });
    return { type: "oauth", access: "test", refresh: "test", expires: Date.now() + 3600000 };
  });
  await test.login();
  expect(test.current()).toBeUndefined();
});

it("reports a safe, actionable token-exchange error instead of exposing the response body", async () => {
  const test = await setup();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("sensitive-token-response", { status: 401 })));
  const login = test.login();
  const rejected = expect(login).rejects.toThrow(/HTTP 401/);
  test.respond(await test.dialog("select"), "browser");
  test.respond(await test.dialog("manual_code"), "test-code");
  await rejected;
  expect(test.current()).toBeUndefined();
  expect(JSON.stringify(test.events)).not.toContain("sensitive-token-response");
});
