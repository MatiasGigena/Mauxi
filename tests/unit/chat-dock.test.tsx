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
    expect(html).toContain('rows="1"');
    expect(html).toContain('class="model-picker"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('aria-haspopup="dialog"');
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

  it("retains a closed settings panel for exit and revives it on rapid reopen", () => {
    const panel = <section>Settings</section>;
    const props = { selections: [], onRemove: vi.fn(), children: null, panel };
    const composer = new SelectionComposer(props);
    const closed = SelectionComposer.getDerivedStateFromProps({ ...props, panel: null }, composer.state)!;
    expect(closed.panel).toBe(panel);
    expect(closed.panelExiting).toBe(true);
    const reopened = SelectionComposer.getDerivedStateFromProps(props, closed)!;
    expect(reopened.panel).toBe(panel);
    expect(reopened.panelExiting).toBe(false);
    const html = renderToStaticMarkup(<SelectionComposer {...props} />);
    expect(html).toContain('data-composer-motion="panel"');
  });

  it.each(["pointer", "keyboard", "reduced"])("shares badge and panel motion for %s interaction", (mode) => {
    const item = { capture: selectionCapture(), status: "current" as const, interaction: mode === "keyboard" ? "keyboard" as const : "pointer" as const };
    const panel = <section>Settings</section>;
    const props = { selections: [item], onRemove: vi.fn(), children: null, panel };
    const composer = new SelectionComposer(props);
    const rect = { left: 0, top: 0, bottom: 100, width: 200, height: 100 } as DOMRect;
    const animations: { cancel: ReturnType<typeof vi.fn>; onfinish?: () => void }[] = [];
    const nodes = [`badge:${item.capture.selectionId}`, "panel"].map(key => ({
      dataset: { composerMotion: key, exiting: "" }, style: {}, hasAttribute: () => false,
      getBoundingClientRect: () => rect,
      animate: vi.fn(() => {
        const animation = { cancel: vi.fn(), onfinish: undefined as (() => void) | undefined };
        animations.push(animation);
        return animation;
      }),
    }));
    const root = {
      querySelector: () => null,
      querySelectorAll: () => nodes,
      getBoundingClientRect: () => rect,
      clientLeft: 0, clientTop: 0,
    };
    Object.assign(composer, {
      root: { current: root }, surface: { current: { getBoundingClientRect: () => rect } },
      preference: { matches: mode === "reduced" }, keyboard: mode === "keyboard",
    });
    const setState = vi.spyOn(composer, "setState").mockImplementation(() => {});
    const before = { surface: rect, items: new Map(), focusedIndex: -1, panelFocused: false };
    composer.componentDidUpdate({ ...props, panel: null, selections: [] }, { source: [], entries: [] }, before);
    if (mode === "pointer") {
      const entrance = [
        [{ opacity: 0, transform: "translateY(15%) scale(.97)" }, { opacity: 1, transform: "none" }],
        { duration: 160, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
      ];
      nodes.forEach(node => expect(node.animate).toHaveBeenLastCalledWith(...entrance));
    } else {
      nodes.forEach(node => expect(node.animate).not.toHaveBeenCalled());
      expect(setState).toHaveBeenCalled();
    }

    const previous = composer.state;
    composer.state = SelectionComposer.getDerivedStateFromProps({ ...props, selections: [], panel: null }, previous)!;
    nodes.forEach(node => { node.dataset.exiting = "true"; });
    composer.componentDidUpdate(props, previous, {
      ...before, items: new Map(nodes.map(node => [node.dataset.composerMotion, { rect, opacity: 0.6 }])),
    });
    if (mode === "pointer") {
      const exit = [
        [{ opacity: 0.6, transform: "none" }, { opacity: 0, transform: "translateY(-12%) scale(.97)" }],
        { duration: 110, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
      ];
      nodes.forEach(node => expect(node.animate).toHaveBeenLastCalledWith(...exit));
      expect(animations[0].cancel).toHaveBeenCalled();
      expect(animations[1].cancel).toHaveBeenCalled();
      animations[3].onfinish!();
      const cleanup = setState.mock.calls.at(-1)![0] as (state: typeof composer.state) => typeof composer.state;
      expect(cleanup(composer.state).panel).toBeUndefined();
    } else {
      nodes.forEach(node => expect(node.animate).not.toHaveBeenCalled());
    }
  });

  it("keeps provider selection disabled without an open workspace", () => {
    expect(render()).toMatch(/class="model-picker"[^>]*disabled=""/);
    expect(render("workspace")).not.toMatch(/class="model-picker"[^>]*disabled=""/);
  });
});
