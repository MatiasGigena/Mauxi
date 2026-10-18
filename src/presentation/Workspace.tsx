import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { BRIDGE_PROTOCOL, isBridgeMessage, type PreviewId, type SelectionCapture, type ShellToBridgeMessage } from "../application/preview-contract";
import { defaultCanvas, dragBoard, fitBoards, fitCamera, HEADER_HEIGHT, LABELS, MAX_ZOOM, MIN_ZOOM, PREVIEW_IDS, unfocus, zoomAt, type CanvasState } from "../application/canvas-state";
import { projectRoute, RouteLink, supportedRoute, type RouteCommand } from "../application/route-link";
import { markSelectionsAfterDocumentChange, markSelectionsAfterRouteChange, selectionCapturePaths, selectionMarkerIds, type StoredSelection } from "../application/selection-state";
import { selectionCropToShell } from "../application/selection-geometry";
import type { ActiveWorkspace } from "../application/project-contract";
import { ChatDock } from "./ChatDock";
import { CanvasBackground } from "./CanvasBackground";
import { useCanvasNavigation } from "./useCanvasNavigation";
import { PreviewTools } from "./PreviewTools";
import { PreviewHeader } from "./PreviewHeader";
import { useBrowserControl } from "./BrowserControl";
import { RepositoryMenu } from "./RepositoryMenu";
import { ScanSearch } from "lucide-react";
import { AuditPanel } from "./AuditPanel";
import { AuditBoards, snapshotBoards } from "./AuditBoards";
import { SitePageBar, SiteSetup, SiteSummary, useSiteAudit } from "./AuditSite";
import { findingContext, type AuditFinding, type AuditFindingContext, type AuditProgress, type AuditReport } from "../application/audit-contract";
import { Type } from "typebox";
import { Check } from "typebox/schema";
import logo from "./assets/logo-mauxi.png";

const URLS = { vite: "http://127.0.0.1:45173", next: "http://127.0.0.1:45000", "next-turbopack": "http://127.0.0.1:45001" } as const;

/** Proof fixtures served from the same project directory share its source files. */
const SOURCE_FIXTURES = { vite: "vite", next: "next", "next-turbopack": "next" } as const;

type Fixture = keyof typeof URLS;

const isFixture = (value: string | null): value is Fixture => value === "next" || value === "next-turbopack";

type Command = ShellToBridgeMessage extends infer T ? T extends ShellToBridgeMessage ? Omit<T, "protocol" | "session" | "generation"> : never : never;

interface Runtime { generation: string; ready: boolean; route: string; safe: boolean }

function releaseDraftCaptures(files: string[]): void {
  if (!files.length || !window.mauxi) return;
  void window.mauxi.releaseCaptures(files).catch(error => console.warn("Could not release selection captures", error));
}

/** Horizontal space the audit panel covers on the right of the canvas. */
const AUDIT_PANEL_SPACE = 400;

function errorText(cause: unknown): string { return (cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""); }

const IgnoredIds = Type.Array(Type.String({ maxLength: 256 }), { maxItems: 500 });

function readIgnored(key: string): Set<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");

    return new Set(Check(IgnoredIds, value) ? value : []);
  } catch { return new Set(); }
}

const emptyRuntimes = (): Record<PreviewId, Runtime> => ({ desktop: { generation: "", ready: false, route: "", safe: false }, mobile: { generation: "", ready: false, route: "", safe: false } });

function previewUrl(base: string, id: PreviewId, session: string): string {
  const url = new URL(base);
  url.searchParams.set("mauxiSession", session); url.searchParams.set("mauxiPreview", id); url.searchParams.set("mauxiParent", location.origin);

  return url.toString();
}

