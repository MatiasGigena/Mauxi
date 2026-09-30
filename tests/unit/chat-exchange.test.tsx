import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatExchange, exchangeContainsError, latestExchange } from "../../src/presentation/ChatExchange";
import type { AgentMessageView } from "../../src/application/agent-contract";

const messages: AgentMessageView[] = [
  { id: "u1", role: "user", text: "Old prompt" },
  { id: "a1", role: "assistant", text: "Old output" },
  { id: "u2", role: "user", text: "New prompt" },
  { id: "s1", role: "system", text: "Internal status" },
  { id: "a2", role: "assistant", text: "New output", pending: true },
];

describe("latest chat exchange", () => {
  it("shows only the newest prompt and its response without changing history", () => {
    const exchange = latestExchange(messages)!;
    expect(exchange.prompt.id).toBe("u2");
    expect(exchange.output.map(message => message.id)).toEqual(["a2"]);
    const html = renderToStaticMarkup(<ChatExchange exchange={exchange} running hidden={false} />);
    expect(html.indexOf("New prompt")).toBeLessThan(html.indexOf("New output"));
    expect(html).toContain('aria-label="User prompt"');
    expect(html).toContain('aria-label="Agent response"');
    for (const old of ["Old prompt", "Old output", "Internal status"]) expect(html).not.toContain(old);
    expect(messages).toHaveLength(5);
  });

  it("hides prior output while an accepted follow-up is queued", () => {
    const exchange = latestExchange(messages, { text: "Next prompt", previousUserIds: ["u1", "u2"] })!;
    expect(exchange.prompt.text).toBe("Next prompt");
    expect(exchange.output).toEqual([]);
    expect(exchange.queued).toBe(true);
    const html = renderToStaticMarkup(<ChatExchange exchange={exchange} running hidden={false} />);
    expect(html).toContain("Queued for agent…");
    expect(html).not.toContain("New output");
  });

  it("matches repeated prompts by new identity, not just their text", () => {
    const accepted = { text: "New prompt", previousUserIds: ["u1", "u2"] };
    expect(latestExchange(messages, accepted)?.queued).toBe(true);
    const delivered = [...messages, { id: "u3", role: "user" as const, text: "New prompt" }, { id: "a3", role: "assistant" as const, text: "Third output" }];
    expect(latestExchange(delivered, accepted)?.output.map(message => message.id)).toEqual(["a3"]);
  });

  it("has no exchange before the first prompt and no old output on a new turn", () => {
    expect(latestExchange([])).toBeNull();
    expect(latestExchange([{ id: "a", role: "assistant", text: "Orphan" }])).toBeNull();
    expect(latestExchange([...messages, { id: "u3", role: "user", text: "Another" }])?.output).toEqual([]);
  });

  it("identifies duplicate errors without suppressing distinct failures or normal text", () => {
    const error = { id: "error", role: "assistant" as const, text: "Codex error: Usage limit reached", error: true };
    const exchange = latestExchange([...messages, error]);
    expect(exchangeContainsError(exchange, "Codex error: Usage limit reached")).toBe(true);
    expect(exchangeContainsError(exchange, " Codex error:  Usage limit reached\n")).toBe(true);
    expect(exchangeContainsError(exchange, "Checkpoint error: failed")).toBe(false);
    expect(exchangeContainsError(latestExchange(messages), "New output")).toBe(false);
    expect(exchangeContainsError(null, error.text)).toBe(false);
    expect(exchangeContainsError(exchange, "")).toBe(false);
  });

  it("hides the retained exchange from focus and accessibility during settings/login", () => {
    const html = renderToStaticMarkup(<ChatExchange exchange={latestExchange(messages)!} running hidden />);
    expect(html).toContain('inert=""');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('data-exiting="true"');
  });
});
