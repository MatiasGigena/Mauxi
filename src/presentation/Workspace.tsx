import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BRIDGE_PROTOCOL,
  isBridgeMessage,
  type PreviewId,
  type SelectionCapture,
} from "../application/preview-contract";
import { markSelectionsAfterDocumentChange, type StoredSelection } from "../application/selection-state";
import type { ActiveWorkspace } from "../application/project-contract";

const SESSION = crypto.randomUUID();
const VIEWPORTS = {
  desktop: { width: 1440, height: 900, label: "Desktop" },
  mobile: { width: 390, height: 844, label: "Mobile" },
} as const;
const URLS = { vite: "http://127.0.0.1:45173", next: "http://127.0.0.1:45000" } as const;

type Fixture = keyof typeof URLS;
type BridgeCommand =
  | { kind: "selection-mode"; enabled: boolean }
  | { kind: "revalidate"; selectionId: string; fingerprint: SelectionCapture["fingerprint"] };
interface Runtime { generation: string; ready: boolean; reactGrab: boolean }
type Runtimes = Record<PreviewId, Runtime>;

function previewUrl(base: string, previewId: PreviewId): string {
  const url = new URL(base);
  url.searchParams.set("mauxiSession", SESSION);
  url.searchParams.set("mauxiPreview", previewId);
  url.searchParams.set("mauxiParent", location.origin === "file://" ? "null" : location.origin);
  return url.toString();
}

