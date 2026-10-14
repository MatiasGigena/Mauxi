import { describe, expect, it } from "vitest";
import { latestExchange } from "../../src/presentation/ChatExchange";
import type { AgentMessageView } from "../../src/application/agent-contract";

const messages: AgentMessageView[] = [
  { id: "u1", role: "user", text: "Old prompt" },
  { id: "a1", role: "assistant", text: "Old output" },
  { id: "u2", role: "user", text: "New prompt" },
  { id: "s1", role: "system", text: "Internal status" },
  { id: "a2", role: "assistant", text: "New output", pending: true },
];

describe("latest chat exchange", () => {
  it("matches repeated prompts by new identity, not just their text", () => {
    const accepted = { text: "New prompt", previousUserIds: ["u1", "u2"] };
    expect(latestExchange(messages, accepted)?.queued).toBe(true);
    const delivered = [...messages, { id: "u3", role: "user" as const, text: "New prompt" }, { id: "a3", role: "assistant" as const, text: "Third output" }];
    expect(latestExchange(delivered, accepted)?.output.map(message => message.id)).toEqual(["a3"]);
  });
});
