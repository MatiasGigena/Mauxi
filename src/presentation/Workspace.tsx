import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { BRIDGE_PROTOCOL, isBridgeMessage, type PreviewId, type SelectionCapture, type ShellToBridgeMessage } from "../application/preview-contract";
import { defaultCanvas, dragBoard, fitCamera, HEADER_HEIGHT, HEADER_WIDTH, LABELS, PREVIEW_IDS, unfocus, zoomAt, type CanvasState } from "../application/canvas-state";
import { projectRoute, RouteLink, supportedRoute, type RouteCommand } from "../application/route-link";
import { markSelectionsAfterDocumentChange, markSelectionsAfterRouteChange, type StoredSelection } from "../application/selection-state";
import { selectionCropToShell } from "../application/selection-geometry";
import type { ActiveWorkspace } from "../application/project-contract";
import { ChatDock } from "./ChatDock";
import { PreviewTools } from "./PreviewTools";
import { BrowserControlBar, useBrowserControl } from "./BrowserControl";

const URLS = { vite: "http://127.0.0.1:45173", next: "http://127.0.0.1:45000" } as const;
type Fixture = keyof typeof URLS;
type Command = ShellToBridgeMessage extends infer T ? T extends ShellToBridgeMessage ? Omit<T, "protocol" | "session" | "generation"> : never : never;
interface Runtime { generation: string; ready: boolean; route: string; safe: boolean }
const emptyRuntimes = (): Record<PreviewId, Runtime> => ({ desktop: { generation: "", ready: false, route: "", safe: false }, mobile: { generation: "", ready: false, route: "", safe: false } });
function previewUrl(base: string, id: PreviewId, session: string): string {
  const url = new URL(base);
  url.searchParams.set("mauxiSession", session); url.searchParams.set("mauxiPreview", id); url.searchParams.set("mauxiParent", location.origin);
  return url.toString();
}