export function Workspace({ active, onClose }: { active?: ActiveWorkspace; onClose?: () => void }) {
  const [fixture, setFixture] = useState<Fixture>("vite");
  const [zoom, setZoom] = useState(0.55);
  const [selecting, setSelecting] = useState(false);
  const [activePreview, setActivePreview] = useState<PreviewId>("desktop");
  const [positions, setPositions] = useState({ desktop: { x: 34, y: 72 }, mobile: { x: 1518, y: 72 } });
  const [runtimes, setRuntimes] = useState<Runtimes>({ desktop: { generation: "", ready: false, reactGrab: false }, mobile: { generation: "", ready: false, reactGrab: false } });
  const [selections, setSelections] = useState<StoredSelection[]>([]);
  const [notice, setNotice] = useState("Preparing instrumented previews…");
  const frames = useRef<Record<PreviewId, HTMLIFrameElement | null>>({ desktop: null, mobile: null });
  const baseUrl = active?.origin ?? URLS[fixture];

  const origins = useMemo(() => new Set(active ? [new URL(active.origin).origin] : Object.values(URLS).map((value) => new URL(value).origin)), [active]);

  const send = useCallback((previewId: PreviewId, message: BridgeCommand) => {
    const runtime = runtimes[previewId];
    const frame = frames.current[previewId];
    if (!runtime.ready || !frame?.contentWindow) return;
    frame.contentWindow.postMessage({ ...message, protocol: BRIDGE_PROTOCOL, session: SESSION, generation: runtime.generation }, new URL(baseUrl).origin);
  }, [baseUrl, runtimes]);

  useEffect(() => {
    function onMessage(event: MessageEvent<unknown>) {
      if (!origins.has(event.origin)) return;
      let serialized = "";
      try { serialized = JSON.stringify(event.data); } catch { return; }
      if (serialized.length > 65_536 || !isBridgeMessage(event.data) || event.data.session !== SESSION) return;
      const previewId = (["desktop", "mobile"] as const).find((id) => frames.current[id]?.contentWindow === event.source);
      if (!previewId) return;
      const message = event.data;
      if (message.kind === "ready") {
        setRuntimes((current) => {
          const previous = current[previewId];
          if (previous.generation && previous.generation !== message.generation) {
            setSelections((items) => markSelectionsAfterDocumentChange(items, previewId, message.generation));
          }
          return { ...current, [previewId]: { generation: message.generation, ready: true, reactGrab: message.reactGrab } };
        });
        setNotice(`${active ? (active.framework === "vite" ? "Vite" : "Next.js") : (fixture === "vite" ? "Vite" : "Next.js")} bridge connected`);
        if (active && window.mauxi) {
          void window.mauxi.bridgeReady({ workspaceId: active.workspaceId, previewId, generation: message.generation, url: message.url });
        }
        return;
      }
      if (message.generation !== runtimes[previewId].generation) return;
      if (message.kind === "selection") {
        const capture: SelectionCapture = { ...message.capture, previewId };
        if (capture.source.filePath && window.mauxi) {
          const resolution = active
            ? window.mauxi.resolveSource({ workspaceId: active.workspaceId, hint: capture.source.filePath })
            : window.mauxi.resolveFixtureSource({ fixture, hint: capture.source.filePath });
          void resolution.then((resolved) => {
            if (!resolved) return;
            capture.source.filePath = resolved.filePath;
            capture.source.fileFingerprint = resolved.fileFingerprint;
            setSelections((items) => [...items]);
          });
        }
        setSelections((items) => [{ capture, status: "current" as const }, ...items].slice(0, 8));
        setNotice(capture.source.method === "unresolved" ? "Picked target; source is unresolved" : "Picked target with React source provenance");
        return;
      }
      if (message.kind === "revalidation") {
        setSelections((items) => items.map((item) => item.capture.selectionId === message.selectionId
          ? { ...item, status: message.status === "valid" ? "current" : "stale", staleReason: message.reason }
          : item));
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [active, fixture, origins, runtimes]);

  useEffect(() => {
    for (const id of ["desktop", "mobile"] as const) send(id, { kind: "selection-mode", enabled: selecting });
  }, [selecting, send]);

  function switchFixture(next: Fixture) {
    setFixture(next);
    setSelections((items) => items.map((item) => ({ ...item, status: "stale", staleReason: "The active fixture changed; pick this target again." })));
    setSelecting(false);
    setRuntimes({ desktop: { generation: "", ready: false, reactGrab: false }, mobile: { generation: "", ready: false, reactGrab: false } });
    setNotice(`Loading ${next === "vite" ? "React + Vite" : "Next.js App Router"}…`);
  }

  function startDrag(previewId: PreviewId, event: React.PointerEvent) {
    if (event.button !== 0) return;
    setActivePreview(previewId);
    event.currentTarget.setPointerCapture(event.pointerId);
    const start = { clientX: event.clientX, clientY: event.clientY, ...positions[previewId] };
    const move = (moveEvent: PointerEvent) => setPositions((current) => ({ ...current, [previewId]: { x: start.x + (moveEvent.clientX - start.clientX) / zoom, y: start.y + (moveEvent.clientY - start.clientY) / zoom } }));
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  }

  async function capture(previewId: PreviewId) {
    const frame = frames.current[previewId];
    if (!frame || !window.mauxi) { setNotice("Capture is available in the Electron proof host."); return; }
    const bounds = frame.getBoundingClientRect();
    const result = await window.mauxi.capturePreview({ workspaceId: active?.workspaceId, previewId, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
    setNotice(`Captured ${previewId} only · ${result.width}×${result.height}`);
  }

  function revalidate(item: StoredSelection) {
    const id = item.capture.previewId;
    send(id, { kind: "revalidate", selectionId: item.capture.selectionId, fingerprint: item.capture.fingerprint });
  }

  return (
    <div className="workspace">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">M</span><div><strong>Mauxi</strong><span>{active ? active.appRoot : "Core interaction proof"}</span></div></div>
        {!active && <div className="fixture-switch" aria-label="Fixture">
          <button className={fixture === "vite" ? "active" : ""} onClick={() => switchFixture("vite")}>Vite</button>
          <button className={fixture === "next" ? "active" : ""} onClick={() => switchFixture("next")}>Next.js</button>
        </div>}
        <div className="canvas-actions">
          <button data-testid="selection-toggle" className={selecting ? "accent active" : ""} onClick={() => setSelecting((value) => !value)}>{selecting ? "Selecting" : "Select"}</button>
          <label className="zoom"><span>{Math.round(zoom * 100)}%</span><input aria-label="Camera zoom" type="range" min="0.25" max="2" step="0.05" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} /></label>
          <button onClick={() => setZoom(0.55)}>Fit both</button>
        </div>
        <div className="connection"><i className={runtimes.desktop.ready && runtimes.mobile.ready ? "online" : ""} />{active?.statusDetail ?? notice}{active && <button className="close-project" onClick={onClose}>Close project</button>}</div>
      </header>

      <main className="canvas" data-testid="canvas">
        <div className="stage" style={{ transform: `scale(${zoom})` }}>
          {(["desktop", "mobile"] as const).map((id) => {
            const viewport = VIEWPORTS[id];
            return (
              <section key={`${active?.workspaceId ?? fixture}-${id}`} className="artboard" data-preview-id={id} style={{ left: positions[id].x, top: positions[id].y, width: viewport.width, zIndex: activePreview === id ? 2 : 1 }}>
                <header className="artboard-header" onPointerDown={(event) => startDrag(id, event)}>
                  <div><strong>{viewport.label}</strong><span>{viewport.width} × {viewport.height}</span></div>
                  <div className="artboard-actions"><span className={runtimes[id].ready ? "bridge-ready" : ""}>{runtimes[id].ready ? "Live" : "Connecting"}</span><button onPointerDown={(event) => event.stopPropagation()} onClick={() => capture(id)}>Capture</button></div>
                </header>
                <iframe
                  ref={(node) => { frames.current[id] = node; }}
                  data-testid={`${id}-preview`}
                  title={`${viewport.label} preview`}
                  src={previewUrl(baseUrl, id)}
                  width={viewport.width}
                  height={viewport.height}
                  sandbox="allow-scripts allow-forms allow-same-origin allow-modals"
                />
              </section>
            );
          })}
        </div>
      </main>

      <footer className="context-dock">
        <div className="dock-heading"><div><span className="eyebrow">SELECTION CONTEXT</span><strong>{selections.length ? `${selections.length} captured target${selections.length === 1 ? "" : "s"}` : "Pick an element from either live preview"}</strong></div><span>Camera zoom never changes the CSS viewport.</span></div>
        <div className="selection-list" data-testid="selection-list">
          {selections.length === 0 ? <p className="empty">Turn on Select, then click the nested arrow or button. Page actions are suppressed while picking.</p> : selections.map((item) => (
            <article className={`selection-chip ${item.status}`} key={item.capture.selectionId}>
              <div><span className="preview-pill">{item.capture.previewId}</span><strong>{item.capture.element.label}</strong><small>{item.capture.element.tag} · {item.capture.viewport.width}×{item.capture.viewport.height}</small></div>
              <code title={item.capture.source.filePath}>{item.capture.source.filePath ? `${item.capture.source.filePath.split(/[\\/]/).slice(-2).join("/")}:${item.capture.source.lineNumber ?? "?"}` : "Source unresolved"}</code>
              <span className="provenance">{item.status === "stale" ? "Stale" : item.capture.source.method}</span>
              <button onClick={() => revalidate(item)}>Revalidate</button>
              <button aria-label="Remove selection" onClick={() => setSelections((items) => items.filter((entry) => entry !== item))}>×</button>
            </article>
          ))}
        </div>
      </footer>
    </div>
  );
}
