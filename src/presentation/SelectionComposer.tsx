import { Component, createRef, type ReactNode } from "react";
import { X } from "lucide-react";
import type { StoredSelection } from "../application/selection-state";

const easeOut = "cubic-bezier(0.23, 1, 0.32, 1)";
const easeMove = "cubic-bezier(0.77, 0, 0.175, 1)";
type Entry = { item: StoredSelection; exiting: boolean };
type LoginView = (active: boolean) => ReactNode;
type Props = { selections: StoredSelection[]; onRemove: (id: string) => void; onActivate?: () => void; expansion?: string; contentSize?: string; panel?: ReactNode; login?: LoginView; children: ReactNode };
type State = { source: StoredSelection[]; entries: Entry[]; panel?: ReactNode; panelExiting?: boolean; login?: LoginView; loginExiting?: boolean };
type Appearance = { rect: DOMRect; opacity: number };
type Snapshot = { surface: DOMRect; items: Map<string, Appearance>; focusedIndex: number; panelFocused: boolean; editorFocused?: boolean };
const id = (entry: Entry) => entry.item.capture.selectionId;
const activeIds = (state: State) => state.entries.filter(entry => !entry.exiting).map(id).join("\n");

/** FLIP only the background and positions, never scale the editor or its text.
 * React's pre-mutation snapshot samples in-flight motion before an interruption.
 * Badges and the settings panel share entrance/exit motion and inert visual ghosts.
 * Attachments are removed from parent state immediately.
 */
export class SelectionComposer extends Component<Props, State, Snapshot | null> {
  state: State = { source: this.props.selections, entries: this.props.selections.map(item => ({ item, exiting: false })), panel: this.props.panel, panelExiting: false, login: this.props.login, loginExiting: false };
  private root = createRef<HTMLElement>();
  private surface = createRef<HTMLDivElement>();
  private animations = new Set<Animation>();
  private preference?: MediaQueryList;
  private keyboard = false;

  static getDerivedStateFromProps(props: Props, state: State): State | null {
    const panel = props.panel || state.panel;
    const panelExiting = !!panel && !props.panel;
    const login = props.login || state.login;
    const loginExiting = !!login && !props.login;
    if (props.selections === state.source && panel === state.panel && panelExiting === state.panelExiting && login === state.login && loginExiting === state.loginExiting) return null;
    const ids = new Set(props.selections.map(item => item.capture.selectionId));
    return { source: props.selections, entries: [
      ...props.selections.map(item => ({ item, exiting: false })),
      ...state.entries.filter(entry => !ids.has(id(entry))).map(entry => ({ ...entry, exiting: true })),
    ], panel, panelExiting, login, loginExiting };
  }

  componentDidMount() {
    this.preference = matchMedia("(prefers-reduced-motion: reduce)");
    this.preference.addEventListener("change", this.settle);
    window.addEventListener("resize", this.resize);
    this.fitEditor();
  }

  componentWillUnmount() {
    this.cancel();
    this.preference?.removeEventListener("change", this.settle);
    window.removeEventListener("resize", this.resize);
  }

  private cancel = () => {
    this.animations.forEach(animation => animation.cancel());
    this.animations.clear();
  };

  private settle = () => {
    this.cancel();
    this.root.current?.querySelectorAll<HTMLElement>('[data-retained-motion][data-exiting="true"]').forEach(node => { node.style.position = "fixed"; });
    this.setState(state => ({ entries: state.entries.filter(entry => !entry.exiting), panel: state.panelExiting ? undefined : state.panel, panelExiting: false, login: state.loginExiting ? undefined : state.login, loginExiting: false }));
  };

  private fitEditor = () => {
    const editor = this.root.current?.querySelector<HTMLTextAreaElement>(".composer textarea");
    if (!editor || editor.closest("[inert]")) return;
    // Reset before measuring so deletions shrink as well as additions grow.
    editor.style.height = "0px";
    editor.style.height = `${editor.scrollHeight}px`;
  };

  private resize = () => { this.fitEditor(); this.settle(); };