export function Workspace({ active, onClose }: { active?: ActiveWorkspace; onClose?: () => void }) {
  const browser = useBrowserControl(active?.workspaceId);
  const browserLocked = useRef(false); browserLocked.current = browser.locked;
  const [fixture, setFixture] = useState<Fixture>("vite");
  // Changing projects/fixtures creates a fresh bridge capability, not on focus/zoom.
  const session = useMemo(() => crypto.randomUUID(), [active?.workspaceId, fixture]);
  const [layout, setLayout] = useState<CanvasState>(() => active?.canvas ?? defaultCanvas());
  const layoutRef = useRef(layout); layoutRef.current = layout;
  const [hand, setHand] = useState(false);
  const [selecting, setSelecting] = useState<PreviewId | null>(null);
  const [activePreview, setActivePreview] = useState<PreviewId>("desktop");
  const [tools, setTools] = useState<PreviewId | null>(null);
  const [runtimes, setRuntimes] = useState(emptyRuntimes);
  const runtimeRef = useRef(runtimes);
  const [selections, setSelections] = useState<StoredSelection[]>([]);
  const selectionsRef = useRef(selections); selectionsRef.current = selections;
  const pendingRevalidations = useRef(new Map<string, (status: "valid" | "stale") => void>());
  const [notice, setNotice] = useState("");
  const [bridgeDetail, setBridgeDetail] = useState("Preparing instrumented previews…");
  const [dragging, setDragging] = useState(false);
  const frames = useRef<Record<PreviewId, HTMLIFrameElement | null>>({ desktop: null, mobile: null });
  const canvas = useRef<HTMLElement>(null);
  const initialFit = useRef(!active?.canvas);
  const geometry = useRef({ width: 1000, height: 600, headerHeight: HEADER_HEIGHT, headerWidth: HEADER_WIDTH });
  const drag = useRef<{ id: PreviewId | null; x: number; y: number; state: CanvasState } | null>(null);
  const baseUrl = active?.origin ?? URLS[fixture];
  const origin = new URL(baseUrl).origin;
  const routes = useMemo(() => new RouteLink(origin), [origin, session]);
  const urls = useMemo(() => ({ desktop: previewUrl(baseUrl, "desktop", session), mobile: previewUrl(baseUrl, "mobile", session) }), [baseUrl, session]);

  const send = useCallback((id: PreviewId, message: Command) => {
    const runtime = runtimeRef.current[id];
    if (!runtime.ready) return;
    frames.current[id]?.contentWindow?.postMessage({ ...message, protocol: BRIDGE_PROTOCOL, session, generation: runtime.generation }, origin);
  }, [origin, session]);
  const navigate = useCallback((command: RouteCommand | null) => {
    if (command) send(command.previewId, { kind: "navigate", route: command.route, navigationId: command.navigationId });
  }, [send]);

  useEffect(() => {
    const observer = new ResizeObserver(() => {
      if (!canvas.current) return;
      const rootSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
      geometry.current = { width: canvas.current.clientWidth, height: canvas.current.clientHeight, headerHeight: rootSize * 3, headerWidth: rootSize * 15 };
      if (initialFit.current) {
        initialFit.current = false;
        setLayout((current) => ({ ...current, camera: fitCamera(Object.values(current.boards), geometry.current, geometry.current.headerHeight, geometry.current.headerWidth) }));
      } else if (layoutRef.current.focus) {
        setLayout((current) => ({ ...current, camera: fitCamera([current.boards[current.focus!.previewId]], geometry.current, geometry.current.headerHeight, geometry.current.headerWidth) }));
      }
    });
    if (canvas.current) observer.observe(canvas.current);
    return () => observer.disconnect();
  }, []);

  const persist = useCallback(async (state: CanvasState) => {
    if (!active || !window.mauxi) return;
    try { await window.mauxi.saveCanvas({ workspaceId: active.workspaceId, canvas: state }); }
    catch (error) { setNotice(`Layout not saved: ${String(error)}`); }
  }, [active?.workspaceId]);
  useEffect(() => {
    if (dragging) return;
    const timer = setTimeout(() => { void persist(layout); }, 150);
    return () => clearTimeout(timer);
  }, [layout, dragging, persist]);

  useEffect(() => {
    function onMessage(event: MessageEvent<unknown>) {
      if (event.origin !== origin) return;
      try { if (JSON.stringify(event.data).length > 65_536) return; } catch { return; }
      if (!isBridgeMessage(event.data) || event.data.session !== session) return;
      const id = PREVIEW_IDS.find((id) => frames.current[id]?.contentWindow === event.source);
      if (!id) return;
      const message = event.data;
      if (message.kind === "ready") {
        if (projectRoute(message.url, origin) === null) return;
        const previous = runtimeRef.current[id];
        if (previous.generation && previous.generation !== message.generation) setSelections((items) => markSelectionsAfterDocumentChange(items, id, message.generation));
        runtimeRef.current = { ...runtimeRef.current, [id]: { ...previous, generation: message.generation, ready: true, route: projectRoute(message.url, origin)! } };
        setRuntimes(runtimeRef.current);
        setBridgeDetail(`${active?.framework === "next" || fixture === "next" ? "Next.js" : "Vite"} bridge connected`);
        if (active && window.mauxi) void window.mauxi.bridgeReady({ workspaceId: active.workspaceId, previewId: id, generation: message.generation, url: message.url }).catch((error) => setNotice(String(error)));
        return;
      }
      if (message.generation !== runtimeRef.current[id].generation) return;
      if (browserLocked.current && ["selection", "selection-cancelled", "revalidation"].includes(message.kind)) return;
      if (message.kind === "selection-cancelled") { setSelecting(null); if (active) void browser.owner("human"); return; }
      if (message.kind === "navigation-blocked") { if (active) void browser.owner("human"); setNotice("External navigation blocked. Browser control returned; previews stay within the approved project origin."); return; }
      if (message.kind === "route") {
        const route = projectRoute(message.url, origin);
        if (route === null) return;
        if (runtimeRef.current[id].route && runtimeRef.current[id].route !== route) {
          setSelections((items) => markSelectionsAfterRouteChange(items, id));
        }
        runtimeRef.current = { ...runtimeRef.current, [id]: { ...runtimeRef.current[id], route, safe: message.safe } };
        setRuntimes(runtimeRef.current);
        navigate(routes.observe(id, message.url, message.navigationId, !browserLocked.current && layoutRef.current.linked && PREVIEW_IDS.every((id) => runtimeRef.current[id].ready), message.safe));
        return;
      }
      if (message.kind === "selection") {
        const libraryPath = /(^|[\\/])(?:node_modules|next[\\/]dist|react-dom)([\\/]|$)/i.test(message.capture.source.filePath);
        const capture: SelectionCapture = {
          ...message.capture,
          workspaceId: active?.workspaceId ?? `proof:${fixture}:${session}`,
          previewId: id,
          source: {
            ...message.capture.source,
            fileFingerprint: null,
            ownership: libraryPath ? "library" : "unknown",
            verification: libraryPath ? "library" : message.capture.source.filePath ? "unverified" : "missing-or-ambiguous",
            role: "unknown",
          },
          componentOwners: message.capture.componentOwners.map((owner) => ({
            ...owner,
            ownership: owner.filePath && /(^|[\\/])(?:node_modules|next[\\/]dist|react-dom)([\\/]|$)/i.test(owner.filePath) ? "library" : "unknown",
          })),
          screenshot: { status: "pending", crop: message.capture.screenshot.crop },
        };
        if (capture.documentGeneration !== message.generation || projectRoute(capture.url, origin) !== runtimeRef.current[id].route) return;
        setSelections((items) => [{ capture, status: "current" as const }, ...items].slice(0, 8));
        if (capture.source.filePath && capture.source.ownership !== "library" && window.mauxi) {
          const input = {
            hint: capture.source.filePath, lineNumber: capture.source.lineNumber, columnNumber: capture.source.columnNumber,
            locator: { tag: capture.element.tag, testIds: [...new Set(capture.domAncestry.flatMap((entry) => entry.testId ? [entry.testId] : []))].slice(0, 12) },
          };
          const resolution = active ? window.mauxi.resolveSource({ workspaceId: active.workspaceId, ...input }) : window.mauxi.resolveFixtureSource({ fixture, ...input });
          void resolution.then((resolved) => {
            setSelections((items) => items.map((item) => {
              if (item.capture.selectionId !== capture.selectionId) return item;
              const source = resolved
                ? { ...item.capture.source, ...resolved, ownership: "application" as const, verification: "verified" as const, role: "jsx-element" as const }
                : { ...item.capture.source, fileFingerprint: null, verification: "missing-or-ambiguous" as const };
              const fingerprint = resolved ? { ...item.capture.fingerprint, sourceKey: `${resolved.filePath}:${source.lineNumber ?? "?"}:${source.columnNumber ?? "?"}` } : item.capture.fingerprint;
              return { ...item, capture: { ...item.capture, source, fingerprint } };
            }));
          }).catch((error) => {
            setSelections((items) => items.map((item) => item.capture.selectionId === capture.selectionId
              ? { ...item, capture: { ...item.capture, source: { ...item.capture.source, verification: "missing-or-ambiguous" as const } } }
              : item));
            setNotice(`Source unavailable: ${String(error)}`);
          });
        } else if (capture.source.verification === "unverified") {
          setSelections((items) => items.map((item) => item.capture.selectionId === capture.selectionId
            ? { ...item, capture: { ...item.capture, source: { ...item.capture.source, verification: "missing-or-ambiguous" as const } } }
            : item));
        }
        void captureSelectionScreenshot(capture);
        setNotice(capture.support.status === "unsupported" ? capture.support.reason ?? "Unsupported selection attached" : "Target attached · no page action replayed");
      } else if (message.kind === "revalidation") {
        setSelections((items) => items.map((item) => item.capture.selectionId === message.selectionId && item.capture.previewId === id && !item.requiresRepick ? { ...item, status: message.status === "valid" ? "current" : "stale", staleReason: message.reason } : item));
        pendingRevalidations.current.get(message.selectionId)?.(message.status);
        pendingRevalidations.current.delete(message.selectionId);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [active, fixture, origin, session, routes, navigate]);

  useEffect(() => { for (const id of PREVIEW_IDS) send(id, { kind: "selection-mode", enabled: selecting === id && !hand }); }, [selecting, hand, runtimes, send]);
  useEffect(() => {
    if (!selecting || hand) return;
    const onPickerKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable)) return;
      const action = event.key === "ArrowUp" ? "parent" : event.key === "ArrowDown" ? "child"
        : event.key === "]" ? "overlap-next" : event.key === "[" ? "overlap-previous" : event.key === "Enter" ? "attach" : null;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setSelecting(null); if (active) void browser.owner("human"); return; }
      if (!action) return;
      event.preventDefault(); event.stopPropagation(); send(selecting, { kind: "picker-refine", action });
    };
    window.addEventListener("keydown", onPickerKey, true);
    return () => window.removeEventListener("keydown", onPickerKey, true);
  }, [selecting, hand, send]);

  function fit(ids: readonly PreviewId[] = PREVIEW_IDS) {
    setLayout((current) => { const next = unfocus(current); return { ...next, camera: fitCamera(ids.map((id) => next.boards[id]), geometry.current, geometry.current.headerHeight, geometry.current.headerWidth) }; });
  }
  function focus(id: PreviewId) {
    setLayout((current) => {
      const restored = unfocus(current);
      if (current.focus?.previewId === id) return restored;
      return { ...restored, focus: { previewId: id, camera: restored.camera, positions: { desktop: { x: restored.boards.desktop.x, y: restored.boards.desktop.y }, mobile: { x: restored.boards.mobile.x, y: restored.boards.mobile.y } } }, camera: fitCamera([restored.boards[id]], geometry.current, geometry.current.headerHeight, geometry.current.headerWidth) };
    });
    setActivePreview(id);
  }
  function changeZoom(zoom: number) {
    setLayout((current) => ({ ...current, camera: zoomAt(current.camera, zoom, { x: geometry.current.width / 2, y: geometry.current.height / 2 }) }));
  }
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (browserLocked.current) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
      const rect = element.getBoundingClientRect();
      setLayout((current) => ({ ...current, camera: event.ctrlKey || event.metaKey ? zoomAt(current.camera, current.camera.zoom * Math.exp(-event.deltaY * unit * .005), { x: event.clientX - rect.x, y: event.clientY - rect.y }) : { ...current.camera, x: current.camera.x - event.deltaX * unit, y: current.camera.y - event.deltaY * unit } }));
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);

  function startDrag(id: PreviewId | null, event: ReactPointerEvent) {
    if (browserLocked.current || (event.button !== 0 && event.button !== 1)) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id, x: event.clientX, y: event.clientY, state: layoutRef.current };
    setDragging(true); if (id) setActivePreview(id);
  }
  function moveDrag(event: ReactPointerEvent) {
    const start = drag.current; if (!start) return;
    const delta = { x: event.clientX - start.x, y: event.clientY - start.y };
    setLayout((current) => start.id ? { ...current, boards: { ...current.boards, [start.id]: dragBoard(start.state.boards[start.id], delta, start.state.camera.zoom) } } : { ...current, camera: { ...start.state.camera, x: start.state.camera.x + delta.x, y: start.state.camera.y + delta.y } });
  }
  function endDrag() { drag.current = null; setDragging(false); }
  function switchFixture(next: Fixture) {
    if (next === fixture) return;
    setFixture(next); setSelecting(null); setTools(null); setSelections([]);
    runtimeRef.current = emptyRuntimes(); setRuntimes(runtimeRef.current); setNotice(""); setBridgeDetail("Connecting previews…");
  }
  function connectFrame(id: PreviewId) {
    runtimeRef.current = { ...runtimeRef.current, [id]: { ...runtimeRef.current[id], ready: false } };
    setRuntimes(runtimeRef.current);
    setBridgeDetail("Waiting for preview bridge. Reload from Actions if it cannot connect.");
    frames.current[id]?.contentWindow?.postMessage({ protocol: BRIDGE_PROTOCOL, session, generation: "", kind: "connect" }, origin);
  }
  function fullyVisible(id: PreviewId) {
    const frame = frames.current[id]?.getBoundingClientRect(); const area = canvas.current?.getBoundingClientRect();
    return !!frame && !!area && frame.x >= area.x && frame.y >= area.y && frame.right <= area.right + .5 && frame.bottom <= area.bottom + .5;
  }
  async function captureSelectionScreenshot(capture: SelectionCapture) {
    const finish = (screenshot: SelectionCapture["screenshot"]) => setSelections((items) => items.map((item) => item.capture.selectionId === capture.selectionId
      ? { ...item, capture: { ...item.capture, screenshot } }
      : item));
    const frame = frames.current[capture.previewId];
    const area = canvas.current;
    if (!frame || !area || !window.mauxi) {
      finish({ ...capture.screenshot, status: "unavailable", reason: "Selection crops require the trusted Electron capture host." });
      return;
    }
    send(capture.previewId, { kind: "picker-visibility", hidden: true });
    try {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (runtimeRef.current[capture.previewId].generation !== capture.documentGeneration) throw new Error("The document changed before its crop was captured.");
      const frameRect = frame.getBoundingClientRect();
      const canvasRect = area.getBoundingClientRect();
      const converted = selectionCropToShell(capture.screenshot.crop, capture.viewport, frameRect, canvasRect, { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight });
      if (!converted) throw new Error("The selected region is outside the visible canvas.");
      const result = await window.mauxi.capturePreview({
        workspaceId: active?.workspaceId, previewId: capture.previewId, selectionId: capture.selectionId,
        ...converted.shell,
      });
      finish({ ...capture.screenshot, crop: { ...converted.preview, space: "preview-css-pixels" }, status: "captured", path: result.path, width: result.width, height: result.height, capturedAt: new Date().toISOString() });
    } catch (error) {
      finish({ ...capture.screenshot, status: "unavailable", reason: String(error) });
    } finally {
      send(capture.previewId, { kind: "picker-visibility", hidden: false });
    }
  }
  async function revalidateSelection(item: StoredSelection): Promise<boolean> {
    const capture = item.capture;
    const runtime = runtimeRef.current[capture.previewId];
    if (item.requiresRepick || !runtime.ready || runtime.generation !== capture.documentGeneration || runtime.route !== projectRoute(capture.url, origin)) {
      setSelections((items) => items.map((candidate) => candidate.capture.selectionId === capture.selectionId
        ? { ...candidate, status: "stale", requiresRepick: true, staleReason: "The preview route or document changed; pick this target again." }
        : candidate));
      return false;
    }
    if (capture.source.verification === "verified" && capture.source.fileFingerprint && window.mauxi) {
      try {
        const input = {
          hint: capture.source.filePath, lineNumber: capture.source.lineNumber, columnNumber: capture.source.columnNumber,
          locator: { tag: capture.element.tag, testIds: [...new Set(capture.domAncestry.flatMap((entry) => entry.testId ? [entry.testId] : []))].slice(0, 12) },
        };
        const resolved = active ? await window.mauxi.resolveSource({ workspaceId: active.workspaceId, ...input }) : await window.mauxi.resolveFixtureSource({ fixture, ...input });
        if (!resolved || resolved.filePath !== capture.source.filePath || resolved.fileFingerprint !== capture.source.fileFingerprint) {
          setSelections((items) => items.map((candidate) => candidate.capture.selectionId === capture.selectionId
            ? { ...candidate, status: "stale", staleReason: "The verified source file changed since this capture." }
            : candidate));
          return false;
        }
      } catch {
        setSelections((items) => items.map((candidate) => candidate.capture.selectionId === capture.selectionId
          ? { ...candidate, status: "stale", staleReason: "The source fingerprint could not be verified." }
          : candidate));
        return false;
      }
    }
    return new Promise<boolean>((resolve) => {
      const timer = window.setTimeout(() => {
        pendingRevalidations.current.delete(capture.selectionId);
        setSelections((items) => items.map((candidate) => candidate.capture.selectionId === capture.selectionId
          ? { ...candidate, status: "stale", staleReason: "The live preview did not confirm this target." }
          : candidate));
        resolve(false);
      }, 2_500);
      pendingRevalidations.current.set(capture.selectionId, (status) => { window.clearTimeout(timer); resolve(status === "valid"); });
      send(capture.previewId, { kind: "revalidate", selectionId: capture.selectionId, fingerprint: capture.fingerprint });
    });
  }
  async function revalidateDraft(): Promise<{ ok: boolean; message?: string; selections?: StoredSelection[] }> {
    const attached = selectionsRef.current;
    if (!attached.length) return { ok: true, selections: [] };
    if (attached.some((item) => item.capture.source.verification === "unverified" || item.capture.screenshot.status === "pending")) {
      return { ok: false, message: "Selection provenance or screenshot capture is still being verified. Try again in a moment." };
    }
    const results = await Promise.all(attached.map(revalidateSelection));
    return results.every(Boolean)
      ? { ok: true, selections: attached }
      : { ok: false, message: "One or more selections are stale. Remove them or pick the live target again before sending." };
  }
  async function capture(id: PreviewId) {
    setTools(null); setSelecting(null); setActivePreview(id);
    if (active && selecting) void browser.owner("human");
    // Let the dialog/selection overlay leave the compositor before capture.
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const frame = frames.current[id];
    if (!frame || !window.mauxi || !fullyVisible(id)) { setNotice("Fit the full viewport before capturing."); return; }
    try {
      const bounds = frame.getBoundingClientRect();
      const result = await window.mauxi.capturePreview({ workspaceId: active?.workspaceId, previewId: id, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
      setNotice(`Captured ${id} only · ${result.width}×${result.height} · ${result.path}`);
    } catch (error) { setNotice(`Capture failed: ${String(error)}`); }
  }

  const allReady = PREVIEW_IDS.every((id) => runtimes[id].ready);
  const serverFailed = active?.status === "failed";
  const statusText = serverFailed ? active.statusDetail : notice || (allReady ? active?.statusDetail : undefined) || bridgeDetail;
  return <div className="workspace">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">M</span><strong title={active?.appRoot}>{active ? active.appRoot.split("/").pop() : "Mauxi"}</strong></div>
      {!active && <div className="fixture-switch" aria-label="Fixture"><button aria-pressed={fixture === "vite"} onClick={() => switchFixture("vite")}>Vite</button><button aria-pressed={fixture === "next"} onClick={() => switchFixture("next")}>Next.js</button></div>}
      <div className="canvas-actions" aria-label="Canvas controls" inert={browser.locked}>
        <button aria-pressed={hand} onClick={() => { setHand(!hand); setSelecting(null); if (active && selecting) void browser.owner("human"); }}>{hand ? "Hand on" : "Hand"}</button>
        <button onClick={() => fit()}>Fit both</button><button onClick={() => { setLayout((current) => ({ ...unfocus(current), camera: { x: 24, y: 24, zoom: 1 } })); }}>Reset</button>
        <label className="zoom"><span>{Math.round(layout.camera.zoom * 100)}%</span><input aria-label="Camera zoom" type="range" min="0.25" max="2" step="0.01" value={layout.camera.zoom} onChange={(event) => changeZoom(Number(event.target.value))} /></label>
        <button aria-pressed={layout.linked} title="Link same-project routes, never clicks or forms. Unlink for custom action routes." onClick={() => setLayout((current) => ({ ...current, linked: !current.linked }))}>{layout.linked ? "Routes linked" : "Routes unlinked"}</button>
      </div>
      {active && <BrowserControlBar control={browser} ready={allReady && !serverFailed} onGrant={() => {
        setSelecting(null); setTools(null); setHand(false);
        setLayout(current => ({ ...unfocus(current), linked: false, camera: fitCamera(Object.values(current.boards), geometry.current, geometry.current.headerHeight, geometry.current.headerWidth) }));
        setNotice("Route linking paused to avoid replaying side effects. Use test accounts; interactions require separate approval.");
        // Focus remains in the trusted shell; inert removes existing iframe focus.
        void browser.owner("agent");
      }} />}
      <div className="connection"><span className={allReady && !serverFailed ? "online" : ""} aria-hidden="true">●</span><span className="status-text" role="status" title={`${active?.statusDetail ?? bridgeDetail}\n${notice}`}>{statusText}</span>{active && <button onClick={() => { void persist(layoutRef.current).then(onClose); }}>Close project</button>}</div>
    </header>
    <main ref={canvas} className={`canvas ${hand ? "hand-mode" : ""} ${dragging ? "dragging" : ""}`} data-testid="canvas" aria-label="Preview canvas" tabIndex={0}
      onPointerDown={(event) => { if (event.target === event.currentTarget || hand) startDrag(null, event); }}
      onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
      onKeyDown={(event) => { if (event.target !== event.currentTarget) return; if (event.key === "Escape") { setLayout(unfocus); setHand(false); setSelecting(null); } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); setLayout((current) => ({ ...current, camera: { ...current.camera, x: current.camera.x + (event.key === "ArrowLeft" ? 40 : event.key === "ArrowRight" ? -40 : 0), y: current.camera.y + (event.key === "ArrowUp" ? 40 : event.key === "ArrowDown" ? -40 : 0) } })); } }}>
      {PREVIEW_IDS.map((id) => {
        const board = layout.boards[id]; const zoom = layout.camera.zoom;
        return <section key={`${session}-${id}`} className="artboard" data-preview-id={id} aria-label={`${LABELS[id]} artboard`} style={{ left: layout.camera.x + board.x * zoom, top: layout.camera.y + board.y * zoom, width: `max(15rem, ${board.width * zoom}px)`, zIndex: activePreview === id ? 2 : 1, visibility: layout.focus && layout.focus.previewId !== id ? "hidden" : "visible" }}>
          <header className="artboard-header" inert={browser.locked} onPointerDown={(event) => { if (!(event.target as Element).closest("button:not(.board-grip)")) startDrag(id, event); }}>
            <button className="board-grip" aria-label={`Move ${LABELS[id]} artboard with arrow keys`} title="Drag to move · arrow keys when focused" onKeyDown={(event) => { if (!event.key.startsWith("Arrow")) return; event.preventDefault(); const step = (event.shiftKey ? 100 : 20) / zoom; setLayout((current) => ({ ...current, boards: { ...current.boards, [id]: { ...current.boards[id], x: current.boards[id].x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0), y: current.boards[id].y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0) } } })); }}><strong>{LABELS[id]}</strong><span className={runtimes[id].ready ? "bridge-ready" : ""}>{board.width} × {board.height}</span></button>
            <div className="artboard-actions">
              <button aria-label={`Select in ${LABELS[id]}`} title="Pick DOM target · use ↑/↓ for child/parent and [ / ] for overlaps" aria-pressed={selecting === id} disabled={!runtimes[id].ready} onClick={() => { const next = selecting === id ? null : id; setSelecting(next); setHand(false); if (active) void browser.owner(next ? "picker" : "human"); }}>↖</button>
              <button aria-label={`${layout.focus?.previewId === id ? "Unfocus" : "Focus"} ${LABELS[id]}`} aria-pressed={layout.focus?.previewId === id} onClick={() => focus(id)}>⛶</button>
              <button aria-label={`${LABELS[id]} actions`} aria-haspopup="dialog" onClick={() => { setTools(id); setActivePreview(id); }}>•••</button>
            </div>
          </header>
          <div className="preview-surface" style={{ width: board.width * zoom, height: board.height * zoom }}>
            <iframe ref={(node) => { frames.current[id] = node; }} data-testid={`${id}-preview`} title={`${LABELS[id]} preview`} src={urls[id]} onLoad={() => connectFrame(id)} width={board.width} height={board.height} style={{ transform: `scale(${zoom})` }} tabIndex={hand || browser.locked ? -1 : 0} inert={browser.locked} sandbox="allow-scripts allow-forms allow-same-origin allow-modals" />
            {browser.locked && <div className="input-shield browser-shield" data-browser-shield="true" aria-label="Agent has preview control" />}
            {(hand || dragging) && <div className="input-shield" aria-hidden="true" onPointerDown={(event) => startDrag(null, event)} />}
          </div>
        </section>;
      })}
    </main>
    <ChatDock height={layout.chatHeight} onResize={(height) => setLayout((current) => ({ ...current, chatHeight: Math.max(144, Math.min(600, window.innerHeight * .55, height)) }))} workspaceId={active?.workspaceId} selections={selections} onRemove={(id) => setSelections((items) => items.filter((item) => item.capture.selectionId !== id))} onRevalidate={(item) => { void revalidateSelection(item); }} onBeforeSend={revalidateDraft} onSelectionsSent={(ids) => setSelections((items) => items.filter((item) => !ids.includes(item.capture.selectionId)))} />
    {tools && <PreviewTools id={tools} board={layout.boards[tools]} route={runtimes[tools].route} ready={runtimes[tools].ready} generation={runtimes[tools].generation} logs={active?.logs ?? []} canCopy={PREVIEW_IDS.every((id) => runtimes[id].ready) && runtimes[tools].safe && !!supportedRoute(runtimes[tools].route, origin)} canCapture={!!window.mauxi && fullyVisible(tools)} onClose={() => setTools(null)} onReload={() => { if (runtimeRef.current[tools].ready) send(tools, { kind: "reload" }); else if (frames.current[tools]) frames.current[tools]!.src = urls[tools]; setTools(null); }} onCopy={() => { navigate(routes.copy(tools)); setTools(null); }} onCapture={() => void capture(tools)} onResize={(width, height) => { setLayout((current) => { const next = { ...current, boards: { ...current.boards, [tools]: { ...current.boards[tools], width, height } } }; return next.focus ? { ...next, camera: fitCamera([next.boards[next.focus.previewId]], geometry.current, geometry.current.headerHeight, geometry.current.headerWidth) } : next; }); setTools(null); }} />}
  </div>;
}
