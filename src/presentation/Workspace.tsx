import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { flushSync } from "react-dom";
import { BRIDGE_PROTOCOL, isBridgeMessage, type PreviewId, type SelectionCapture, type ShellToBridgeMessage } from "../application/preview-contract";
import { defaultCanvas, dragBoard, fitCamera, FIT_GAP, FIT_MIN_ZOOM, HEADER_HEIGHT, LIVE_FRAME, LABELS, MAX_ZOOM, OVERVIEW_MIN_ZOOM, PREVIEW_IDS, unfocus, zoomAt, zoomFloor, type Artboard, type Camera, type CanvasState } from "../application/canvas-state";
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
import { ArrowLeft, Maximize, ScanSearch } from "lucide-react";
import { AuditPanel } from "./AuditPanel";
import { auditMatrix, AuditBoards, matrixTile, type FormingAudit } from "./AuditBoards";
import { WidthScope } from "./WidthScope";
import { SnapshotOffer } from "./SnapshotOffer";
import { CAPTION, seenOn } from "../application/audit-layout";
import { SitePageBar, SiteSetup, SiteSummary, useSiteAudit } from "./AuditSite";
import { findingContext, type AuditFinding, type AuditFindingContext, type AuditProgress, type AuditReport, type AuditSnapshot } from "../application/audit-contract";
import { Type } from "typebox";
import { Check } from "typebox/schema";
import logo from "./assets/logo-mauxi.png";
import { errorText } from "./error-text";

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

/** Vertical space the peek bar takes under the top bar, kept clear so it never covers the tile it names. */
const PEEK_BAR_SPACE = 52;
/** The least px every automatic fit keeps between the boards and the top bar above and the chat below, past phone widths (24 on them). */
const GAP = FIT_GAP;
const FRAME = LIVE_FRAME;
/** The snapshots offer's height (.snapshot-offer in audit.css): the fit keeps its slot between the top bar and the previews. */
const OFFER_SLOT = 50;

/** A live preview as fits see it: with its frame's left side and chin. */
const framed = (board: Artboard): Artboard => ({ ...board, inset: (board.inset ?? 0) + FRAME, lead: FRAME });

