import { Bot, Check, ChevronDown, Ellipsis, Eye, Layers, Maximize2, MousePointer2, PanelRightClose, RotateCcw, ScanSearch, SlidersHorizontal, ArrowUpRight, X } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { Bar, Collapse, Count, States, Stage, Stream, type Act, type Layout } from "./kit";
import logo from "../src/presentation/assets/logo-mauxi.png";
import "./mauxi-demo.css";

// The Mauxi main view, as one story: the responsive audit has found that the
// pricing page scrolls sideways on phones. Show at 360px narrows the live
// Mobile preview and outlines the plan grid; Fix with agent attaches the
// finding to chat; Send hands it to the agent, which stacks the cards (the
// live preview reflows) and re-runs the audit, so the bug moves to Resolved.
//
// Real strings: the project, the panel's title and route, the finding (title,
// criterion, element, source, direction, its two actions), the summary counts,
// what the chat says. The previewed storefront is filler: Mauxi shows someone
// else's page, so it is drawn in bars, with its plan cards whole.
//
// Icons: lucide-react, Mauxi's own icon pack, at the sizes the app uses.

type S = {
  /** Mobile preview resized to the failing width, finding outlined */
  shown: boolean;
  /** The finding is attached to chat */
  attached: boolean;
  /** The request is sent: the exchange opens over the composer */
  sent: boolean;
  /** Words of the agent's answer written so far */
  words: number;
  /** The fix landed: the plan cards stack in the live preview */
  fixed: boolean;
  /** The audit re-ran: the finding moves to Resolved */
  resolved: boolean;
};

const initial: S = { shown: false, attached: false, sent: false, words: 0, fixed: false, resolved: false };
const ANSWER = "Stacked the plan cards below 420px in PlanGrid.tsx, then re-ran the responsive audit: no horizontal scroll from 320 to 1920px.";
const WORDS = ANSWER.split(" ").length;
const POSTER: S = { shown: true, attached: true, sent: true, words: WORDS, fixed: true, resolved: true };
const FINDING = "Horizontal scroll at 320–414px";
const REST = { at: "rest", x: 0.5, y: 0.5 };

/** The canvas zoom: both previews are drawn in their own CSS pixels and scaled by it. */
const ZOOM = 0.6;

/** The phone-column design zooms out further so the preview fits beside nothing. */
const COMPACT_ZOOM = 0.45;

async function script(a: Act<S>) {
  await a.wait(900);

  // 1. Show the finding at its worst width: the live Mobile preview narrows to
  //    360px and the overflowing plan grid is outlined in place
  a.mark("show");
  await a.move({ at: "show", x: 0.8, y: 0.55 });
  await a.wait(200);
  await a.click();
  await a.set({ shown: true });
  await a.wait(1300);

  // 2. Hand it to the agent: the finding rides into chat as a chip
  a.mark("attach");
  await a.move({ at: "fix", x: 0.84, y: 0.55 });
  await a.wait(200);
  await a.click();
  await a.set({ attached: true });
  await a.wait(1000);

  // 3. Send: the request opens above the composer, the agent answers
  a.mark("send");
  await a.move({ at: "send", x: 0.78, y: 0.6 });
  await a.wait(200);
  await a.click();
  await a.set({ sent: true });
  void a.move(REST);
  await a.wait(900);

  for (let word = 1; word <= WORDS; word++) {
    await a.set({ words: word });
    await a.wait(55);

    // The edit lands while the agent is still describing it
    if (word === 6) void a.set({ fixed: true });
  }

  // 4. Payoff: the audit re-ran, the bug is resolved
  a.mark("resolved");
  await a.set({ resolved: true });
  await a.wait(2600);
}

function Artboard({ name, size, className, style, children }: { name: string; size: ReactNode; className: string; style?: CSSProperties; children: ReactNode }) {
  return <div className={`mx-board ${className}`} style={style}>
    <div className="mx-board-head">
      <div className="mx-board-grip"><span className="mx-board-name">{name}</span><span className="mx-board-size">{size}</span></div>
      <div className="mx-board-actions">
        <MousePointer2 size={16} aria-hidden />
        <Maximize2 size={16} aria-hidden />
        <Ellipsis size={16} aria-hidden />
      </div>
    </div>
    <div className="mx-board-body" data-crop>{children}</div>
  </div>;
}

/** One plan card of the previewed storefront: a name, a price, three features, a button. */
function Plan({ tone }: { tone: "plain" | "featured" }) {
  return <div className="mx-plan" data-tone={tone}>
    <Bar w={44} h={9} tone={tone === "featured" ? 4 : 3} />
    <Bar w={64} h={22} r={4} tone={5} className="mx-plan-price" />
    <div className="mx-plan-lines"><Bar w={78} h={7} tone={2} /><Bar w={62} h={7} tone={2} /><Bar w={70} h={7} tone={2} /></div>
    <span className="mx-plan-cta" />
  </div>;
}