export function Workspace({ active, onClose }: { active?: ActiveWorkspace; onClose?: () => Promise<void> }) {
  const browser = useBrowserControl(active?.workspaceId);
  const browserLocked = useRef(false); browserLocked.current = browser.locked;

  const [fixture] = useState<Fixture>(() => {
    const value = new URLSearchParams(location.search).get("fixture");

    return isFixture(value) ? value : "vite";
  });

  const [proofPath] = useState(() => {
    const value = new URLSearchParams(location.search).get("path");

    return value?.startsWith("/") ? value : "/";
  });

  const [audit, setAudit] = useState<AuditReport | null>(null);
  const [auditProgress, setAuditProgress] = useState<AuditProgress | null>(null);
  const [auditRunning, setAuditRunning] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const panelOpenRef = useRef(panelOpen); panelOpenRef.current = panelOpen;
  const [auditError, setAuditError] = useState("");
  const [selectedFinding, setSelectedFinding] = useState<string | null>(null);
  const [attachedFindings, setAttachedFindings] = useState<AuditFindingContext[]>([]);
  const ignoredKey = `mauxi:audit-ignored:${active?.workspaceId ?? `proof:${fixture}`}`;
  const [ignoredFindings, setIgnoredFindings] = useState(() => readIgnored(ignoredKey));
  const site = useSiteAudit(active ? { workspaceId: active.workspaceId } : { fixture }, { onOpen: showReport, onActivity: () => setPanelOpen(true) });
  const { reportArrived } = site;
  const session = useMemo(() => crypto.randomUUID(), [active?.workspaceId, fixture]);
  const [layout, setLayout] = useState<CanvasState>(() => active?.canvas ?? defaultCanvas());
  const layoutRef = useRef(layout); layoutRef.current = layout;
  const [selecting, setSelecting] = useState<PreviewId | null>(null);
  const [activePreview, setActivePreview] = useState<PreviewId>("desktop");
  const [tools, setTools] = useState<PreviewId | null>(null);
  const [runtimes, setRuntimes] = useState(emptyRuntimes);
  const runtimeRef = useRef(runtimes);
  const [selections, setSelections] = useState<StoredSelection[]>([]);
  const selectionsRef = useRef(selections); selectionsRef.current = selections;
  const previousCapturePaths = useRef<string[]>([]);
  const mounted = useRef(true);
  useLayoutEffect(() => {
    const paths = selectionCapturePaths(selections);
    releaseDraftCaptures(previousCapturePaths.current.filter(file => !paths.includes(file)));
    previousCapturePaths.current = paths;
  }, [selections]);
  useEffect(() => {
    mounted.current = true;

    return () => { mounted.current = false; releaseDraftCaptures(previousCapturePaths.current); };
  }, []);
  const hiddenPickerCaptures = useRef(new Map<string, number>());
  const pendingRevalidations = useRef(new Map<string, (status: "valid" | "stale") => void>());
  const [notice, setNotice] = useState("");
  const [chatMinimizeRequest, setChatMinimizeRequest] = useState(0);
  const minimizeChat = useCallback(() => setChatMinimizeRequest(request => request + 1), []);
  const [dragging, setDragging] = useState(false);
  const frames = useRef<Record<PreviewId, HTMLIFrameElement | null>>({ desktop: null, mobile: null });
  const canvas = useRef<HTMLElement>(null);
  const initialFit = useRef(!active?.canvas);
  const [boardsPlaced, setBoardsPlaced] = useState(!!active?.canvas);
  const geometry = useRef({ width: 1000, height: 600, headerHeight: HEADER_HEIGHT });
  const drag = useRef<{ id: PreviewId | null; x: number; y: number; state: CanvasState } | null>(null);
  const dragMoved = useRef(false);

  const navigation = useCanvasNavigation({ canvas, frames, locked: browser.locked, onExit: () => {
    setSelecting(null);

    if (active && selecting) void browser.owner("human");
  } });

  const navigationRef = useRef({ ...navigation, selecting });
  navigationRef.current = { ...navigation, selecting };
  const navigationHeld = navigation.space;

  const applyWheel = useCallback((event: Pick<WheelEvent, "deltaMode" | "deltaX" | "deltaY" | "ctrlKey" | "metaKey" | "clientX" | "clientY">) => {
    const element = canvas.current;

    if (!element || browserLocked.current) return;
    navigationRef.current.beginWheel();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
    const rect = element.getBoundingClientRect();
    setLayout((current) => ({ ...current, camera: event.ctrlKey || event.metaKey ? zoomAt(current.camera, current.camera.zoom * Math.exp(-event.deltaY * unit * .005), { x: event.clientX - rect.x, y: event.clientY - rect.y }) : { ...current.camera, x: current.camera.x - event.deltaX * unit, y: current.camera.y - event.deltaY * unit } }));
  }, []);

  useEffect(() => {
    let frame = 0;

    const previewFocus = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (document.hasFocus() && PREVIEW_IDS.some(id => frames.current[id] === document.activeElement)) minimizeChat();
      });
    };

    window.addEventListener("blur", previewFocus);

    return () => { window.removeEventListener("blur", previewFocus); cancelAnimationFrame(frame); };
  }, [minimizeChat]);
  const baseUrl = active ? new URL(active.startPath ?? "/", active.origin).href : new URL(proofPath, URLS[fixture]).href;
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
      geometry.current = { width: Math.max(320, canvas.current.clientWidth - (panelOpenRef.current ? AUDIT_PANEL_SPACE : 0)), height: canvas.current.clientHeight, headerHeight: rootSize * 3 };

      if (initialFit.current) {
        initialFit.current = false;
        setLayout((current) => ({ ...current, camera: fitCamera(Object.values(current.boards), geometry.current, geometry.current.headerHeight) }));
        setBoardsPlaced(true);
      } else if (layoutRef.current.focus) {
        setLayout((current) => ({ ...current, camera: fitCamera([current.boards[current.focus!.previewId]], geometry.current, geometry.current.headerHeight) }));
      }
    });

    if (canvas.current) observer.observe(canvas.current);

    return () => observer.disconnect();
  }, []);

  // The panel collapses when the window becomes too narrow to show it beside the canvas.
  useEffect(() => {
    const wide = matchMedia("(min-width: 1100px)");
    const follow = () => { if (!wide.matches) setPanelOpen(false); };

    wide.addEventListener("change", follow);

    return () => wide.removeEventListener("change", follow);
  }, []);

  useEffect(() => {
    if (canvas.current) geometry.current = { ...geometry.current, width: Math.max(320, canvas.current.clientWidth - (panelOpen ? AUDIT_PANEL_SPACE : 0)) };
  }, [panelOpen]);

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

        if (active && window.mauxi) void window.mauxi.bridgeReady({ workspaceId: active.workspaceId, previewId: id, generation: message.generation, url: message.url }).catch((error) => setNotice(String(error)));

        return;
      }

      if (message.generation !== runtimeRef.current[id].generation) return;

      if (browserLocked.current && ["selection", "selection-cancelled"].includes(message.kind)) return;

      if (message.kind === "canvas-shortcut" || message.kind === "canvas-zoom") {
        const nav = navigationRef.current;

        if (browserLocked.current || (nav.interactive !== id && nav.selecting !== id)) return;

        if (message.kind === "canvas-shortcut") {
          if (message.action === "exit") nav.exit(); else if (message.action === "space") nav.startSpace(id); else nav.endSpace();
        } else {
          const frame = frames.current[id];

          if (!frame) return;
          const rect = frame.getBoundingClientRect();
          applyWheel({ ...message, deltaX: 0, ctrlKey: true, metaKey: false, clientX: rect.x + message.clientX * rect.width / Number(frame.width), clientY: rect.y + message.clientY * rect.height / Number(frame.height) });
        }

        return;
      }

      if (message.kind === "selection-cancelled") { navigationRef.current.exit();

      return; }

      if (message.kind === "navigation-blocked") { if (active) void browser.owner("human"); setNotice("External navigation blocked. Browser control returned; previews stay within the approved project origin.");

      return; }

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
        setSelections((items) => [{ capture, status: "current" as const, interaction: message.interaction }, ...items].slice(0, 8));

        if (capture.source.filePath && capture.source.ownership !== "library" && window.mauxi) {
          const input = {
            hint: capture.source.filePath, lineNumber: capture.source.lineNumber, columnNumber: capture.source.columnNumber,
            locator: { tag: capture.element.tag, testIds: [...new Set(capture.domAncestry.flatMap((entry) => entry.testId ? [entry.testId] : []))].slice(0, 12) },
          };

          const resolution = active ? window.mauxi.resolveSource({ workspaceId: active.workspaceId, ...input }) : window.mauxi.resolveFixtureSource({ fixture: SOURCE_FIXTURES[fixture], ...input });
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
  }, [active, fixture, origin, session, routes, navigate, applyWheel]);

  useEffect(() => { for (const id of PREVIEW_IDS) send(id, { kind: "selection-mode", enabled: selecting === id && !navigationHeld }); }, [selecting, navigationHeld, runtimes, send]);
  useEffect(() => {
    for (const id of PREVIEW_IDS) send(id, { kind: "selection-markers", selectionIds: browser.locked ? [] : selectionMarkerIds(selections, id, runtimes[id].generation) });
  }, [selections, runtimes, browser.locked, send]);
  useEffect(() => { for (const id of PREVIEW_IDS) send(id, { kind: "canvas-controls", enabled: !browser.locked && (navigation.interactive === id || selecting === id) }); }, [navigation.interactive, selecting, browser.locked, runtimes, send]);
  useEffect(() => {
    if (!selecting || navigationHeld) return;

    const onPickerKey = (event: KeyboardEvent) => {
      const target = event.target;

      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable)) return;

      const action = event.key === "ArrowUp" ? "parent" : event.key === "ArrowDown" ? "child"
        : event.key === "]" ? "overlap-next" : event.key === "[" ? "overlap-previous" : event.key === "Enter" ? "attach" : null;

      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); navigation.exit();

      return; }

      if (!action) return;
      event.preventDefault(); event.stopPropagation(); send(selecting, { kind: "picker-refine", action });
    };

    window.addEventListener("keydown", onPickerKey, true);

    return () => window.removeEventListener("keydown", onPickerKey, true);
  }, [selecting, navigationHeld, send, navigation.exit]);

  function focus(id: PreviewId) {
    setLayout((current) => {
      const restored = unfocus(current);

      if (current.focus?.previewId === id) return restored;

      return { ...restored, focus: { previewId: id, camera: restored.camera, positions: { desktop: { x: restored.boards.desktop.x, y: restored.boards.desktop.y }, mobile: { x: restored.boards.mobile.x, y: restored.boards.mobile.y } } }, camera: fitCamera([restored.boards[id]], geometry.current, geometry.current.headerHeight) };
    });
    setActivePreview(id);
  }

  function toggleSelection(id: PreviewId) {
    const next = selecting === id ? null : id;
    navigation.exit(false); setSelecting(next);

    if (active) void browser.owner(next ? "picker" : "human");
  }

  function changeZoom(zoom: number) {
    setLayout((current) => ({ ...current, camera: zoomAt(current.camera, zoom, { x: geometry.current.width / 2, y: geometry.current.height / 2 }) }));
  }

  useEffect(() => {
    const element = canvas.current;

    if (!element) return;

    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      applyWheel(event);
    };

    element.addEventListener("wheel", wheel, { passive: false });

    return () => element.removeEventListener("wheel", wheel);
  }, [applyWheel]);

  function startDrag(id: PreviewId | null, event: ReactPointerEvent) {
    if (browserLocked.current || (event.button !== 0 && event.button !== 1)) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragMoved.current = false;
    drag.current = { id, x: event.clientX, y: event.clientY, state: layoutRef.current };

    if (id) setActivePreview(id);
  }

  function moveDrag(event: ReactPointerEvent) {
    if (browserLocked.current) { endDrag();

    return; }

    const start = drag.current;

    if (!start) return;
    const delta = { x: event.clientX - start.x, y: event.clientY - start.y };

    if (!dragMoved.current && Math.hypot(delta.x, delta.y) < 4) return;
    dragMoved.current = true; setDragging(true);
    setLayout((current) => start.id ? { ...current, boards: { ...current.boards, [start.id]: dragBoard(start.state.boards[start.id], delta, start.state.camera.zoom) } } : { ...current, camera: { ...start.state.camera, x: start.state.camera.x + delta.x, y: start.state.camera.y + delta.y } });
  }

  function endDrag() { drag.current = null; setDragging(false); }

  function connectFrame(id: PreviewId) {
    runtimeRef.current = { ...runtimeRef.current, [id]: { ...runtimeRef.current[id], ready: false } };
    setRuntimes(runtimeRef.current);
    frames.current[id]?.contentWindow?.postMessage({ protocol: BRIDGE_PROTOCOL, session, generation: "", kind: "connect" }, origin);
  }

  function fullyVisible(id: PreviewId) {
    const frame = frames.current[id]?.getBoundingClientRect(); const area = canvas.current?.getBoundingClientRect();

    return !!frame && !!area && frame.x >= area.x && frame.y >= area.y && frame.right <= area.right + .5 && frame.bottom <= area.bottom + .5;
  }

  async function withoutPickerChrome<T>(id: PreviewId, capture: () => Promise<T>): Promise<T> {
    const generation = runtimeRef.current[id].generation;
    const key = `${session}:${id}:${generation}`;
    const pending = hiddenPickerCaptures.current;
    pending.set(key, (pending.get(key) ?? 0) + 1);
    send(id, { kind: "picker-visibility", hidden: true });

    try {
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

      if (runtimeRef.current[id].generation !== generation) throw new Error("The preview document changed before capture.");

      return await capture();
    } finally {
      const remaining = (pending.get(key) ?? 1) - 1;

      if (remaining) pending.set(key, remaining);
      else {
        pending.delete(key);

        if (runtimeRef.current[id].generation === generation) send(id, { kind: "picker-visibility", hidden: false });
      }
    }
  }

  async function captureSelectionScreenshot(capture: SelectionCapture) {
    const finish = (screenshot: SelectionCapture["screenshot"]) => setSelections((items) => items.map((item) => item.capture.selectionId === capture.selectionId
      ? { ...item, capture: { ...item.capture, screenshot } }
      : item));

    const frame = frames.current[capture.previewId];
    const area = canvas.current;
    const host = window.mauxi;

    if (!frame || !area || !host) {
      finish({ ...capture.screenshot, status: "unavailable", reason: "Selection crops require the trusted Electron capture host." });

      return;
    }

    try {
      await withoutPickerChrome(capture.previewId, async () => {
        if (runtimeRef.current[capture.previewId].generation !== capture.documentGeneration) throw new Error("The document changed before its crop was captured.");
        const frameRect = frame.getBoundingClientRect();
        const canvasRect = area.getBoundingClientRect();
        const converted = selectionCropToShell(capture.screenshot.crop, capture.viewport, frameRect, canvasRect, { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight });

        if (!converted) throw new Error("The selected region is outside the visible canvas.");

        const result = await host.capturePreview({
          workspaceId: active?.workspaceId, previewId: capture.previewId, selectionId: capture.selectionId,
          ...converted.shell,
        });

        if (!mounted.current || !selectionsRef.current.some(item => item.capture.selectionId === capture.selectionId)) {
          releaseDraftCaptures([result.path]);

          return;
        }

        previousCapturePaths.current = [...new Set([...previousCapturePaths.current, result.path])];
        finish({ ...capture.screenshot, crop: { ...converted.preview, space: "preview-css-pixels" }, status: "captured", path: result.path, width: result.width, height: result.height, capturedAt: new Date().toISOString() });
      });
    } catch (error) {
      finish({ ...capture.screenshot, status: "unavailable", reason: String(error) });
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

        const resolved = active ? await window.mauxi.resolveSource({ workspaceId: active.workspaceId, ...input }) : await window.mauxi.resolveFixtureSource({ fixture: SOURCE_FIXTURES[fixture], ...input });

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
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const frame = frames.current[id];

    if (!frame || !window.mauxi || !fullyVisible(id)) { setNotice("Fit the full viewport before capturing.");

    return; }

    try {
      const host = window.mauxi;

      const result = await withoutPickerChrome(id, async () => {
        if (!fullyVisible(id)) throw new Error("Fit the full viewport before capturing.");
        const bounds = frame.getBoundingClientRect();

        return host.capturePreview({ workspaceId: active?.workspaceId, previewId: id, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
      });

      setNotice(`Captured ${id} only · ${result.width}×${result.height} · ${result.path}`);
    } catch (error) { setNotice(`Capture failed: ${String(error)}`); }
  }

  function grantBrowserControl() {
    if (browser.locked || !PREVIEW_IDS.every(id => runtimeRef.current[id].ready) || active?.status === "failed") return;
    navigation.exit(false); setSelecting(null); setTools(null);
    setLayout(current => ({ ...fitBoards(current, PREVIEW_IDS, geometry.current, geometry.current.headerHeight), linked: false }));
    setNotice("Route linking paused during agent checks. Re-enable it in preview actions when needed.");
    void browser.owner("agent");
  }

  useEffect(() => {
    if (!window.mauxi) return;
    const offProgress = window.mauxi.onAuditProgress(setAuditProgress);
    const offReport = window.mauxi.onAuditReport((report) => { setAudit(report); setAuditError(""); setPanelOpen(true); reportArrived(report); });

    return () => { offProgress(); offReport(); };
  }, [reportArrived]);

  // Attached findings that a newer run no longer reports (fixed, or a different route) are dropped from the chat.
  useEffect(() => {
    if (audit) setAttachedFindings((items) => items.filter((item) => audit.findings.some((finding) => finding.id === item.id)));
  }, [audit]);

  const snapshots = useMemo(() => snapshotBoards(audit, PREVIEW_IDS.map((id) => layout.boards[id])), [audit, layout.boards]);

  const desktopRoute = () => runtimeRef.current.desktop.route || projectRoute(baseUrl, origin) || "/";

  /** Shows a report in the panel and fits the canvas to the live previews plus its snapshot row. */
  function showReport(report: AuditReport) {
    setAudit(report);
    setSelectedFinding(null);
    const boards = snapshotBoards(report, PREVIEW_IDS.map((id) => layoutRef.current.boards[id]));
    setLayout((current) => ({ ...unfocus(current), camera: fitCamera([...PREVIEW_IDS.map((id) => current.boards[id]), ...boards], geometry.current, geometry.current.headerHeight, MIN_ZOOM) }));
  }

  /** Audits the Desktop preview's route, or the given route (an open page of a site audit). */
  async function runAudit(target?: string) {
    if (!window.mauxi || auditRunning) return;
    const route = target ?? desktopRoute();
    setAuditRunning(true); setAuditError(""); setAuditProgress(null);

    try { showReport(await window.mauxi.auditRun(active ? { workspaceId: active.workspaceId, route } : { route, fixture })); }
    catch (error) { setAuditError(errorText(error)); }
    finally { setAuditRunning(false); }
  }

  function startSite() {
    setAuditProgress(null); setAuditError("");
    void site.discover(desktopRoute());
  }

  function selectFinding(finding: AuditFinding) {
    setSelectedFinding((current) => current === finding.id ? null : finding.id);
  }

  /** Resizes the closest live preview to the worst width and outlines the element there. */
  function showFinding(finding: AuditFinding) {
    setSelectedFinding(finding.id);
    const id: PreviewId = finding.worst.width <= 1024 ? "mobile" : "desktop";
    const width = Math.max(240, Math.min(3840, finding.worst.width));
    setLayout((current) => {
      const restored = unfocus(current);
      const board = { ...restored.boards[id], width, height: Math.max(240, Math.min(2160, finding.worst.height)) };

      return { ...restored, boards: { ...restored.boards, [id]: board }, camera: fitCamera([board], geometry.current, geometry.current.headerHeight) };
    });
    setActivePreview(id);
    window.setTimeout(() => send(id, { kind: "highlight", selector: finding.element?.selector ?? null, label: finding.title.slice(0, 160) }), 350);
  }

  function attachFinding(finding: AuditFinding) {
    if (!audit) return;
    setAttachedFindings((items) => items.some((item) => item.id === finding.id) ? items : [...items, findingContext(finding, audit.route)].slice(-12));
  }

  function toggleIgnored(finding: AuditFinding) {
    setIgnoredFindings((current) => {
      const next = new Set(current);

      if (next.has(finding.id)) next.delete(finding.id); else next.add(finding.id);

      try { localStorage.setItem(ignoredKey, JSON.stringify([...next])); } catch {}

      return next;
    });
  }

  const statusText = active?.status === "failed" ? active.statusDetail : notice;

  const siteView = site.mode === "setup"
    ? <SiteSetup key={site.discovery?.start ?? "discovering"} discovery={site.discovery} discovering={site.discovering} origin={origin} onStart={(routes) => { setAuditProgress(null); void site.start(routes); }} onCancel={site.close} />
    : site.mode === "summary" && site.report ? <SiteSummary report={site.report} onOpen={(route) => void site.open(route)} /> : null;

  return <div className="workspace" data-audit-panel={panelOpen ? "" : undefined}>
    <div className="canvas-surface">
    <CanvasBackground settled={boardsPlaced} />
    <header className="topbar">
      {active && onClose ? <RepositoryMenu root={active.appRoot} onClose={async () => { await persist(layoutRef.current); await onClose(); }} /> : <div className="brand"><img className="brand-mark" src={logo} alt="" /><strong>Mauxi</strong></div>}
      {!panelOpen && <button type="button" className="audit-launcher" aria-expanded={false} onClick={() => setPanelOpen(true)} title="Open the responsive audit" aria-label="Responsive audit">
        <ScanSearch size={16} aria-hidden="true" /><span className="audit-launcher-label">Responsive audit</span>{audit && <span className="audit-launcher-count" aria-hidden="true">{audit.summary.bug}</span>}
      </button>}
      <label className="zoom"><span>{Math.round(layout.camera.zoom * 100)}%</span><input aria-label="Camera zoom" aria-valuetext={`${Math.round(layout.camera.zoom * 100)}%`} type="range" min={MIN_ZOOM} max={MAX_ZOOM} step="0.01" value={layout.camera.zoom} disabled={browser.locked} onChange={(event) => changeZoom(Number(event.target.value))} /></label>
    </header>
    {(statusText || browser.error || browser.locked) && <div className="workspace-notice" role="status">{browser.error || statusText}{browser.locked && <button className="take-back" aria-label="Emergency take back control" onClick={() => void browser.owner("human")}>Take back control</button>}</div>}
    <main ref={canvas} className={`canvas ${navigationHeld ? "hand-mode" : ""} ${dragging ? "dragging" : ""}`} data-testid="canvas" data-navigation-gesture={navigation.wheeling} aria-label="Preview canvas" tabIndex={0}
      onPointerDownCapture={event => { if (event.button === 0) minimizeChat(); }}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) { if (!browserLocked.current && !navigationHeld) navigation.exit(); startDrag(null, event); }
        else if (navigationHeld) startDrag(null, event);
      }}
      onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
      onKeyDown={(event) => { if (browserLocked.current || event.target !== event.currentTarget) return;

      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); setLayout((current) => ({ ...current, camera: { ...current.camera, x: current.camera.x + (event.key === "ArrowLeft" ? 40 : event.key === "ArrowRight" ? -40 : 0), y: current.camera.y + (event.key === "ArrowUp" ? 40 : event.key === "ArrowDown" ? -40 : 0) } })); } }}>
      {audit && <AuditBoards boards={snapshots} report={audit} camera={layout.camera} selected={selectedFinding} ignored={ignoredFindings} onSelect={(finding) => setSelectedFinding(finding.id)} />}
      {PREVIEW_IDS.map((id) => {
        const board = layout.boards[id]; const zoom = layout.camera.zoom;
        const interacting = navigation.interactive === id && !selecting && !navigationHeld;
        const shielded = navigationHeld || dragging || navigation.wheeling || (selecting !== id && !interacting);

        return <section key={`${session}-${id}`} className="artboard" data-preview-id={id} data-interacting={interacting && !shielded && !browser.locked} aria-label={`${LABELS[id]} artboard`} style={{ left: layout.camera.x + board.x * zoom, top: layout.camera.y + board.y * zoom, width: board.width * zoom, zIndex: activePreview === id ? 2 : 1, visibility: layout.focus && layout.focus.previewId !== id ? "hidden" : "visible" }}>
          <PreviewHeader id={id} board={board} ready={runtimes[id].ready} locked={browser.locked}
            interacting={interacting && !shielded && !browser.locked} selecting={selecting === id} focused={layout.focus?.previewId === id}
            onDrag={event => startDrag(navigationHeld ? null : id, event)}
            onMove={delta => setLayout(current => ({ ...current, boards: { ...current.boards, [id]: dragBoard(current.boards[id], delta, current.camera.zoom) } }))}
            onSelect={() => toggleSelection(id)} onFocus={() => focus(id)} onTools={() => { setTools(id); setActivePreview(id); }} />
          <div className="preview-surface" style={{ width: board.width * zoom, height: board.height * zoom }}>
            <iframe ref={(node) => { frames.current[id] = node; }} name={`mauxi-preview:${active?.workspaceId ?? "proof"}:${id}`} data-testid={`${id}-preview`} title={`${LABELS[id]} preview`} src={urls[id]} onLoad={() => connectFrame(id)} width={board.width} height={board.height} style={{ transform: `scale(${zoom})` }} tabIndex={shielded || browser.locked ? -1 : 0} inert={shielded || browser.locked} sandbox="allow-scripts allow-forms allow-same-origin allow-modals" />
            {browser.locked && <div className="input-shield browser-shield" data-browser-shield="true" aria-label="Agent has preview control" />}
            {!browser.locked && shielded && <button type="button" className="input-shield preview-activate" aria-label={`Interact with ${LABELS[id]} preview`} title="Click to interact · scroll to pan · pinch to zoom" tabIndex={navigationHeld || dragging || navigation.wheeling ? -1 : 0}
              onPointerDown={(event) => startDrag(null, event)}
              onClick={(event) => {
                event.stopPropagation();

                if (navigationHeld || navigation.wheeling || (dragMoved.current && event.detail !== 0)) return;
                navigation.activate(id); setActivePreview(id); setSelecting(null);

                if (active && selecting) void browser.owner("human");
              }} />}
          </div>
        </section>;
      })}
    </main>
    <ChatDock workspaceId={active?.workspaceId} browserControl={{ locked: browser.locked, pending: browser.pending || !!browser.state?.releasing, ready: !!browser.state && PREVIEW_IDS.every(id => runtimes[id].ready) && active?.status !== "failed", onGrant: grantBrowserControl, onRevoke: () => void browser.owner("human") }} minimizeRequest={chatMinimizeRequest} selections={selections} onRemove={(id) => setSelections((items) => items.filter((item) => item.capture.selectionId !== id))} onBeforeSend={revalidateDraft} onSelectionsSent={(ids) => setSelections((items) => items.filter((item) => !ids.includes(item.capture.selectionId)))}
      findings={attachedFindings} onRemoveFinding={(id) => setAttachedFindings((items) => items.filter((item) => item.id !== id))} onFindingsSent={(ids) => setAttachedFindings((items) => items.filter((item) => !ids.includes(item.id)))} />
    {panelOpen && <AuditPanel onClose={() => setPanelOpen(false)} report={siteView ? null : audit} progress={auditProgress} running={auditRunning || site.discovering || site.running} error={auditError || site.error} selected={selectedFinding} attached={new Set(attachedFindings.map((item) => item.id))} ignored={ignoredFindings}
      onRun={() => void runAudit(site.mode === "page" ? site.page ?? undefined : undefined)} onCancel={() => void window.mauxi?.auditCancel()} onSelect={selectFinding} onShow={showFinding} onFix={attachFinding} onIgnore={toggleIgnored}
      onSite={startSite} siteView={siteView} pageBar={site.mode === "page" && <SitePageBar report={site.report} page={site.page} onBack={site.back} />} />}
    </div>
    {tools && <PreviewTools id={tools} linked={layout.linked} onToggleLinked={() => { if (!browserLocked.current) setLayout(current => ({ ...current, linked: !current.linked })); }} selecting={selecting === tools} focused={layout.focus?.previewId === tools} onSelect={() => { toggleSelection(tools); setTools(null); }} onFocus={() => { focus(tools); setTools(null); }} board={layout.boards[tools]} ready={runtimes[tools].ready} canCopy={PREVIEW_IDS.every((id) => runtimes[id].ready) && runtimes[tools].safe && !!supportedRoute(runtimes[tools].route, origin)} canCapture={!!window.mauxi && fullyVisible(tools)} onClose={() => setTools(null)} onReload={() => { if (runtimeRef.current[tools].ready) send(tools, { kind: "reload" }); else if (frames.current[tools]) frames.current[tools]!.src = urls[tools]; setTools(null); }} onCopy={() => { navigate(routes.copy(tools)); setTools(null); }} onCapture={() => void capture(tools)} onResize={(width, height) => { setLayout((current) => { const next = { ...current, boards: { ...current.boards, [tools]: { ...current.boards[tools], width, height } } };

    return next.focus ? { ...next, camera: fitCamera([next.boards[next.focus.previewId]], geometry.current, geometry.current.headerHeight) } : next; }); setTools(null); }} />}
  </div>;
}