const sameCamera = (a: Camera, b: Camera | null) => !!b && a.x === b.x && a.y === b.y && a.zoom === b.zoom;

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

  /** Harnesses whose checks need a still canvas open it without the entry audit (?audit=manual); the app never sets it. */
  const [manualAudit] = useState(() => new URLSearchParams(location.search).get("audit") === "manual");

  const [proofPath] = useState(() => {
    const value = new URLSearchParams(location.search).get("path");

    return value?.startsWith("/") ? value : "/";
  });

  const [audit, setAudit] = useState<AuditReport | null>(null);
  const [auditProgress, setAuditProgress] = useState<AuditProgress | null>(null);
  const [auditRunning, setAuditRunning] = useState(false);
  /** Profile snapshots of the single-route run in progress, as they stream in. */
  const [streamed, setStreamed] = useState<AuditSnapshot[]>([]);
  /** A single-route run the host reports, including one the agent started. */
  const [hostAudit, setHostAudit] = useState(false);
  /** A run this canvas started itself is in flight; the host announces it too, and that announcement is not the agent's. */
  const ownRun = useRef(false);
  /**
   * The canvas opens on the two live previews: the entry audit runs in the panel only, and its snapshots wait for the
   * offer that appears when it finishes. Anything that needs the snapshots (the offer, a finding, a Seen at chip, a run
   * the user or the agent starts, a site page, Fit everything) shows them, and they stay for the rest of the session.
   */
  const [held, setHeld] = useState(!manualAudit);
  const heldRef = useRef(held); heldRef.current = held;
  /** The snapshots offer: shown while held after a report, "leaving" while it animates out, "closed" once dismissed or taken. */
  const [offer, setOffer] = useState<"open" | "leaving" | "closed">("open");
  /** Where the offer sits when the camera made room for it (px from the canvas top); null keeps it just below the top bar. */
  const [offerTop, setOfferTop] = useState<number | null>(null);
  const offerShown = useRef(false);
  /** The snapshots just came in: the sheet and its tiles play their entrance once. */
  const [entering, setEntering] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const panelOpenRef = useRef(panelOpen); panelOpenRef.current = panelOpen;
  const [auditError, setAuditError] = useState("");
  const [selectedFinding, setSelectedFinding] = useState<string | null>(null);
  const [hoveredFinding, setHoveredFinding] = useState<string | null>(null);
  /** Audit sheet tiles shown uncropped. */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  /** A tile brought into view for a closer look: the camera to return to and whether the peek opened the tile. */
  const [peek, setPeek] = useState<{ profileId: string; label: string; camera: Camera; opened: boolean } | null>(null);
  /** The width last chosen on the width scope, and the live boards the sheet keeps its layout from while a drag lasts. */
  const [scrub, setScrub] = useState<{ width: number; frozen: Artboard[] | null } | null>(null);
  /** A "Show at" highlight waiting for its preview to load a newer document than `stale` and settle at the finding's width. */
  const [showing, setShowing] = useState<{ id: PreviewId; route: string; stale: string | null; deadline: number; selector: string | null; label: string } | null>(null);
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
  const [closing, setClosing] = useState(false);
  const [chatMinimizeRequest, setChatMinimizeRequest] = useState(0);
  const minimizeChat = useCallback(() => setChatMinimizeRequest(request => request + 1), []);
  const [dragging, setDragging] = useState(false);
  const frames = useRef<Record<PreviewId, HTMLIFrameElement | null>>({ desktop: null, mobile: null });
  const canvas = useRef<HTMLElement>(null);
  const initialFit = useRef(!active?.canvas);
  /** The camera the canvas opened with; the entry audit moves the camera only while the user has not. */
  const entryCamera = useRef<Camera>(layout.camera);
  /** The session whose entry audit was started or found unnecessary: it runs once per opened canvas. */
  const entryAudit = useRef<string | null>(null);
  const [boardsPlaced, setBoardsPlaced] = useState(!!active?.canvas);
  /** The canvas column (x, width: see canvasColumn) and the canvas height: where automatic fits put the boards. */
  const geometry = useRef({ x: 0, width: 1000, height: 600, headerHeight: HEADER_HEIGHT, gutter: 0 });
  const drag = useRef<{ id: PreviewId | null; x: number; y: number; state: CanvasState } | null>(null);
  const dragMoved = useRef(false);

  const navigation = useCanvasNavigation({ canvas, frames, locked: browser.locked, onExit: () => {
    setSelecting(null);

    if (active && selecting) void browser.owner("human");
  } });

  const navigationRef = useRef({ ...navigation, selecting });
  navigationRef.current = { ...navigation, selecting };
  const navigationHeld = navigation.space;

  /** The camera animation in progress; any pan or zoom by the user stops it. */
  const flight = useRef<number | null>(null);

  const stopFlight = useCallback(() => {
    if (flight.current !== null) cancelAnimationFrame(flight.current);
    flight.current = null;
  }, []);

  const applyWheel = useCallback((event: Pick<WheelEvent, "deltaMode" | "deltaX" | "deltaY" | "ctrlKey" | "metaKey" | "clientX" | "clientY">) => {
    const element = canvas.current;

    if (!element || browserLocked.current) return;
    stopFlight();
    navigationRef.current.beginWheel();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
    const rect = element.getBoundingClientRect();
    setLayout((current) => ({ ...current, camera: event.ctrlKey || event.metaKey ? zoomAt(current.camera, current.camera.zoom * Math.exp(-event.deltaY * unit * .005), { x: event.clientX - rect.x, y: event.clientY - rect.y }) : { ...current.camera, x: current.camera.x - event.deltaX * unit, y: current.camera.y - event.deltaY * unit } }));
  }, [stopFlight]);

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
      geometry.current = { ...canvasColumn(panelOpenRef.current), height: canvas.current.clientHeight, headerHeight: rootSize * 3, gutter: 0 };

      if (initialFit.current) {
        initialFit.current = false;
        const camera = freeCamera(Object.values(layoutRef.current.boards).map(framed), panelOpenRef.current, FIT_MIN_ZOOM);
        entryCamera.current = camera;
        setLayout((current) => ({ ...current, camera }));
        setBoardsPlaced(true);
      } else if (layoutRef.current.focus) {
        setLayout((current) => ({ ...current, camera: freeCamera([framed(current.boards[current.focus!.previewId])], panelOpenRef.current, FIT_MIN_ZOOM) }));
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
    if (canvas.current) geometry.current = { ...geometry.current, ...canvasColumn(panelOpen) };
  }, [panelOpen]);

  const persist = useCallback(async (state: CanvasState) => {
    if (!active || !window.mauxi) return;

    try { await window.mauxi.saveCanvas({ workspaceId: active.workspaceId, canvas: state }); }
    catch (error) { setNotice(`Layout not saved: ${errorText(error)}`); }
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

        if (active && window.mauxi) void window.mauxi.bridgeReady({ workspaceId: active.workspaceId, previewId: id, generation: message.generation, url: message.url }).catch((error) => setNotice(errorText(error)));

        return;
      }

      if (message.generation !== runtimeRef.current[id].generation) return;

      if (browserLocked.current && ["selection", "selection-cancelled"].includes(message.kind)) return;

      if (message.kind === "canvas-controls") {
        if (message.enabled && !browserLocked.current) navigationRef.current.controlsReady(id);

        return;
      }

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
            setNotice(`Source unavailable: ${errorText(error)}`);
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

      return { ...restored, focus: { previewId: id, camera: restored.camera, positions: { desktop: { x: restored.boards.desktop.x, y: restored.boards.desktop.y }, mobile: { x: restored.boards.mobile.x, y: restored.boards.mobile.y } } }, camera: freeCamera([framed(restored.boards[id])], panelOpenRef.current, FIT_MIN_ZOOM) };
    });
    setActivePreview(id);
  }

  function toggleSelection(id: PreviewId) {
    const next = selecting === id ? null : id;
    navigation.exit(false); setSelecting(next);

    if (active) void browser.owner(next ? "picker" : "human");
  }

  function changeZoom(zoom: number) {
    stopFlight();
    setLayout((current) => ({ ...current, camera: zoomAt(current.camera, zoom, { x: geometry.current.x + geometry.current.width / 2, y: geometry.current.height / 2 }) }));
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
    stopFlight();
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
      finish({ ...capture.screenshot, status: "unavailable", reason: errorText(error) });
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
    } catch (error) { setNotice(`Capture failed: ${errorText(error)}`); }
  }

  function grantBrowserControl() {
    if (browser.locked || !PREVIEW_IDS.every(id => runtimeRef.current[id].ready) || active?.status === "failed") return;
    navigation.exit(false); setSelecting(null); setTools(null);
    setLayout(current => { const restored = unfocus(current);

      return { ...restored, camera: freeCamera(PREVIEW_IDS.map((id) => framed(restored.boards[id])), panelOpenRef.current, FIT_MIN_ZOOM), linked: false }; });
    void browser.owner("agent");
  }

  useEffect(() => {
    if (!window.mauxi) return;

    const offProgress = window.mauxi.onAuditProgress(({ snapshot, ...progress }) => {
      setAuditProgress(progress);

      if (progress.site) return;

      if (progress.phase === "loading") setStreamed([]);

      if (snapshot) setStreamed((items) => [...items.filter((item) => item.profileId !== snapshot.profileId), snapshot]);
    });

    // Agent-started runs show progress and Stop like the user's own; a new run drops the last run's progress and error.
    const offState = window.mauxi.onAuditState((running) => {
      setHostAudit(running);

      if (running) { setAuditProgress(null); setStreamed([]); setAuditError(""); setPanelOpen(true); }

      // The agent's run forms on the canvas like the user's own; the entry run announced here is this canvas's.
      if (running && !ownRun.current) showSheet();
    });

    const offReport = window.mauxi.onAuditReport((report) => { setAudit(report); setAuditError(""); setPanelOpen(true); reportArrived(report); });

    return () => { offProgress(); offState(); offReport(); };
  }, [reportArrived]);

  // Attached findings that a newer run no longer reports (fixed, or a different route) are dropped from the chat.
  useEffect(() => {
    if (audit) setAttachedFindings((items) => items.filter((item) => audit.findings.some((finding) => finding.id === item.id)));
  }, [audit]);

  // A single-route run (the user's or the agent's) forms the matrix on the canvas; a site batch reports in the panel only.
  const forming = auditRunning || hostAudit;
  const measuring = forming && auditProgress?.phase === "profiles" ? auditProgress.profile ?? null : null;
  // While the width scope is dragged, the sheet keeps the layout it had when the drag began, so it holds still under the pointer.
  const frozen = scrub?.frozen ?? null;
  // Stage mode: a selected finding in a finished report puts its snapshots on the stage (see layoutStage).
  const stagedFinding = !forming && audit && selectedFinding ? audit.findings.find((finding) => finding.id === selectedFinding) ?? null : null;
  const stageFocus = useMemo(() => stagedFinding && audit ? audit.snapshots.map((snapshot) => snapshot.profileId).filter((id) => seenOn(stagedFinding, id)) : null, [stagedFinding, audit]);
  const stageFocusRef = useRef(stageFocus); stageFocusRef.current = stageFocus;
  const matrix = useMemo(() => auditMatrix(audit, forming ? { snapshots: streamed, current: measuring } : null, frozen ?? PREVIEW_IDS.map((id) => layout.boards[id]), expanded, stageFocus), [audit, forming, streamed, measuring, layout.boards, expanded, frozen, stageFocus]);

  // The width scope in the top bar counts what the canvas shows: no findings while a run forms, none marked intentional.
  const scopeFindings = useMemo(() => forming || !audit ? [] : audit.findings.filter((finding) => !ignoredFindings.has(finding.id)), [forming, audit, ignoredFindings]);

  offerShown.current = !!audit && offer === "open" && held && !forming;

  const desktopRoute = () => runtimeRef.current.desktop.route || projectRoute(baseUrl, origin) || "/";

  /** Shows a report in the panel and, unless told not to, fits the canvas to the live previews plus its board matrix. */
  function showReport(report: AuditReport, fit = true) {
    setAudit(report);
    setSelectedFinding(null); setHoveredFinding(null); setExpanded(new Set()); setPeek(null); stopFlight();

    if (!fit) return;
    showSheet();
    setLayout((current) => ({ ...unfocus(current), camera: matrixCamera(unfocus(current), report, null, panelOpenRef.current) }));
  }

  /** Puts the snapshots on the canvas for the rest of the session; the offer, if it is up, leaves as they arrive. */
  function showSheet() {
    if (!heldRef.current) return;
    heldRef.current = false;
    setHeld(false);
    // Only an offer on screen animates out; one that never showed just closes.
    setOffer((current) => current === "open" && offerShown.current ? "leaving" : current === "open" ? "closed" : current);

    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) setEntering(true);
  }

  /** The offer's button: shows the snapshots and flies the camera out to the live previews and the whole sheet. */
  function acceptOffer() {
    if (!audit) return;
    showSheet();
    const base = unfocus(layoutRef.current);
    setLayout((current) => unfocus(current));
    flyTo(matrixCamera(base, audit, null, panelOpenRef.current), base.camera, 440);
  }

  // The entrance plays once: the last tile starts about half a second in.
  useEffect(() => {
    if (!entering) return;
    const timer = window.setTimeout(() => setEntering(false), 1_100);

    return () => window.clearTimeout(timer);
  }, [entering]);

  /** Fits the live previews and the audit sheet in the part of the canvas the top bar, the chat dock and the audit panel leave free; open: keys of tiles shown uncropped. */
  function matrixCamera(state: CanvasState, report: AuditReport | null, forming: FormingAudit | null, panel: boolean, focus: string[] | null = null, open: ReadonlySet<string> = new Set()): Camera {
    const live = PREVIEW_IDS.map((id) => state.boards[id]);
    const { boards, sheet, stage } = auditMatrix(report, forming, live, open, focus);

    return freeCamera([...live.map(framed), ...boards, ...sheet ? [sheet.frame] : [], ...stage ? [stage.frame, ...stage.boards] : []], panel, OVERVIEW_MIN_ZOOM);
  }

  // Entering, switching or leaving the stage flies the camera to the new arrangement and crops the stage's tiles again.
  const stagedId = stagedFinding?.id ?? null;
  const lastStaged = useRef<string | null>(null);

  useEffect(() => {
    if (lastStaged.current === stagedId) return;
    lastStaged.current = stagedId;
    // The stage's tiles crop again, and a tile a peek opened closes with the peek.
    const open = new Set([...expanded].filter((key) => !key.startsWith("stage:") && !(peek?.opened && key === peek.profileId)));

    setPeek(null);
    setExpanded((current) => current.size === open.size ? current : open);

    if (!audit || forming) return;
    const base = unfocus(layoutRef.current);
    setLayout((current) => unfocus(current));
    flyTo(matrixCamera(base, audit, null, panelOpenRef.current, stageFocusRef.current, open), base.camera);
  // flyTo and matrixCamera read refs; the stage changing is the only trigger.
  }, [stagedId]);

  /** Opens or crops every tile on the stage at once. */
  function expandStage(open: boolean) {
    const keys = matrix.stage?.boards.map((board) => board.key) ?? [];
    setExpanded((current) => {
      const next = new Set([...current].filter((key) => !keys.includes(key)));

      if (open) keys.forEach((key) => next.add(key));

      return next;
    });
  }

  /**
   * The canvas column, in canvas px: the left edge and width the top bar, the chat dock and the floating bars share
   * (see .workspace in workspace.css, whose variables this reads), with the audit panel open or not. Fits fill it edge
   * to edge, so boards that fill its width line up with the top bar and the chat above and below them.
   */
  function canvasColumn(panel: boolean) {
    const element = canvas.current;
    const host = element?.closest<HTMLElement>(".workspace");

    if (!element || !host) return { x: geometry.current.x, width: geometry.current.width };
    const style = getComputedStyle(host);
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);

    const length = (name: string) => {
      const value = style.getPropertyValue(name).trim();

      return (parseFloat(value) || 0) * (value.endsWith("rem") ? rem : 1);
    };

    const rail = length("--rail");
    const free = element.clientWidth - rail - (panel ? length("--audit-panel-width") + 2 * rail : rail);
    const width = Math.max(240, Math.min(free, length("--column-max") || free));

    return { x: rail + Math.max(0, (free - width) / 2), width };
  }

  /**
   * Fits boards in the canvas column, below the top bar and above the chat dock: every automatic fit (opening, focus,
   * Show at, handoff, the audit overview) goes through here, so no board header ever sits under the top bar.
   * reserve: more px kept clear under the top bar. slot: the px of a bar (the offer) to fit between the top bar and the
   * boards, the free height split evenly around it; slotTop then reports where the bar goes.
   */
  function freeCamera(boards: Artboard[], panel: boolean, minZoom: number, maxZoom = MAX_ZOOM, reserve = 0, slot = 0, slotTop?: { current: number }): Camera {
    const element = canvas.current;

    if (!element) return fitCamera(boards, geometry.current, geometry.current.headerHeight, minZoom, maxZoom);
    const rect = element.getBoundingClientRect();
    const bar = element.parentElement?.querySelector(".topbar")?.getBoundingClientRect();
    const dock = element.parentElement?.querySelector(".chat-dock")?.getBoundingClientRect();
    const top = (bar ? Math.max(0, bar.bottom - rect.top) : 0) + reserve;
    // An expanded chat covers too much to fit above; the boards then go behind it like the live previews do.
    const bottom = dock?.height && dock.top - rect.top > rect.height / 2 ? dock.top - rect.top : rect.height;
    const camera = fitCamera(boards, { ...canvasColumn(panel), height: bottom - top, gutter: 0, gap: rect.width > 640 ? GAP : 24, slot }, geometry.current.headerHeight, minZoom, maxZoom);

    // The boards' top less the bar and the even space above and below it.
    if (slotTop) slotTop.current = top + (camera.y + Math.min(...boards.map((board) => board.y)) * camera.zoom - slot) / 2;

    return { ...camera, y: camera.y + top };
  }

  /**
   * Opens the panel beside the two live previews for the entry audit, and settles the previews into the canvas the panel
   * leaves free, unless the user moved the camera since the canvas opened.
   */
  function enterAudit() {
    const wide = matchMedia("(min-width: 1100px)").matches;

    if (wide) setPanelOpen(true);

    if (!canvas.current || !sameCamera(layoutRef.current.camera, entryCamera.current)) return;
    const base = unfocus(layoutRef.current);
    setLayout((current) => unfocus(current));
    entryCamera.current = freeCamera(PREVIEW_IDS.map((id) => framed(base.boards[id])), wide, FIT_MIN_ZOOM);
    flyTo(entryCamera.current, base.camera, 360);
  }

  /**
   * Makes room for the offer (open) or takes it back (closing): the live previews glide so the top bar, the offer, the
   * previews and the chat sit evenly apart, unless the user moved the camera since the canvas opened.
   */
  function settleOffer(open: boolean) {
    if (!canvas.current || !sameCamera(layoutRef.current.camera, entryCamera.current)) return;
    const top = { current: 0 };
    entryCamera.current = freeCamera(PREVIEW_IDS.map((id) => framed(layoutRef.current.boards[id])), panelOpenRef.current, FIT_MIN_ZOOM, MAX_ZOOM, 0, open ? OFFER_SLOT : 0, top);

    if (open) setOfferTop(top.current);
    flyTo(entryCamera.current, layoutRef.current.camera, 360);
  }

  /** The offer's dismiss: it leaves, and the previews take its space back. */
  function dismissOffer() {
    setOffer("leaving");
    settleOffer(false);
  }

  /** Audits the Desktop preview's route, or the given route (an open page of a site audit). The entry run keeps its snapshots for the offer and the camera on the live previews. */
  async function runAudit(target?: string, entry = false) {
    if (!window.mauxi || auditRunning || hostAudit) return;
    const route = target ?? desktopRoute();

    // A run the user starts shows its snapshots forming; the entry run keeps them for the offer.
    if (!entry) showSheet();

    ownRun.current = true;
    setAuditRunning(true); setAuditError(""); setAuditProgress(null); setStreamed([]);

    try {
      const pending = window.mauxi.auditRun(active ? { workspaceId: active.workspaceId, route } : { route, fixture });

      if (entry) enterAudit();
      const report = await pending;

      // No report: the workspace closed under the run. That is not a failure, and its layout must not change (or be saved) any more.
      // Held, the entry report goes to the panel and the offer; the camera stays on the live previews.
      if (report) showReport(report, !heldRef.current);

      if (report && heldRef.current) settleOffer(true);
    } catch (error) {
      setAuditError(errorText(error));
    } finally { ownRun.current = false; setAuditRunning(false); }
  }

  // The canvas opens with the audit: once the Desktop preview is ready, run it unless another run already covers the entry.
  // While the agent holds the browser it waits: the agent is checking the previews and audits them itself when it needs to.
  useEffect(() => {
    if (manualAudit || entryAudit.current === session || !window.mauxi || !runtimes.desktop.ready || active?.status === "failed") return;

    if (audit || auditRunning || hostAudit || site.mode !== "off" || site.running || site.discovering) { entryAudit.current = session; showSheet();

    return; }

    if (browser.locked) return;
    entryAudit.current = session;
    void runAudit(undefined, true);
  });

  function startSite() {
    setAuditProgress(null); setAuditError("");
    void site.discover(desktopRoute());
  }

  function selectFinding(finding: AuditFinding) {
    showSheet();
    setSelectedFinding((current) => current === finding.id ? null : finding.id);
  }

  useEffect(() => {
    if (!showing) return;
    const runtime = runtimes[showing.id];
    const settled = runtime.ready && runtime.generation !== showing.stale;

    const timer = window.setTimeout(() => {
      // Control handed to the agent after Show at was clicked: drop the outline, it would scroll the page under the agent.
      if (browserLocked.current) setNotice(`Return browser control to show this finding in the ${LABELS[showing.id]} preview.`);
      else if (settled && runtime.route.replace(/#.*$/, "") === showing.route.replace(/#.*$/, "")) send(showing.id, { kind: "highlight", selector: showing.selector, label: showing.label });
      else setNotice(`${LABELS[showing.id]} preview did not open ${showing.route}; the finding was not outlined.`);
      setShowing((current) => current === showing ? null : current);
    }, settled ? 350 : Math.max(0, showing.deadline - Date.now()));

    return () => window.clearTimeout(timer);
  }, [showing, runtimes, send]);

  /** Opens a cropped tile (by its key) downward in place, or crops an open one keeping its bottom (where its button was) in place. */
  function toggleTile(key: string) {
    const next = new Set(expanded);

    if (!next.delete(key)) { next.add(key); setExpanded(next);

      return; }

    const live = PREVIEW_IDS.map((id) => layoutRef.current.boards[id]);
    const open = matrixTile(matrix, key);
    const cropped = matrixTile(auditMatrix(audit, null, live, next, stageFocus), key);
    setExpanded(next);

    if (peek?.profileId === key) setPeek({ ...peek, opened: false });

    if (open && cropped) setLayout((current) => ({ ...current, camera: { ...current.camera, y: current.camera.y + (open.height - cropped.height) * current.camera.zoom } }));
  }

  /** Animates the camera to target (280 ms unless told otherwise, easing out) through the canvas point at the screen centre; instant under reduced motion. */
  /** from: the camera the flight starts at, when the state just changed under it (e.g. unfocusing). */
  function flyTo(target: Camera, from = layoutRef.current.camera, duration = 280) {
    stopFlight();

    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { setLayout((current) => ({ ...current, camera: target }));

      return; }

    const { x, width, height } = geometry.current;
    const middle = x + width / 2;
    const centre = (camera: Camera) => ({ x: (middle - camera.x) / camera.zoom, y: (height / 2 - camera.y) / camera.zoom });
    const [a, b] = [centre(from), centre(target)];
    const start = performance.now();

    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const k = 1 - (1 - t) ** 5;
      const zoom = from.zoom * (target.zoom / from.zoom) ** k;
      const point = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
      setLayout((current) => ({ ...current, camera: t === 1 ? target : { x: middle - point.x * zoom, y: height / 2 - point.y * zoom, zoom } }));
      flight.current = t < 1 ? requestAnimationFrame(step) : null;
    };

    flight.current = requestAnimationFrame(step);
  }

  /**
   * Peeks at one audit sheet tile: opens its full page and flies the camera to it, at most at the snapshot's own pixel
   * size, showing its top with the caption or, for a finding (a Seen at chip), a screen around its marker. Esc or Back
   * returns to the camera before the first peek and crops the tile again if the peek opened it.
   */
  function peekAt(key: string, finding?: AuditFinding) {
    if (!audit || forming) return;
    showSheet();
    const live = PREVIEW_IDS.map((id) => layoutRef.current.boards[id]);
    // Switching tiles crops the one the last peek opened.
    const base = new Set(expanded);

    if (peek?.opened && peek.profileId !== key) base.delete(peek.profileId);
    const tile = matrixTile(auditMatrix(audit, null, live, base, stageFocus), key);

    if (!tile) return;
    const profileId = tile.id;
    const opened = tile.cropped;
    const open = opened ? new Set([...base, key]) : base;
    const target = opened ? matrixTile(auditMatrix(audit, null, live, open, stageFocus), key)! : tile;
    const marker = finding?.markers.find((item) => item.profileId === profileId);
    const view = Math.min(target.height, Math.max(target.width * 1.6, 560));
    const from = marker ? Math.max(0, Math.min(target.height - view, Math.max(0, marker.rect.y) * target.scale - view / 3)) : 0;
    const caption = from === 0 ? CAPTION : 0;
    const header = geometry.current.headerHeight;
    const camera = freeCamera([{ x: target.x, y: target.y + from, width: target.width, height: view, inset: caption - header }], panelOpenRef.current, OVERVIEW_MIN_ZOOM, Math.min(MAX_ZOOM, 1 / target.scale), PEEK_BAR_SPACE);

    setExpanded(open);
    setPeek({ profileId: key, label: tile.label, camera: peek?.camera ?? layoutRef.current.camera, opened: opened || (!!peek?.opened && peek.profileId === key) });

    if (finding) setSelectedFinding(finding.id);
    setLayout((current) => unfocus(current));
    flyTo({ ...camera, y: camera.y - (header + target.inset - caption) });
  }

  function endPeek() {
    if (!peek) return;

    if (peek.opened) setExpanded((current) => { const next = new Set(current); next.delete(peek.profileId);

      return next; });

    setPeek(null);
    flyTo(peek.camera);
  }

  /** Brings everything on the canvas back into view: the live previews and, when there is one, the audit sheet or stage. */
  function fitAll() {
    if (browserLocked.current) return;

    if (audit) showSheet();

    const open = new Set(expanded);

    if (peek?.opened) { open.delete(peek.profileId); setExpanded(open); }

    setPeek(null);
    const base = unfocus(layoutRef.current);
    setLayout((current) => unfocus(current));
    flyTo(matrixCamera(base, audit, forming ? { snapshots: streamed, current: measuring } : null, panelOpenRef.current, forming ? null : stageFocusRef.current, open), base.camera);
  }

  const endPeekRef = useRef(endPeek); endPeekRef.current = endPeek;
  const peeking = !!peek;
  const staging = !!stagedId;

  // Esc ends a peek, or else leaves the stage, before the canvas handles it, anywhere but in a text field.
  useEffect(() => {
    if (!peeking && !staging) return;

    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;

      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="dialog"], dialog')) return;
      event.preventDefault();

      if (peeking) endPeekRef.current(); else setSelectedFinding(null);
    };

    window.addEventListener("keydown", keydown, true);

    return () => window.removeEventListener("keydown", keydown, true);
  }, [peeking, staging]);

  /**
   * Resizes a live preview to a width chosen on the width scope: Mobile up to 1024 px, Desktop above, keeping its height.
   * A wider Desktop pushes a Mobile preview on its right along. Refused while the agent holds browser control.
   */
  function scrubTo(width: number, phase: "start" | "move" | "end") {
    if (browserLocked.current) {
      setScrub((current) => current && { ...current, frozen: null });
      setNotice("Return browser control to resize the previews.");

      return;
    }

    const id: PreviewId = width <= 1024 ? "mobile" : "desktop";
    setScrub((current) => ({ width, frozen: phase === "end" ? null : current?.frozen ?? PREVIEW_IDS.map((preview) => layoutRef.current.boards[preview]) }));
    setLayout((current) => {
      const restored = unfocus(current);
      const board = restored.boards[id];

      if (board.width === width) return restored;
      const boards = { ...restored.boards, [id]: { ...board, width } };
      const mobile = restored.boards.mobile;

      if (id === "desktop" && mobile.x >= board.x + board.width) boards.mobile = { ...mobile, x: mobile.x + width - board.width };

      return { ...restored, boards };
    });
    setActivePreview(id);
  }

  /** Opens the finding's route in the closest live preview, resizes it to the worst width and outlines the element there. */
  function showFinding(finding: AuditFinding) {
    setSelectedFinding(finding.id);
    const id: PreviewId = finding.worst.width <= 1024 ? "mobile" : "desktop";
    const runtime = runtimeRef.current[id];
    const page = (route: string) => route.replace(/#.*$/, "");
    const route = audit ? supportedRoute(audit.route, origin) : null;
    const navigating = !!audit && page(projectRoute(audit.route, origin) ?? audit.route) !== page(runtime.route);

    // While the agent holds the browser, resizing, navigating or outlining (which scrolls) would move the page under it.
    if (browserLocked.current || (navigating && !route)) {
      setShowing(null);
      setNotice(browserLocked.current ? `Return browser control to show this finding in the ${LABELS[id]} preview.` : `${audit!.route} cannot be opened in a preview.`);

      return;
    }

    const width = Math.max(240, Math.min(3840, finding.worst.width));
    setLayout((current) => {
      const restored = unfocus(current);
      const board = { ...restored.boards[id], width, height: Math.max(240, Math.min(2160, finding.worst.height)) };

      return { ...restored, boards: { ...restored.boards, [id]: board }, camera: freeCamera([framed(board)], panelOpenRef.current, FIT_MIN_ZOOM) };
    });
    setActivePreview(id);
    setShowing({ id, route: route ?? runtime.route, stale: navigating ? runtime.generation : null, deadline: Date.now() + 15_000, selector: finding.element?.selector ?? null, label: finding.title.slice(0, 160) });

    if (navigating) navigate({ previewId: id, route: route!, navigationId: crypto.randomUUID() });
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
      {active && onClose ? <RepositoryMenu root={active.appRoot} onClose={async () => {
        await persist(layoutRef.current);
        // Detach the previews first so stopping the dev server cannot fail their in-flight loads.
        flushSync(() => setClosing(true));

        try { await onClose(); } catch (error) { setClosing(false); throw error; }
      }} /> : <div className="brand"><img className="brand-mark" src={logo} alt="Mauxi" /></div>}
      <WidthScope findings={scopeFindings} lit={scopeFindings.find((finding) => finding.id === (panelOpen ? hoveredFinding ?? selectedFinding : selectedFinding)) ?? null}
        value={scrub?.width ?? layout.boards.mobile.width} locked={browser.locked} active={!!audit || forming} onScrub={scrubTo} />
      {!panelOpen && <button type="button" className="audit-launcher" aria-expanded={false} onClick={() => setPanelOpen(true)} title="Open the responsive audit" aria-label="Responsive audit">
        <ScanSearch size={16} aria-hidden="true" /><span className="audit-launcher-label">Responsive audit</span>{audit && <span className="audit-launcher-count" aria-hidden="true">{audit.summary.bug}</span>}
      </button>}
      <label className="zoom"><span>{Math.round(layout.camera.zoom * 100)}%</span><input aria-label="Camera zoom" aria-valuetext={`${Math.round(layout.camera.zoom * 100)}%`} type="range" min={zoomFloor(layout.camera)} max={MAX_ZOOM} step="0.01" value={layout.camera.zoom} disabled={browser.locked} onChange={(event) => changeZoom(Number(event.target.value))} /></label>
      <button type="button" className="canvas-fit" aria-label="Fit everything in view" title="Fit everything in view" disabled={browser.locked} onClick={fitAll}><Maximize size={16} aria-hidden="true" /></button>
    </header>
    {audit && (offer === "leaving" || offerShown.current) && <SnapshotOffer report={audit} leaving={offer === "leaving"} onShow={acceptOffer} top={offerTop} onDismiss={dismissOffer} onGone={() => setOffer("closed")} />}
    {peek && <div className="peek-bar" role="status"><span>Peeking at <strong>{peek.label}</strong></span><button type="button" onClick={endPeek}><ArrowLeft size={14} aria-hidden="true" />Back<kbd>Esc</kbd></button></div>}
    {(statusText || browser.error || browser.locked) && <div className="canvas-notices">
      {browser.locked && <div className="agent-control" role="status" title="The agent is checking the previews. Route linking stays paused; re-enable it in a preview's actions afterwards.">
        <span className="agent-control-dot" aria-hidden="true" />Agent has control
        <button type="button" className="take-back" aria-label="Emergency take back control" onClick={() => void browser.owner("human")}>Take back</button>
      </div>}
      {(browser.error || statusText) && <div className="workspace-notice" role="status">{browser.error || statusText}</div>}
    </div>}
    <main ref={canvas} className={`canvas ${navigationHeld ? "hand-mode" : ""} ${dragging ? "dragging" : ""}`} data-testid="canvas" data-sheet-entering={entering || undefined} data-navigation-gesture={navigation.wheeling} aria-label="Preview canvas" tabIndex={0}
      onPointerDownCapture={event => { if (event.button === 0) minimizeChat(); }}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) { if (!browserLocked.current && !navigationHeld) navigation.exit(); startDrag(null, event); }
        else if (navigationHeld) startDrag(null, event);
      }}
      onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
      onKeyDown={(event) => { if (browserLocked.current || event.target !== event.currentTarget) return;

      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); stopFlight(); setLayout((current) => ({ ...current, camera: { ...current.camera, x: current.camera.x + (event.key === "ArrowLeft" ? 40 : event.key === "ArrowRight" ? -40 : 0), y: current.camera.y + (event.key === "ArrowUp" ? 40 : event.key === "ArrowDown" ? -40 : 0) } })); } }}>
      {!held && <AuditBoards matrix={matrix} report={audit} forming={forming} camera={layout.camera} selected={selectedFinding} spotlight={panelOpen ? hoveredFinding ?? selectedFinding : selectedFinding} ignored={ignoredFindings}
        expanded={expanded} peek={peek?.profileId ?? null}
        onSelect={(finding) => setSelectedFinding(finding.id)} onExpand={toggleTile} onPeek={(key) => peekAt(key)}
        onShow={showFinding} onExpandStage={expandStage} onUnstage={() => setSelectedFinding(null)} />}
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
            {!closing && <iframe ref={(node) => { frames.current[id] = node; }} name={`mauxi-preview:${active?.workspaceId ?? "proof"}:${id}`} data-testid={`${id}-preview`} title={`${LABELS[id]} preview`} src={urls[id]} onLoad={() => connectFrame(id)} width={board.width} height={board.height} style={{ transform: `scale(${zoom})` }} tabIndex={shielded || browser.locked ? -1 : 0} inert={shielded || browser.locked} sandbox="allow-scripts allow-forms allow-same-origin allow-modals" />}
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
    {panelOpen && <AuditPanel onClose={() => setPanelOpen(false)} report={siteView ? null : audit} progress={auditProgress} running={auditRunning || hostAudit || site.discovering || site.running} error={auditError || site.error} selected={selectedFinding} attached={new Set(attachedFindings.map((item) => item.id))} ignored={ignoredFindings}
      onRun={() => void runAudit(site.mode === "page" ? site.page ?? undefined : undefined)} onCancel={() => void window.mauxi?.auditCancel()} onSelect={selectFinding} onShow={showFinding} onFix={attachFinding} onIgnore={toggleIgnored} onHover={(finding) => setHoveredFinding(finding?.id ?? null)} onLocate={(finding, profileId) => peekAt(matrix.stage?.boards.some((board) => board.id === profileId) ? `stage:${profileId}` : profileId, finding)}
      onSite={startSite} siteView={siteView} pageBar={site.mode === "page" && <SitePageBar report={site.report} page={site.page} onBack={site.back} />} />}
    </div>
    {tools && <PreviewTools id={tools} linked={layout.linked} onToggleLinked={() => { if (!browserLocked.current) setLayout(current => ({ ...current, linked: !current.linked })); }} selecting={selecting === tools} focused={layout.focus?.previewId === tools} onSelect={() => { toggleSelection(tools); setTools(null); }} onFocus={() => { focus(tools); setTools(null); }} board={layout.boards[tools]} ready={runtimes[tools].ready} canCopy={PREVIEW_IDS.every((id) => runtimes[id].ready) && runtimes[tools].safe && !!supportedRoute(runtimes[tools].route, origin)} canCapture={!!window.mauxi && fullyVisible(tools)} onClose={() => setTools(null)} onReload={() => { if (runtimeRef.current[tools].ready) send(tools, { kind: "reload" }); else if (frames.current[tools]) frames.current[tools]!.src = urls[tools]; setTools(null); }} onCopy={() => { navigate(routes.copy(tools)); setTools(null); }} onCapture={() => void capture(tools)} onResize={(width, height) => { setLayout((current) => { const next = { ...current, boards: { ...current.boards, [tools]: { ...current.boards[tools], width, height } } };

    return next.focus ? { ...next, camera: freeCamera([framed(next.boards[next.focus.previewId])], panelOpenRef.current, FIT_MIN_ZOOM) } : next; }); setTools(null); }} />}
  </div>;
}