/** The storefront's /pricing page at a phone width, drawn in its own CSS pixels and scaled by the canvas zoom. */
function Storefront({ s, width }: { s: S; width: number }) {
  return <div className="mx-site" style={{ width }} data-fixed={s.fixed || undefined}>
    <div className="mx-site-nav"><Bar w={74} h={14} r={4} tone={5} /><span className="mx-site-menu"><i /><i /><i /></span></div>
    <div className="mx-site-head"><Bar w={196} h={22} r={5} tone={5} /><Bar w={262} h={9} tone={2} /></div>
    <div className="mx-plans">
      <Plan tone="plain" />
      <Plan tone="featured" />
      <Plan tone="plain" />
      <div className="mx-marker" data-show={(s.shown && !s.fixed) || undefined}><span>1</span></div>
    </div>
  </div>;
}

function DesktopSite() {
  return <div className="mx-site mx-site--desktop">
    <div className="mx-site-nav"><Bar w={80} h={14} r={4} tone={5} /><span className="mx-site-links"><Bar w={46} h={9} tone={3} /><Bar w={52} h={9} tone={3} /><Bar w={40} h={9} tone={3} /><span className="mx-site-signin" /></span></div>
    <div className="mx-site-head mx-site-head--center"><Bar w={420} h={30} r={6} tone={5} /><Bar w={520} h={10} tone={2} /></div>
    <div className="mx-plans mx-plans--desktop"><Plan tone="plain" /><Plan tone="featured" /><Plan tone="plain" /></div>
  </div>;
}

function Ruler({ shown, ticks = false }: { shown: boolean; ticks?: boolean }) {
  // 320–414px of the 320–1920px ruler
  return <div className="mx-ruler">
    <div className="mx-ruler-track"><span className="mx-ruler-range" data-show={shown || undefined} style={{ left: 0, width: `${((414 - 320) / 1600) * 100}%` }} /></div>
    {ticks && <div className="mx-ruler-ticks">{[320, 768, 1280, 1920].map((tick) => <span key={tick} style={{ left: `${((tick - 320) / 1600) * 100}%` }}>{tick}</span>)}</div>}
  </div>;
}

function AuditPanel({ s, compact }: { s: S; compact: boolean }) {
  return <div className="mx-panel">
    <div className="mx-panel-head">
      <div>
        <div className="mx-panel-title"><ScanSearch size={16} aria-hidden />Responsive audit</div>
        <div className="mx-panel-sub"><code>/pricing</code> · 41 widths · 6.2s</div>
      </div>
      <div className="mx-panel-actions">
        <span className="mx-round"><Layers size={15} aria-hidden /></span>
        <span className="mx-run"><RotateCcw size={14} aria-hidden />Re-run</span>
        <span className="mx-close"><PanelRightClose size={16} aria-hidden /></span>
      </div>
    </div>

    <div className="mx-overview">
      <Ruler shown={!s.resolved} ticks />
      <div className="mx-summary">
        <div data-kind="bug"><span>Bugs</span><Count value={s.resolved ? 0 : 1} /></div>
        <div data-kind="review"><span>Review</span><Count value={2} /></div>
        <div data-kind="intentional"><span>Intentional</span><Count value={1} /></div>
        <div data-kind="resolved"><span>Resolved</span><Count value={s.resolved ? 1 : 0} /></div>
      </div>
    </div>

    <div className="mx-findings" data-crop>
      <Collapse open={s.resolved} reveal="drop">
        <div className="mx-group mx-group--resolved">
          <div className="mx-group-title"><Check size={14} aria-hidden />Resolved since last run<span>1</span></div>
          <div className="mx-resolved-row"><Check size={12} aria-hidden /><span>{FINDING}</span></div>
        </div>
      </Collapse>

      <Collapse open={!s.resolved}>
        <div className="mx-group">
          <div className="mx-group-title">Bugs<span>1</span></div>
          <div className="mx-card" data-selected>
            <div className="mx-card-summary">
              <span className="mx-index">1</span>
              <div className="mx-card-heading">
                <strong>{FINDING}</strong>
                <div className="mx-meta"><span>WCAG 1.4.10 Reflow</span><span className="mx-severity">serious</span></div>
              </div>
              <ChevronDown size={14} className="mx-chevron" aria-hidden />
            </div>
            <Ruler shown />
            <div className="mx-card-body">
              <div className="mx-element"><code>div.plan-grid</code><span>PlanGrid · src/PlanGrid.tsx:18<Check size={12} aria-hidden /></span></div>
              <div className="mx-direction"><strong>Direction:</strong> let the cards wrap or stack below 420px instead of keeping three fixed columns.</div>
              <div className="mx-actions">
                <span className="mx-action" data-target="show" data-active={s.shown || undefined}><Eye size={14} aria-hidden />Show at 360px</span>
                <span className="mx-action mx-action--fix" data-target="fix" data-attached={s.attached || undefined}>
                  <States value={s.attached ? "attached" : "fix"} align="center" states={{
                    fix: <span className="mx-action-label"><Bot size={14} aria-hidden />Fix with agent</span>,
                    attached: <span className="mx-action-label"><Bot size={14} aria-hidden />Attached to chat</span>,
                  }} />
                </span>
              </div>
            </div>
          </div>
        </div>
      </Collapse>

      {/* The phone column shows the review queue only once the bug has left it */}
      <Collapse open={!compact || s.resolved}>
      <div className="mx-group">
        <div className="mx-group-title">Needs review<span>2</span></div>
        <div className="mx-card mx-card--closed" data-severity="moderate">
          <div className="mx-card-summary">
            <span className="mx-index">2</span>
            <div className="mx-card-heading">
              <strong>Touch target smaller than 24×24px</strong>
              <div className="mx-meta"><span>WCAG 2.5.8 Target size</span><span className="mx-severity">moderate</span></div>
            </div>
            <ChevronDown size={14} className="mx-chevron" aria-hidden />
          </div>
          <div className="mx-ruler"><div className="mx-ruler-track"><span className="mx-ruler-range" data-show style={{ left: 0, width: "28%" }} /></div></div>
        </div>
        <div className="mx-card mx-card--closed mx-card--third" data-severity="moderate">
          <div className="mx-card-summary">
            <span className="mx-index">3</span>
            <div className="mx-card-heading">
              <strong>Text truncated at narrow widths</strong>
              <div className="mx-meta"><span>Responsive layout</span><span className="mx-severity">moderate</span></div>
            </div>
            <ChevronDown size={14} className="mx-chevron" aria-hidden />
          </div>
        </div>
      </div>
      </Collapse>
    </div>
  </div>;
}

