import { Component, createRef, type ButtonHTMLAttributes } from "react";
import { ArrowUpRight, Square } from "lucide-react";

export const ACTION_LABELS = { send: "Send", followUp: "Follow up", stop: "Stop", checking: "Checking…", stopping: "Stopping…" } as const;
type Action = keyof typeof ACTION_LABELS;
type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & { action: Action; instant: boolean };

/** Only the active label sizes the button. FLIP the separate surface from its
 * sampled in-flight width; text never scales with the expanding background.
 */
export class ComposerAction extends Component<Props, {}, number | null> {
  private surface = createRef<HTMLSpanElement>();
  private animation?: Animation;
  private preference?: MediaQueryList;

  componentDidMount() {
    this.preference = matchMedia("(prefers-reduced-motion: reduce)");
    this.preference.addEventListener("change", this.cancel);
    window.addEventListener("resize", this.cancel);
  }

  componentWillUnmount() {
    this.cancel();
    this.preference?.removeEventListener("change", this.cancel);
    window.removeEventListener("resize", this.cancel);
  }

  private cancel = () => { this.animation?.cancel(); this.animation = undefined; };

  getSnapshotBeforeUpdate(previous: Props) {
    return previous.action !== this.props.action ? this.surface.current?.getBoundingClientRect().width ?? null : null;
  }

  componentDidUpdate(_previous: Props, _state: {}, before: number | null) {
    if (before === null) return;
    this.cancel();
    const surface = this.surface.current;
    if (!surface || this.props.instant || this.preference?.matches) return;
    const width = surface.getBoundingClientRect().width;
    if (!width || Math.abs(width - before) < .5) return;
    const animation = surface.animate([
      { transform: `scaleX(${before / width})` }, { transform: "none" },
    ], { duration: width > before ? 180 : 140, easing: "cubic-bezier(0.77, 0, 0.175, 1)" });
    this.animation = animation;
    animation.onfinish = () => { animation.cancel(); if (this.animation === animation) this.animation = undefined; };
  }

  render() {
    const { action, instant, ...props } = this.props;
    return <button className="primary send-action" {...props} aria-label={ACTION_LABELS[action]} data-action={action} data-instant={instant || undefined}>
      <span ref={this.surface} className="send-action-surface" aria-hidden="true" />
      <span className="send-action-content" aria-hidden="true">
        {(Object.keys(ACTION_LABELS) as Action[]).map(state => <span className="send-action-state" data-active={action === state} key={state}>
          <span>{ACTION_LABELS[state]}</span>{state === "stop" || state === "stopping" ? <Square size={14} fill="currentColor" strokeWidth={0} /> : <ArrowUpRight size={16} />}
        </span>)}
      </span>
    </button>;
  }
}
