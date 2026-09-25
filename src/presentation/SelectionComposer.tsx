import { Component, createRef, type ReactNode } from "react";
import { X } from "lucide-react";
import type { StoredSelection } from "../application/selection-state";

const easeOut = "cubic-bezier(0.23, 1, 0.32, 1)";
const easeMove = "cubic-bezier(0.77, 0, 0.175, 1)";
type Entry = { item: StoredSelection; exiting: boolean };
type Props = { selections: StoredSelection[]; onRemove: (id: string) => void; children: ReactNode };
type State = { source: StoredSelection[]; entries: Entry[] };
type Appearance = { rect: DOMRect; opacity: number };
type Snapshot = { surface: DOMRect; badges: Map<string, Appearance>; composer?: DOMRect; focusedIndex: number };
const id = (entry: Entry) => entry.item.capture.selectionId;
const activeIds = (state: State) => state.entries.filter(entry => !entry.exiting).map(id).join("\n");

/** FLIP only the background and positions, never scale the editor or its text.
 * React's pre-mutation snapshot samples in-flight motion before an interruption.
 * Exiting badges are visual ghosts: attachments are removed from parent state immediately.
 */
export class SelectionComposer extends Component<Props, State, Snapshot | null> {
  state: State = { source: this.props.selections, entries: this.props.selections.map(item => ({ item, exiting: false })) };
  private root = createRef<HTMLElement>();
  private surface = createRef<HTMLDivElement>();
  private animations = new Set<Animation>();
  private preference?: MediaQueryList;
  private keyboard = false;

  static getDerivedStateFromProps(props: Props, state: State): State | null {
    if (props.selections === state.source) return null;
    const ids = new Set(props.selections.map(item => item.capture.selectionId));
    return { source: props.selections, entries: [
      ...props.selections.map(item => ({ item, exiting: false })),
      ...state.entries.filter(entry => !ids.has(id(entry))).map(entry => ({ ...entry, exiting: true })),
    ] };
  }

  componentDidMount() {
    this.preference = matchMedia("(prefers-reduced-motion: reduce)");
    this.preference.addEventListener("change", this.settle);
    window.addEventListener("resize", this.settle);
  }

  componentWillUnmount() {
    this.cancel();
    this.preference?.removeEventListener("change", this.settle);
    window.removeEventListener("resize", this.settle);
  }

  private cancel = () => {
    this.animations.forEach(animation => animation.cancel());
    this.animations.clear();
  };

  private settle = () => {
    this.cancel();
    this.setState(state => ({ entries: state.entries.filter(entry => !entry.exiting) }));
  };

  getSnapshotBeforeUpdate(_props: Props, previous: State): Snapshot | null {
    if (activeIds(previous) === activeIds(this.state) || !this.root.current || !this.surface.current) return null;
    const badges = new Map<string, Appearance>();
    this.root.current.querySelectorAll<HTMLElement>("[data-selection-id]").forEach(node => {
      badges.set(node.dataset.selectionId!, { rect: node.getBoundingClientRect(), opacity: Number(getComputedStyle(node).opacity) });
    });
    const focused = document.activeElement?.closest<HTMLElement>("[data-selection-id]")?.dataset.selectionId;
    return {
      surface: this.surface.current.getBoundingClientRect(), badges,
      composer: this.root.current.querySelector(".composer")?.getBoundingClientRect(),
      focusedIndex: previous.entries.filter(entry => !entry.exiting).findIndex(entry => id(entry) === focused),
    };
  }

  private animate(node: HTMLElement, frames: Keyframe[], duration: number, easing: string, done?: () => void) {
    const animation = node.animate(frames, { duration, easing });
    this.animations.add(animation);
    animation.onfinish = () => { this.animations.delete(animation); animation.cancel(); done?.(); };
  }