function Chip() {
  return <span className="mx-chip"><span className="mx-chip-dot" /><span className="mx-chip-label">{FINDING}</span><X size={12} aria-hidden /></span>;
}

function ChatDock({ s, compact }: { s: S; compact: boolean }) {
  return <div className="mx-dock">
    <Collapse open={s.sent} reveal="drop">
      <div className="mx-exchange">
        <div className="mx-prompt"><div className="mx-role">You</div><Chip /></div>
        <div className="mx-response">
          <div className="mx-role mx-role--agent">Agent</div>
          <States value={s.words ? "answer" : "working"} align="start" states={{
            working: <span className="mx-working">Working…</span>,
            answer: <Stream className="mx-answer" text={ANSWER} count={s.words} />,
          }} />
        </div>
      </div>
    </Collapse>
    <Collapse open={s.attached && !s.sent} reveal="drop">
      <div className="mx-chips"><Chip /></div>
    </Collapse>
    <Collapse open={!(compact && s.sent)}>
    <div className="mx-input">
      <States value={s.sent ? "follow" : s.attached ? "attached" : "empty"} align="start" states={{
        empty: <span>Ask about a finding or describe a responsive fix…</span>,
        attached: <span>Send to fix the attached findings, or add instructions…</span>,
        follow: <span>Ask a follow-up…</span>,
      }} />
    </div>
    <div className="mx-toolbar">
      <span className="mx-model"><SlidersHorizontal size={14} aria-hidden />Models &amp; providers<ChevronDown size={13} aria-hidden /></span>
      <span className="mx-send" data-target="send" data-ready={(s.attached && !s.sent) || undefined}>Send<ArrowUpRight size={16} aria-hidden /></span>
    </div>
    </Collapse>
  </div>;
}

function Scene({ s, layout }: { s: S; layout: Layout }) {
  const width = s.shown ? 360 : 390;
  const zoom = layout === "compact" ? COMPACT_ZOOM : ZOOM;

  return <div className="mx-workspace" data-layout={layout}>
    <div className="mx-grid" />
    <Artboard name="Desktop" size="1440 × 900" className="mx-board--desktop"><DesktopSite /></Artboard>
    <Artboard name="Mobile" size={<span className="mx-size"><Count value={width} format={(n) => String(Math.round(n))} /> × 844</span>} className="mx-board--mobile" style={{ width: width * zoom }}>
      <Storefront s={s} width={width} />
    </Artboard>
    <span className="mx-rest" data-target="rest" />

    <div className="mx-topbar">
      <span className="mx-pill mx-brand"><img src={logo} alt="" /><strong>storefront</strong><ChevronDown size={13} aria-hidden /></span>
      <span className="mx-pill mx-zoom"><span>{zoom * 100}%</span><span className="mx-slider"><i /></span></span>
    </div>

    <AuditPanel s={s} compact={layout === "compact"} />
    <ChatDock s={s} compact={layout === "compact"} />
  </div>;
}

export default function MauxiDemo() {
  return <Stage
    width={1080}
    height={680}
    compact={{ below: 760, width: 358, height: 640 }}
    play="once"
    accent="#218f90"
    initial={initial}
    poster={POSTER}
    script={script}
    cursor={{ at: REST }}
    className="mx"
  >
    {(s, _rect, layout) => <Scene s={s} layout={layout} />}
  </Stage>;
}
