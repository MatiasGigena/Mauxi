import type { AgentSession } from "@earendil-works/pi-coding-agent";

type StreamFn = AgentSession["agent"]["streamFunction"];

type Stream = Awaited<ReturnType<StreamFn>>;

type StreamEvent = Stream extends AsyncIterable<infer Event> ? Event : never;

type AssistantMessage = Awaited<ReturnType<Stream["result"]>>;

const watched = new WeakSet<StreamFn>();

export function stallMessage(idleMs: number): string {
  const seconds = Math.round(idleMs / 1_000);

  return `The model stopped sending data for ${seconds} second${seconds === 1 ? "" : "s"} (timed out).`;
}

/**
 * Bounds the silence of one streaming model call. The SDK only has a process-wide HTTP body
 * timeout (default five minutes), so a provider that holds a stream open without sending data
 * would otherwise run into the request deadline. A stalled call ends as a retryable "timed out"
 * provider error so the session's single automatic retry can recover; caller aborts (Stop,
 * budgets) are left untouched.
 */
export function watchStreamIdle(session: AgentSession, idleMs: number): void {
  const agent = session.agent;

  if (watched.has(agent.streamFunction)) return;
  const inner = agent.streamFunction;

  const watchedFn: StreamFn = async (model, context, options) => {
    const stall = new AbortController();
    const signal = options?.signal ? AbortSignal.any([options.signal, stall.signal]) : stall.signal;
    const message = stallMessage(idleMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let giveUp: () => void = () => undefined;
    const gaveUp = new Promise<"gave-up">((resolve) => { giveUp = () => resolve("gave-up"); });

    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        stall.abort(new Error(message));
        // Providers end their stream once the signal aborts; do not depend on it.
        timer = setTimeout(giveUp, 5_000);
      }, idleMs);
    };

    arm();
    let source: Stream;

    try { source = await inner(model, context, { ...options, signal }); }
    catch (error) { clearTimeout(timer); throw error; }

    // SAFETY: providers return pi-ai's AssistantMessageEventStream, whose constructor takes no arguments;
    // pi-ai is not a direct dependency, so the class is reached through the instance.
    const output = new (source.constructor as new () => Stream)();
    let partial: AssistantMessage | undefined;
    const stalled = () => stall.signal.aborted && !options?.signal?.aborted;

    const failed = (base: AssistantMessage | undefined, errorMessage = message): StreamEvent => {
      const error: AssistantMessage = {
        ...(base ?? { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }),
        stopReason: "error", errorMessage,
      };

      return { type: "error", reason: "error", error };
    };

    void (async () => {
      const iterator = source[Symbol.asyncIterator]();

      try {
        while (true) {
          const next = await Promise.race([iterator.next(), gaveUp]);

          if (next === "gave-up") { output.push(failed(partial && { ...partial, content: [] })); break; }

          if (next.done) break;
          let event = next.value;

          if (event.type !== "done" && event.type !== "error") { partial = event.partial; arm(); }
          else if (event.type === "error" && stalled()) event = failed(event.error);
          output.push(event);

          if (event.type === "done" || event.type === "error") break;
        }
      } catch (error) {
        output.push(failed(partial && { ...partial, content: [] }, stalled() ? message : error instanceof Error ? error.message : String(error)));
      } finally { clearTimeout(timer); output.end(); }
    })().catch(() => undefined);

    return output;
  };

  watched.add(watchedFn);
  agent.streamFunction = watchedFn;
}
