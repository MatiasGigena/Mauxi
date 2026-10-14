import { Type, type TSchema } from "typebox";
import { Check } from "typebox/schema";
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

const boundedString = (limit: number, min = 0) => Type.Refine(Type.String(), (value) => value.length >= min && value.length <= limit);

const coordinate = Type.Number({ minimum: -2000, maximum: 2000 });

const requestFields = {
  workspaceId: boundedString(128, 1),
  previewId: Type.Union([Type.Literal("desktop"), Type.Literal("mobile")]),
  documentId: boundedString(128, 1),
  url: boundedString(4096, 1),
  generation: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  operation: Type.Union(BROWSER_OPERATIONS.map((operation) => Type.Literal(operation))),
  target: Type.Optional(boundedString(128)),
  text: Type.Optional(boundedString(4096)),
  route: Type.Optional(boundedString(4096)),
  x: Type.Optional(coordinate),
  y: Type.Optional(coordinate),
};

const allowedKeys = Object.keys(requestFields);

const requestSchema = Type.Object(requestFields, { additionalProperties: false });

const requestChecks: [schema: TSchema, message: string][] = [
  [Type.Object({}), "Invalid browser request"],
  [Type.Refine(Type.Object({}), (value) => Object.keys(value).every((key) => allowedKeys.includes(key))), "Unsupported browser capability"],
  [Type.Object({ workspaceId: requestFields.workspaceId }), "Invalid workspaceId"],
  [Type.Object({ documentId: requestFields.documentId }), "Invalid documentId"],
  [Type.Object({ url: requestFields.url }), "Invalid url"],
  [Type.Object({ previewId: requestFields.previewId }), "Invalid preview"],
  [Type.Object({ generation: requestFields.generation, operation: requestFields.operation }), "Invalid browser operation"],
  [Type.Object({ target: requestFields.target }), "Invalid target"],
  [Type.Object({ text: requestFields.text }), "Invalid text"],
  [Type.Object({ route: requestFields.route }), "Invalid route"],
  [Type.Object({ x: requestFields.x }), "Invalid x"],
  [Type.Object({ y: requestFields.y }), "Invalid y"],
];

const targetedOperations: BrowserOperation[] = ["click", "type", "hover", "source"];

export function assertBrowserRequest(value: unknown): asserts value is BrowserRequest {
  for (const [schema, message] of requestChecks) if (!Check(schema, value)) throw new Error(message);

  if (!Check(requestSchema, value)) throw new Error("Invalid browser request");

  if (targetedOperations.includes(value.operation) && !value.target) throw new Error("Inspect first and use its document-scoped target ID");

  if (value.operation === "type" && value.text === undefined) throw new Error("Missing text");

  if (value.operation === "navigate" && value.route === undefined) throw new Error("Missing route");
}
