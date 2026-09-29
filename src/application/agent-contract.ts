import type { StoredSelection } from "./selection-state";
import type { ResourceView } from "./design-resource-contract";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type AgentThinkingLevel = typeof THINKING_LEVELS[number];

export interface AgentProviderView {
  id: string;
  name: string;
  authenticated: boolean;
  authSource?: string;
  authMethods: Array<{ type: "api_key" | "oauth"; label: string }>;
}

export interface AgentModelView {
  key: string;
  provider: string;
  id: string;
  name: string;
  available: boolean;
  supportsImages: boolean;
  thinkingLevels: AgentThinkingLevel[];
}

export interface AgentSessionView {
  id: string;
  name?: string;
  createdAt: string;
  updatedAt: string;
  firstMessage: string;
  active: boolean;
}

export interface AgentMessageView {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  pending?: boolean;
  error?: boolean;
}

export interface AgentToolActivityView {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  input?: string;
  output?: string;
}

export interface AgentChangeFileView {
  path: string;
  kind: "create" | "modify" | "delete";
  attribution: "managed" | "unattributed";
  diff: string;
}

export interface AgentChangeSetView {
  id: string;
  label: string;
  state: "prepared" | "active" | "settled" | "failed" | "undoing" | "undone" | "conflicted";
  createdAt: string;
  undoEligible: boolean;
  files: AgentChangeFileView[];
  unexpectedPaths: string[];
  coverageWarnings: string[];
  errors: string[];
}

export type AgentRunState = "idle" | "working" | "waiting" | "retrying" | "compacting" | "stopping" | "error";

export interface AgentSnapshot {
  ready: boolean;
  workspaceId: string;
  sessionId?: string;
  sessionName?: string;
  providers: AgentProviderView[];
  models: AgentModelView[];
  selectedModel?: string;
  thinkingLevel: AgentThinkingLevel;
  sessions: AgentSessionView[];
  messages: AgentMessageView[];
  tools: AgentToolActivityView[];
  changeSets: AgentChangeSetView[];
  resources?: ResourceView;
  runState: AgentRunState;
  queued: { steering: number; followUp: number };
  status: string;
  error?: { kind: "auth" | "rate-limit" | "catalog" | "capability" | "runtime"; message: string };
}

export type AgentDialog = { links?: Array<{ url: string; label?: string }>; warning?: string } & (
  | { id: string; kind: "text" | "secret" | "manual_code"; title: string; message: string; placeholder?: string }
  | { id: string; kind: "select"; title: string; message: string; options: Array<{ id: string; label: string; description?: string }> }
  | { id: string; kind: "approval"; title: string; message: string; operation: string; cwd: string; warnings: string[] }
  | { id: string; kind: "info" | "progress"; title: string; message: string; cancellable?: boolean });

export type AgentEvent =
  | { type: "snapshot"; snapshot: AgentSnapshot }
  | { type: "dialog"; dialog: AgentDialog }
  | { type: "dialog-dismissed"; id: string };

export interface AgentSendRequest {
  workspaceId: string;
  text: string;
  behavior: "prompt" | "steer" | "followUp";
  selections: StoredSelection[];
}

export interface AgentLoginRequest {
  workspaceId: string;
  providerId: string;
  type: "api_key" | "oauth";
}

export interface AgentModelRequest {
  workspaceId: string;
  modelKey: string;
}

export interface AgentThinkingRequest {
  workspaceId: string;
  level: AgentThinkingLevel;
}

export interface AgentSessionRequest {
  workspaceId: string;
  sessionId: string;
}

export interface AgentRenameRequest {
  workspaceId: string;
  name: string;
}

export interface AgentUndoRequest {
  workspaceId: string;
  changeSetId: string;
}

export interface AgentDialogResponse {
  workspaceId: string;
  dialogId: string;
  value?: string;
  cancelled?: boolean;
}

export function isThinkingLevel(value: unknown): value is AgentThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

export function assertShortString(value: unknown, label: string, max = 4_096): asserts value is string {
  if (typeof value !== "string" || value.length > max) throw new Error(`Invalid ${label}`);
}

export function selectionContext(selections: readonly StoredSelection[]): string {
  if (!selections.length) return "";
  const blocks = selections.map(({ capture }, index) => {
    const source = capture.source.verification === "verified"
      ? `${capture.source.filePath}:${capture.source.lineNumber ?? "?"}:${capture.source.columnNumber ?? "?"} (SHA-256 ${capture.source.fileFingerprint})`
      : `${capture.source.verification}: ${capture.source.filePath || "no source"}`;
    const styles = Object.entries(capture.computedStyles).slice(0, 40).map(([key, value]) => `${key}: ${String(value).slice(0, 300)}`).join("; ");
    return [
      `Selection ${index + 1} [${capture.previewId}]`,
      `URL: ${capture.url}`,
      `Element: <${capture.element.tag}> ${capture.element.label}`,
      `Text: ${capture.element.text.slice(0, 2_000) || "(none)"}`,
      `Bounds: ${capture.bounds.x},${capture.bounds.y} ${capture.bounds.width}x${capture.bounds.height} CSS px in ${capture.viewport.width}x${capture.viewport.height}`,
      `Source: ${source}`,
      `Styles: ${styles || "(none)"}`,
      `DOM: ${capture.element.html.slice(0, 8_000)}`,
      `Screenshot: ${capture.screenshot.status === "captured" ? "attached as image" : `unavailable (${capture.screenshot.reason ?? capture.screenshot.status})`}`,
    ].join("\n");
  });
  return `\n\n<selected_context>\n${blocks.join("\n\n")}\n</selected_context>`;
}
