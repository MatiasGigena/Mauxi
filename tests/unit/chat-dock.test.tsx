import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChatDock } from "../../src/presentation/ChatDock";
import { SelectionComposer } from "../../src/presentation/SelectionComposer";
import { selectionCapture } from "../fixtures/selection";

describe("minimal canvas composer", () => {
  function render(workspaceId?: string) {
    return renderToStaticMarkup(<ChatDock workspaceId={workspaceId} selections={[]} onRemove={vi.fn()} onBeforeSend={async () => ({ ok: true, selections: [] })} onSelectionsSent={vi.fn()} />);
  }

  it("renders a multiline composer without conversation, review, or resize chrome", () => {
    const html = render("workspace");
    expect(html).toContain('aria-label="Chat"');
    expect(html).toContain('rows="4"');
    expect(html).toContain('class="model-picker"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('class="primary" type="submit" disabled=""');
    expect(html).not.toContain("Conversation");
    expect(html).not.toContain('role="log"');
    expect(html).not.toContain("Resize chat");
    expect(html).not.toContain("change-review");
    expect(html).not.toContain("Explore both previews");
  });

  it("shows only a label and remove button for each selection", () => {
    const html = renderToStaticMarkup(<SelectionComposer selections={[{ capture: selectionCapture(), status: "current" }]} onRemove={vi.fn()}><textarea /></SelectionComposer>);
    expect(html).toContain("Run action");
    expect(html).toContain('aria-label="Remove selection Run action"');
    expect(html.match(/<button\b/g)).toHaveLength(1);
    for (const detail of ["Inspect", "Revalidate", "ProofCard.tsx", "verified JSX", "Screenshot crop", "selection-inspector"]) expect(html).not.toContain(detail);
  });

  it("retains removed badges only for exit and revives an interrupted removal without duplicates", () => {
    const item = { capture: selectionCapture(), status: "current" as const };
    const source = [item];
    const previous = { source, entries: [{ item, exiting: false }] };
    const removed = SelectionComposer.getDerivedStateFromProps({ selections: [], onRemove: vi.fn(), children: null }, previous)!;
    expect(removed.entries).toEqual([{ item, exiting: true }]);
    const restored = SelectionComposer.getDerivedStateFromProps({ selections: [item], onRemove: vi.fn(), children: null }, removed)!;
    expect(restored.entries).toEqual([{ item, exiting: false }]);
  });

  it("keeps provider selection disabled without an open workspace", () => {
    expect(render()).toMatch(/class="model-picker"[^>]*disabled=""/);
    expect(render("workspace")).not.toMatch(/class="model-picker"[^>]*disabled=""/);
  });
});
