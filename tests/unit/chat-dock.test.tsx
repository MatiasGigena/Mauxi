import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChatDock } from "../../src/presentation/ChatDock";

describe("minimal canvas composer", () => {
  function render(workspaceId?: string) {
    return renderToStaticMarkup(<ChatDock workspaceId={workspaceId} selections={[]} onRemove={vi.fn()} onBeforeSend={async () => ({ ok: true, selections: [] })} onSelectionsSent={vi.fn()} />);
  }

  it("keeps provider selection disabled without an open workspace", () => {
    expect(render()).toMatch(/class="model-picker"[^>]*disabled=""/);
    expect(render("workspace")).not.toMatch(/class="model-picker"[^>]*disabled=""/);
  });
});
