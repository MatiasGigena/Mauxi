import { Children, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentChangeSetView } from "../../src/application/agent-contract";
import { changeDiff } from "../../src/infrastructure/agent/change-coordinator";
import { ChangeReview } from "../../src/presentation/ChatDock";

function record(id: string, state: AgentChangeSetView["state"], undoEligible: boolean): AgentChangeSetView {
  return { id, label: id, state, undoEligible, createdAt: "2026-01-01", files: [{ path: `${id}.txt`, kind: "modify", attribution: "managed", diff: "-before\n+after" }], errors: [], coverageWarnings: [], unexpectedPaths: [] };
}
function buttons(node: ReactNode): Array<{ onClick: (event: { preventDefault: () => void }) => void }> {
  return Children.toArray(node).flatMap((child) => {
    if (!isValidElement<{ children?: ReactNode; onClick: (event: { preventDefault: () => void }) => void }>(child)) return [];
    return child.type === "button" ? [child.props] : buttons(child.props.children);
  });
}

describe("change review undo targeting", () => {
  it("renders a bounded summary rather than a 2 MiB single-line UI payload", () => {
    const view = record("large", "settled", true);
    view.files[0].diff = changeDiff(null, "x".repeat(2 * 1024 * 1024));
    expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThan(1_000);
    const html = renderToStaticMarkup(ChangeReview({ changeSets: [view], idle: true, onUndo: vi.fn() }));
    expect(Buffer.byteLength(html)).toBeLessThan(2_000);
    expect(html).toContain("too large for inline review");
  });

  it.each(["undone", "failed", "conflicted"] as const)("shows and sends the older eligible ID behind a newer %s review", (state) => {
    const newer = record("newer-review", state, false);
    if (state === "failed") { newer.files = []; newer.errors = ["Failed without changes"]; }
    const onUndo = vi.fn();
    const tree = ChangeReview({ changeSets: [newer, record("actual-undo-target", "settled", true)], idle: true, onUndo });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("Changes · newer-review");
    expect(html).toContain("Undo target · actual-undo-target");
    expect(html).toContain("actual-undo-target.txt");
    const actions = buttons(tree); expect(actions).toHaveLength(1);
    actions[0].onClick({ preventDefault: vi.fn() });
    expect(onUndo).toHaveBeenCalledWith("actual-undo-target");
  });

  it("offers no undo while running or when command observations are ineligible", () => {
    expect(buttons(ChangeReview({ changeSets: [record("managed", "settled", true)], idle: false, onUndo: vi.fn() }))).toHaveLength(0);
    expect(buttons(ChangeReview({ changeSets: [record("command", "settled", false)], idle: true, onUndo: vi.fn() }))).toHaveLength(0);
  });
});