  getSnapshotBeforeUpdate(previousProps: Props, previous: State): Snapshot | null {
    const panelChanged = !!previousProps.panel !== !!this.props.panel || !!previousProps.login !== !!this.props.login;
    if ((activeIds(previous) === activeIds(this.state) && !panelChanged && previousProps.expansion === this.props.expansion && previousProps.contentSize === this.props.contentSize) || !this.root.current || !this.surface.current) return null;
    const items = new Map<string, Appearance>();
    this.root.current.querySelectorAll<HTMLElement>("[data-composer-motion]").forEach(node => {
      const opacity = Number(getComputedStyle(node).opacity);
      // Retained layers preserve drafts and provider scroll position. A settled
      // hidden layer is a fresh entrance; interrupted exits resume in place.
      if (node.hasAttribute("data-retained-motion") && node.dataset.exiting === "true" && opacity === 0) return;
      items.set(node.dataset.composerMotion!, { rect: node.getBoundingClientRect(), opacity });
    });
    const focused = document.activeElement?.closest<HTMLElement>("[data-selection-id]")?.dataset.selectionId;
    return {
      surface: this.surface.current.getBoundingClientRect(), items,
      panelFocused: !!this.root.current.querySelector(".composer-panel")?.contains(document.activeElement),
      editorFocused: !!this.root.current.querySelector(".composer-message")?.contains(document.activeElement),
      focusedIndex: previous.entries.filter(entry => !entry.exiting).findIndex(entry => id(entry) === focused),
    };
  }

  private animate(node: HTMLElement, frames: Keyframe[], duration: number, easing: string, done?: () => void) {
    const animation = node.animate(frames, { duration, easing });
    this.animations.add(animation);
    animation.onfinish = () => { this.animations.delete(animation); animation.cancel(); done?.(); };
  }