  componentDidUpdate(_props: Props, previous: State, before: Snapshot | null) {
    if (!before || !this.root.current || !this.surface.current) return;
    const root = this.root.current;
    const active = this.state.entries.filter(entry => !entry.exiting);
    const previousIds = new Set(previous.entries.filter(entry => !entry.exiting).map(id));
    const added = active.filter(entry => !previousIds.has(id(entry)));
    const instant = this.preference?.matches || (added.length ? added.some(entry => entry.item.interaction === "keyboard") : this.keyboard);
    this.cancel();

    // Removing a focused badge should not strand keyboard focus on the document.
    if (before.focusedIndex >= 0 && !root.contains(document.activeElement)) {
      const buttons = root.querySelectorAll<HTMLButtonElement>(".selection-list button");
      (buttons[Math.min(before.focusedIndex, buttons.length - 1)] ?? root.querySelector<HTMLTextAreaElement>("textarea"))?.focus({ preventScroll: true });
    }
    if (instant) { this.settle(); return; }

    const after = this.surface.current.getBoundingClientRect();
    const opening = after.height > before.surface.height;
    if (Math.abs(before.surface.height - after.height) > .5 || Math.abs(before.surface.bottom - after.bottom) > .5) {
      this.animate(this.surface.current, [
        { transform: `translateY(${before.surface.bottom - after.bottom}px) scaleY(${before.surface.height / after.height})` },
        { transform: "none" },
      ], opening ? 200 : 160, easeMove);
    }
    const composer = root.querySelector<HTMLElement>(".composer");
    if (composer && before.composer) {
      const delta = before.composer.top - composer.getBoundingClientRect().top;
      if (Math.abs(delta) > .5) this.animate(composer, [{ transform: `translateY(${delta}px)` }, { transform: "none" }], 200, easeMove);
    }
    const bounds = root.getBoundingClientRect();
    root.querySelectorAll<HTMLElement>("[data-selection-id]").forEach(node => {
      const key = node.dataset.selectionId!;
      const from = before.badges.get(key);
      if (node.dataset.exiting === "true") {
        if (!from) return;
        Object.assign(node.style, { left: `${from.rect.left - bounds.left - root.clientLeft}px`, top: `${from.rect.top - bounds.top - root.clientTop}px`, width: `${from.rect.width}px`, height: `${from.rect.height}px` });
        this.animate(node, [{ opacity: from.opacity, transform: "none" }, { opacity: 0, transform: "translateY(-12%) scale(.97)" }], 110, easeOut,
          () => this.setState(state => ({ entries: state.entries.filter(entry => id(entry) !== key || !entry.exiting) })));
      } else {
        const to = node.getBoundingClientRect();
        const transform = from ? `translate(${from.rect.left - to.left}px, ${from.rect.top - to.top}px) scale(${from.rect.width / to.width}, ${from.rect.height / to.height})` : "translateY(15%) scale(.97)";
        if (!from || from.opacity < 1 || Math.abs(from.rect.left - to.left) > .5 || Math.abs(from.rect.top - to.top) > .5) {
          this.animate(node, [{ opacity: from?.opacity ?? 0, transform }, { opacity: 1, transform: "none" }], 160, easeOut);
        }
      }
    });
  }

  private badge(entry: Entry) {
    const { item, exiting } = entry;
    const capture = item.capture;
    const label = capture.element.label || capture.element.tag;
    return <span key={capture.selectionId} className={`selection-badge ${exiting ? "selection-ghost" : "selection-chip"} ${item.status}`} data-selection-id={capture.selectionId} data-selection-preview={capture.previewId} data-exiting={exiting || undefined} title={`${label} · ${capture.previewId}${item.status === "stale" ? " · Select again before sending" : ""}`}>
      <span className="selection-label">{label}</span>
      {exiting
        ? <span className="selection-dismiss"><X size={12} aria-hidden="true" /></span>
        : <button className="selection-dismiss" type="button" aria-label={`Remove selection ${label}`} onClick={event => { this.keyboard = event.detail === 0; this.props.onRemove(capture.selectionId); }}><X size={12} aria-hidden="true" /></button>}
    </span>;
  }

  render() {
    const active = this.state.entries.filter(entry => !entry.exiting);
    return <section ref={this.root} className="chat-dock" aria-label="Chat" onKeyDownCapture={() => { this.keyboard = true; }} onPointerDownCapture={() => { this.keyboard = false; }}>
      <div ref={this.surface} className="chat-surface" aria-hidden="true" />
      <div className="chat-content">
        {active.length > 0 && <div className="selection-list" data-testid="selection-list" aria-label="Selected elements">{active.map(entry => this.badge(entry))}</div>}
        {this.props.children}
      </div>
      <div className="selection-exits" aria-hidden="true" inert>{this.state.entries.filter(entry => entry.exiting).map(entry => this.badge(entry))}</div>
    </section>;
  }
}
