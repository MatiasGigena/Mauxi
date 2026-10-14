import type { PreviewId } from "./preview-contract";

export type BrowserOwner = "human" | "picker" | "agent";
export type BrowserOperation = "screenshot" | "inspect" | "source" | "console" | "navigate" | "click" | "type" | "hover" | "scroll";
export interface BrowserTarget { workspaceId: string; previewId: PreviewId; documentId: string; url: string }
export interface BrowserRequest extends BrowserTarget {
  generation: number;
  operation: BrowserOperation;
  target?: string;
  text?: string;
  route?: string;
  x?: number;
  y?: number;
}
export interface BrowserActionTarget {
  tag: string; text: string; label: string; role: string | null; testId: string | null; type: string | null;
  bounds: { x: number; y: number; width: number; height: number };
}
export interface BrowserEvidence {
  id: string; previewId: PreviewId; documentId: string; operation: BrowserOperation; at: string;
  summary: string; image?: string;
}
export interface BrowserState {
  workspaceId: string; owner: BrowserOwner; generation: number; releasing: boolean;
  activity: string; remaining: number; evidence: BrowserEvidence[];
}
export interface BrowserResult { text: string; image?: string }
export interface BrowserPort {
  state(): BrowserState;
  targets(): Promise<BrowserTarget[]>;
  run(request: BrowserRequest, signal?: AbortSignal): Promise<BrowserResult>;
  revoke(reason: string): void;
  resetBudget(): void;
}
export const BROWSER_OPERATIONS: BrowserOperation[] = ["screenshot", "inspect", "source", "console", "navigate", "click", "type", "hover", "scroll"];
export function assertBrowserRequest(value: unknown): asserts value is BrowserRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid browser request");
  const r = value as Record<string, unknown>;
  const allowed = ["workspaceId", "previewId", "documentId", "url", "generation", "operation", "target", "text", "route", "x", "y"];
  if (Object.keys(r).some(key => !allowed.includes(key))) throw new Error("Unsupported browser capability");
  for (const key of ["workspaceId", "documentId", "url"]) if (typeof r[key] !== "string" || !r[key] || r[key].length > (key === "url" ? 4096 : 128)) throw new Error(`Invalid ${key}`);
  if (r.previewId !== "desktop" && r.previewId !== "mobile") throw new Error("Invalid preview");
  if (!Number.isSafeInteger(r.generation) || Number(r.generation) < 0 || !BROWSER_OPERATIONS.includes(r.operation as BrowserOperation)) throw new Error("Invalid browser operation");
  for (const key of ["target", "text", "route"]) if (r[key] !== undefined && (typeof r[key] !== "string" || r[key].length > (key === "target" ? 128 : 4096))) throw new Error(`Invalid ${key}`);
  for (const key of ["x", "y"]) if (r[key] !== undefined && (typeof r[key] !== "number" || !Number.isFinite(r[key]) || Math.abs(r[key]) > 2000)) throw new Error(`Invalid ${key}`);
  if (["click", "type", "hover", "source"].includes(String(r.operation)) && !r.target) throw new Error("Inspect first and use its document-scoped target ID");
  if (r.operation === "type" && typeof r.text !== "string") throw new Error("Missing text");
  if (r.operation === "navigate" && typeof r.route !== "string") throw new Error("Missing route");
}