  componentDidUpdate(_props: Props, previous: State, before: Snapshot | null) {
    if (!before || !this.root.current || !this.surface.current) { this.fitEditor(); return; }
    const root = this.root.current;
    const active = this.state.entries.filter(entry => !entry.exiting);
    const previousIds = new Set(previous.entries.filter(entry => !entry.exiting).map(id));
    const added = active.filter(entry => !previousIds.has(id(entry)));
    const contentChanged = _props.contentSize !== this.props.contentSize;
    // Text growth is explicitly animated, including typing. Keep existing
    // keyboard-driven badge/panel interactions immediate.
    const instant = this.preference?.matches || (added.length ? added.some(entry => entry.item.interaction === "keyboard") : this.keyboard && !contentChanged);
    this.cancel();
    root.querySelectorAll<HTMLElement>("[data-retained-motion]").forEach(node => {
      if (node.dataset.exiting !== "true") {
        // Clear the exit's absolute geometry before measuring restored layout.
        Object.assign(node.style, { position: "", left: "", top: "", width: "", height: "" });
      }
    });

    this.fitEditor();

    // Removing a focused badge should not strand keyboard focus on the document.
    if (before.focusedIndex >= 0 && !root.contains(document.activeElement)) {
      const buttons = root.querySelectorAll<HTMLButtonElement>(".selection-list button");
      (buttons[Math.min(before.focusedIndex, buttons.length - 1)] ?? root.querySelector<HTMLTextAreaElement>("textarea"))?.focus({ preventScroll: true });
    }
    if (!this.props.login && ((before.panelFocused && this.state.panelExiting) || (before.editorFocused && this.props.panel))) {
      root.querySelector<HTMLButtonElement>(".model-picker")?.focus({ preventScroll: true });
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
    const bounds = root.getBoundingClientRect();
    root.querySelectorAll<HTMLElement>("[data-composer-motion]").forEach(node => {
      const key = node.dataset.composerMotion!;
      const from = before.items.get(key);
      if (node.dataset.exiting === "true") {
        if (!from) return;
        if (node.hasAttribute("data-retained-motion")) {
          const parent = node.offsetParent as HTMLElement;
          const origin = parent.getBoundingClientRect();
          Object.assign(node.style, { left: `${from.rect.left - origin.left - parent.clientLeft + parent.scrollLeft}px`, top: `${from.rect.top - origin.top - parent.clientTop + parent.scrollTop}px`, width: `${from.rect.width}px`, height: `${from.rect.height}px` });
          // WAAPI reveals inert layers only for their visual exit.
          this.animate(node, [{ visibility: "visible", opacity: from.opacity, transform: "none" }, { visibility: "visible", opacity: 0, transform: "translateY(-12%) scale(.97)" }], 110, easeOut,
            () => {
              // Invisible retained layers must not enlarge the chat's scroll area
              // after a resize/reflow. Fixed positioning preserves their internal
              // scroll state without leaving their old bounds in the layout.
              node.style.position = "fixed";
              if (key === "login") this.setState(state => ({ login: state.loginExiting ? undefined : state.login, loginExiting: false }));
            });
          return;
        }
        Object.assign(node.style, { left: `${from.rect.left - bounds.left - root.clientLeft}px`, top: `${from.rect.top - bounds.top - root.clientTop}px`, width: `${from.rect.width}px`, height: `${from.rect.height}px` });
        this.animate(node, [{ opacity: from.opacity, transform: "none" }, { opacity: 0, transform: "translateY(-12%) scale(.97)" }], 110, easeOut,
          () => this.setState(state => key === "panel"
            ? { ...state, panel: state.panelExiting ? undefined : state.panel, panelExiting: false }
            : { ...state, entries: state.entries.filter(entry => `badge:${id(entry)}` !== key || !entry.exiting) }));
      } else {
        const to = node.getBoundingClientRect();
        const textLayer = key === "editor" || key === "exchange" || key === "toolbar";
        const transform = from
          ? `translate(${from.rect.left - to.left}px, ${from.rect.top - to.top}px)${textLayer ? "" : ` scale(${from.rect.width / to.width}, ${from.rect.height / to.height})`}`
          : key === "exchange" ? "translateY(8px)" : "translateY(15%) scale(.97)";
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
    return <span key={capture.selectionId} className={`selection-badge ${exiting ? "selection-ghost" : "selection-chip"} ${item.status}`} data-composer-motion={`badge:${capture.selectionId}`} data-selection-id={capture.selectionId} data-selection-preview={capture.previewId} data-exiting={exiting || undefined} title={`${label} · ${capture.previewId}${item.status === "stale" ? " · Select again before sending" : ""}`}>
      <span className="selection-label">{label}</span>
      {exiting
        ? <span className="selection-dismiss"><X size={12} aria-hidden="true" /></span>
        : <button className="selection-dismiss" type="button" aria-label={`Remove selection ${label}`} onClick={event => { this.keyboard = event.detail === 0; this.props.onRemove(capture.selectionId); }}><X size={12} aria-hidden="true" /></button>}
    </span>;
  }

  private panel(exiting: boolean) {
    const hidden = !exiting && !!this.props.login;
    return <div className={`composer-panel${exiting ? " composer-panel-ghost" : ""}`} data-composer-motion="panel" data-retained-motion={exiting ? undefined : ""} data-exiting={exiting || hidden || undefined} inert={hidden} aria-hidden={hidden || undefined}>{this.state.panel}</div>;
  }

  render() {
    const active = this.state.entries.filter(entry => !entry.exiting);
    return <section ref={this.root} className="chat-dock" aria-label="Chat" onKeyDownCapture={() => { this.keyboard = true; }}
      onPointerDownCapture={() => { this.keyboard = false; this.props.onActivate?.(); }} onFocusCapture={() => this.props.onActivate?.()}>
      <div ref={this.surface} className="chat-surface" aria-hidden="true" />
      <div className="chat-content">
        {active.length > 0 && <div className="selection-list" data-testid="selection-list" aria-label="Selected elements">{active.map(entry => this.badge(entry))}</div>}
        {this.state.panel && !this.state.panelExiting && this.panel(false)}
        {this.state.login && <div className="composer-login" data-composer-motion="login" data-retained-motion="" data-exiting={this.state.loginExiting || undefined} inert={this.state.loginExiting} aria-hidden={this.state.loginExiting || undefined}>{this.state.login(!this.state.loginExiting)}</div>}
        {this.props.children}
      </div>
      <div className="selection-exits" aria-hidden="true" inert>
        {this.state.entries.filter(entry => entry.exiting).map(entry => this.badge(entry))}
        {this.state.panelExiting && this.panel(true)}
      </div>
    </section>;
  }
}
