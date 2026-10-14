import { useLayoutEffect, useRef } from "react";
import type { AgentMessageView } from "../application/agent-contract";

export type AcceptedPrompt = { text: string; previousUserIds: string[] };

export function latestExchange(messages: AgentMessageView[], accepted?: AcceptedPrompt) {
  const index = messages.findLastIndex(message => message.role === "user");

  if (accepted && !messages.some(message => message.role === "user" && message.text === accepted.text && !accepted.previousUserIds.includes(message.id))) {
    return { prompt: { id: "accepted", role: "user" as const, text: accepted.text }, output: [], queued: true };
  }

  if (index < 0) return null;

  return { prompt: messages[index], output: messages.slice(index + 1).filter(message => message.role === "assistant"), queued: false };
}

export function exchangeContainsError(exchange: ReturnType<typeof latestExchange>, error: string) {
  const normalize = (text: string) => text.trim().replace(/\s+/g, " ");

  return !!error.trim() && !!exchange?.output.some(message => message.error && normalize(message.text) === normalize(error));
}

export function ChatExchange({ exchange, running, hidden }: {
  exchange: NonNullable<ReturnType<typeof latestExchange>>; running: boolean; hidden: boolean;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const text = exchange.output.map(message => message.text).join("\n");
  useLayoutEffect(() => {
    following.current = true;

    if (viewport.current) viewport.current.scrollTop = 0;
  }, [exchange.prompt.id, exchange.prompt.text]);
  useLayoutEffect(() => {
    const node = viewport.current;

    if (node && following.current && !hidden) node.scrollTop = node.scrollHeight;
  }, [text, running, hidden]);

  return <div className="chat-exchange" data-composer-motion="exchange" data-retained-motion=""
    data-exiting={hidden || undefined} inert={hidden} aria-hidden={hidden || undefined}
    role="region" aria-label="Latest exchange">
    <section className="chat-prompt" aria-label="User prompt" tabIndex={0}>
      <span className="chat-role">You</span>
      <p>{exchange.prompt.text}</p>
    </section>
    <section className="chat-response">
      <span className="chat-role">Agent</span>
      <div ref={viewport} className="chat-response-output" role="log" aria-label="Agent response" aria-live="polite" aria-relevant="additions text" tabIndex={0}
        onScroll={event => { const node = event.currentTarget; following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 32; }}>
        {exchange.output.map(message => <p key={message.id} className={message.error ? "send-error" : undefined}>{message.text}</p>)}
        {!text && <p className="chat-response-status">{exchange.queued ? "Queued for agent…" : running ? "Working…" : "No response yet."}</p>}
      </div>
    </section>
  </div>;
}
