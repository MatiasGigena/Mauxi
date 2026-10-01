import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { PreviewId } from "../application/preview-contract";

// Wheel events have no portable gesture-end signal. Renew the lease for every
// event (including momentum), rather than releasing it when the cursor moves.
const WHEEL_IDLE_MS = 220;

export function useCanvasNavigation({ canvas, frames, locked, onExit }: {
  canvas: RefObject<HTMLElement | null>;
  frames: RefObject<Record<PreviewId, HTMLIFrameElement | null>>;
  locked: boolean;
  onExit: () => void;
}) {
  const [interactive, setInteractive] = useState<PreviewId | null>(null);
  const [space, setSpace] = useState(false);
  const [wheeling, setWheeling] = useState(false);
  const current = useRef({ locked, onExit }); current.current = { locked, onExit };
  const spaceDown = useRef(false);
  const restoreFrame = useRef<PreviewId | null>(null);
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopWheel = useCallback(() => {
    if (wheelTimer.current) clearTimeout(wheelTimer.current);
    wheelTimer.current = null; setWheeling(false);
  }, []);
  const beginWheel = useCallback(() => {
    if (current.current.locked) return;
    if (wheelTimer.current) clearTimeout(wheelTimer.current);
    setWheeling(true);
    wheelTimer.current = setTimeout(stopWheel, WHEEL_IDLE_MS);
  }, [stopWheel]);
  const activate = useCallback((id: PreviewId) => {
    if (current.current.locked || spaceDown.current || wheelTimer.current) return;
    setInteractive(id);
  }, []);
  // Focus in the same commit that removes inert, not a later animation frame
  // that could steal focus from the user's next click into chat. Never replay
  // the activation click into the page (it may cover a destructive action).
  useLayoutEffect(() => {
    if (interactive && !current.current.locked && !spaceDown.current && !wheelTimer.current) frames.current[interactive]?.contentWindow?.focus();
  }, [interactive, frames]);
  const exit = useCallback((notify = true) => {
    setInteractive(null);
    restoreFrame.current = null; spaceDown.current = false; setSpace(false);
    stopWheel(); if (notify) current.current.onExit();
    canvas.current?.focus({ preventScroll: true });
  }, [canvas, stopWheel]);
  const startSpace = useCallback((id: PreviewId | null = null) => {
    if (current.current.locked || spaceDown.current) return;
    restoreFrame.current = id;
    spaceDown.current = true;
    canvas.current?.focus({ preventScroll: true });
    setSpace(true);
  }, [canvas]);

  const endSpace = useCallback(() => {
    if (!spaceDown.current) return;
    spaceDown.current = false; setSpace(false);
  }, []);
  useLayoutEffect(() => {
    if (space || !restoreFrame.current) return;
    const id = restoreFrame.current; restoreFrame.current = null;
    if (!current.current.locked && document.activeElement === canvas.current) frames.current[id]?.contentWindow?.focus();
  });

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (current.current.locked || event.isComposing || event.defaultPrevented) return;
      const target = event.target;
      if (!(target instanceof Element) || (!canvas.current?.contains(target) && target !== document.body)) return;
      if (event.key === "Escape") { event.preventDefault(); exit(); return; }
      if (event.code !== "Space" || event.ctrlKey || event.metaKey || event.altKey || target.closest('input, textarea, select, button, a[href], [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return;
      event.preventDefault(); startSpace();
    };
    const keyup = (event: KeyboardEvent) => {
      if (event.code !== "Space" || !spaceDown.current) return;
      event.preventDefault(); endSpace();
    };
    const cancel = () => {
      spaceDown.current = false; restoreFrame.current = null; setSpace(false); stopWheel();
    };
    const blur = () => { if (!document.hasFocus()) cancel(); };
    const visibility = () => { if (document.hidden) cancel(); };
    window.addEventListener("keydown", keydown);
    window.addEventListener("keyup", keyup);
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("keydown", keydown); window.removeEventListener("keyup", keyup);
      window.removeEventListener("blur", blur); document.removeEventListener("visibilitychange", visibility);
      if (wheelTimer.current) clearTimeout(wheelTimer.current);
    };
  }, [canvas, exit, startSpace, endSpace, stopWheel]);
  useEffect(() => {
    if (!locked) return;
    setInteractive(null); spaceDown.current = false;
    restoreFrame.current = null; setSpace(false); stopWheel();
  }, [locked, stopWheel]);

  return { interactive, space, wheeling, activate, exit, startSpace, endSpace, beginWheel };
}
