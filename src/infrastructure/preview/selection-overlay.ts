interface HoverTarget { element: Element; index: number; depth: number }

/** Isolated, non-interactive chrome: never changes the selected page's styles. */
export class SelectionOverlay {
  private host = document.createElement("div");
  private root: ShadowRoot;
  private hover = document.createElement("div");
  private label = document.createElement("div");
  private name = document.createElement("strong");
  private size = document.createElement("span");
  private hint = document.createElement("div");
  private markers = new Map<Element, HTMLDivElement>();

  constructor() {
    this.host.dataset.mauxiOverlay = "true";
    this.host.setAttribute("aria-hidden", "true");
    // Important host styles resist page-wide resets; shadow styles isolate children.
    this.host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;overflow:hidden!important;display:block!important;";
    this.root = this.host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      * { box-sizing: border-box; }
      .outline { position: absolute; pointer-events: none; border: 1.5px solid #218f90; border-radius: 4px; background: rgb(33 143 144 / 4%); }
      .selected { border: 2px solid #147a7a; background: rgb(33 143 144 / 2%); }
      .badge { position: absolute; top: 3px; right: 3px; max-width: calc(100% - 6px); overflow: hidden; padding: 3px 6px; border: 1px solid #d7e7e4; border-radius: 6px; background: #fff; color: #147a7a; font: 500 10px/1.4 system-ui, sans-serif; white-space: nowrap; }
      .label { position: absolute; width: max-content; max-width: calc(100% - 8px); padding: 8px 10px; border: 1px solid #e8e5e1; border-radius: 10px; background: #fff; color: #24242a; box-shadow: 0 2px 6px #181b220a, 0 8px 24px #181b2217; font: 400 12px/1.5 system-ui, sans-serif; pointer-events: none; }
      .summary { display: flex; align-items: center; gap: 10px; min-width: 0; }
      strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #147a7a; font-weight: 600; }
      .size { flex: none; color: #747178; font-size: 11px; }
      .hint { margin-top: 3px; color: #747178; font-size: 10px; overflow-wrap: anywhere; }
      [hidden] { display: none !important; }
    `;
    this.hover.className = "outline"; this.hover.dataset.mauxiHover = "true"; this.hover.hidden = true;
    this.label.className = "label"; this.label.dataset.mauxiPickerLabel = "true"; this.label.hidden = true;
    const summary = document.createElement("div"); summary.className = "summary";
    this.size.className = "size"; this.hint.className = "hint";
    summary.append(this.name, this.size); this.label.append(summary, this.hint);
    this.root.append(style, this.hover, this.label);
    document.documentElement.append(this.host);
  }

  private bounds(element: Element): DOMRect | null {
    if (!element.isConnected) return null;
    const bounds = element.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.right > 0 && bounds.top < innerHeight && bounds.left < innerWidth ? bounds : null;
  }

  private place(node: HTMLElement, bounds: DOMRect): void {
    Object.assign(node.style, { left: `${bounds.left}px`, top: `${bounds.top}px`, width: `${bounds.width}px`, height: `${bounds.height}px` });
  }

  render(hover: HoverTarget | null, selected: Iterable<Element>, hidden: boolean): void {
    // Hide all chrome together during screenshot capture; retain target identity.
    this.host.style.setProperty("visibility", hidden ? "hidden" : "visible", "important");
    const wanted = new Set([...selected].filter(element => element.isConnected));
    for (const [element, marker] of this.markers) {
      if (!wanted.has(element)) { marker.remove(); this.markers.delete(element); }
    }
    for (const element of wanted) {
      let marker = this.markers.get(element);
      if (!marker) {
        marker = document.createElement("div"); marker.className = "outline selected"; marker.dataset.mauxiSelected = "true";
        const badge = document.createElement("span"); badge.className = "badge"; badge.textContent = "Selected";
        marker.append(badge); this.root.insertBefore(marker, this.hover); this.markers.set(element, marker);
      }
      const bounds = this.bounds(element);
      marker.hidden = !bounds;
      if (bounds) {
        this.place(marker, bounds);
        // Don't cover tiny icons or narrow targets with a badge.
        (marker.firstElementChild as HTMLElement).hidden = bounds.width < 80 || bounds.height < 32;
      }
    }
    const bounds = hover && this.bounds(hover.element);
    this.hover.hidden = this.label.hidden = !bounds;
    if (!hover || !bounds) return;
    this.place(this.hover, bounds);
    this.name.textContent = hover.element.tagName.toLowerCase();
    this.size.textContent = `${Math.round(bounds.width)} × ${Math.round(bounds.height)}`;
    this.hint.textContent = `DOM ${hover.index + 1}/${Math.max(1, hover.depth)} · ↑↓ hierarchy · [ ] overlap · Enter attach`;
    const labelBounds = this.label.getBoundingClientRect();
    const left = Math.max(4, Math.min(bounds.left, innerWidth - labelBounds.width - 4));
    const top = bounds.top >= labelBounds.height + 10 ? bounds.top - labelBounds.height - 6 : Math.max(4, Math.min(bounds.bottom + 6, innerHeight - labelBounds.height - 4));
    Object.assign(this.label.style, { left: `${left}px`, top: `${top}px` });
  }
}
