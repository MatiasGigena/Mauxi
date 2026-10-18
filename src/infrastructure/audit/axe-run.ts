import type { AxeResults, RunOptions } from "axe-core";
import type { AxeRun, AxeRunOptions } from "../../application/audit-axe";

export interface AxeApi { version: string; run(context: Document, options: RunOptions): Promise<AxeResults> }

/**
 * Runs axe-core on the current document and returns a compact, bounded summary of violations and inconclusive results.
 *
 * It runs in the audit's isolated world (where axe-core was injected) and is serialized with Function.prototype.toString,
 * so it must stay self-contained: no imports, no module-level values, no helpers declared outside this function.
 */
export async function runAxe(axe: AxeApi, options: AxeRunOptions): Promise<AxeRun> {
  type Result = AxeRun["results"][number];

  const started = performance.now();
  const clip = (value: string, limit: number) => value.length <= limit ? value : value.slice(0, limit - 1) + "…";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`axe-core did not finish within ${options.timeoutMs}ms`)), options.timeoutMs); });
  let raw: AxeResults;

  try {
    raw = await Promise.race([axe.run(document, {
      runOnly: { type: "rule", values: [...options.rules] }, resultTypes: ["violations", "incomplete"], iframes: false,
      selectors: true, ancestry: false, xpath: false, elementRef: false, absolutePaths: false, performanceTimer: false, preload: false,
    }), timeout]);
  } finally { clearTimeout(timer); }

  const results: Result[] = [];
  const outcomes = [["violation", raw.violations], ["incomplete", raw.incomplete]] as const;

  for (const [outcome, list] of outcomes) {
    for (const result of list) {
      const nodes: Result["nodes"] = [];
      let total = 0;

      for (const node of result.nodes) {
        const checks = [...node.none, ...node.all, ...node.any];
        const reason = String(checks.find((check) => check.data?.messageKey)?.data?.messageKey ?? "");

        if (outcome === "incomplete" && options.ignoredIncomplete.includes(reason)) continue;
        total++;

        if (nodes.length >= options.maxNodes) continue;
        // Targets inside shadow roots are nested arrays; they are joined with " >>> " for display and are not resolved.
        const nested = node.target.length !== 1 || Array.isArray(node.target[0]);
        const target = nested ? node.target.flat().join(" >>> ") : String(node.target[0]);
        const message = checks.find((check) => check.message)?.message ?? result.help;
        nodes.push({ target: clip(target, 1_024), message: clip(message, 600), impact: node.impact ?? null });
      }

      if (!total || results.length >= 64) continue;
      results.push({ rule: clip(result.id, 64), outcome, impact: result.impact ?? null, tags: result.tags.slice(0, 32).map((tag) => clip(tag, 64)), help: clip(result.help, 512), helpUrl: clip(result.helpUrl, 512), total, nodes });
    }
  }

  return { version: clip(String(axe.version), 32), durationMs: Math.round(performance.now() - started), results };
}
