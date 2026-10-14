import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { CANVAS_GRID_SIZE, CANVAS_TRAIL_SPEED, canvasTrailGeometry, nearestTrailDistance, trailPointAt, type CanvasTrailGeometry, type CanvasViewBounds } from "./canvas-background";
import "./canvas-background.css";

export function CanvasBackground() {
  const layer = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const node = layer.current!;
    const surface = node.closest(".canvas-surface")!;
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    let animations: Animation[] = [];
    let geometry: CanvasTrailGeometry | null = null;
    let signature = "";
    let initialViews: CanvasViewBounds[] | null = null;
    let startupFrame = 0;
    const stop = () => {
      animations.forEach(animation => animation.cancel());
      animations = [];
      node.replaceChildren();
    };
    const syncPlayback = () => animations.forEach(animation => {
      if (document.hidden) animation.pause();
      else animation.play();
    });
    const build = () => {
      if (!initialViews) return;
      const { width, height } = node.getBoundingClientRect();
      const views = initialViews.map(view => ({ x: view.x * width, y: view.y * height, width: view.width * width, height: view.height * height }));
      const next = preference.matches ? null : canvasTrailGeometry(width, height, views);
      const nextSignature = JSON.stringify(next?.edges ?? []);
      if (signature === nextSignature) return;
      const progress = animations[0]?.effect?.getComputedTiming().progress;
      const oldHead = geometry && progress != null ? trailPointAt(geometry, progress * geometry.total) : null;
      stop();
      geometry = next;
      signature = nextSignature;
      if (!next) return;
      const { edges, total, trailLength } = next;
      const initialHead = oldHead ? nearestTrailDistance(next, oldHead) : next.initialHead;
      for (const edge of edges) {
        const clip = document.createElement("span");
        clip.className = "canvas-trail-edge";
        clip.style.width = `${edge.length}px`;
        clip.style.transform = `translate(${edge.x}px, ${edge.y}px) rotate(${edge.angle}deg)`;
        const strip = document.createElement("span");
        strip.className = "canvas-trail-strip";
        strip.style.width = `${trailLength}px`;
        clip.append(strip);
        node.append(clip);
        animations.push(strip.animate([
          { transform: `translateX(${-trailLength}px)` },
          { transform: `translateX(${total - trailLength}px)` },
        ], {
          duration: total / CANVAS_TRAIL_SPEED * 1000,
          delay: -((total - edge.start + initialHead) % total) / CANVAS_TRAIL_SPEED * 1000,
          iterations: Infinity,
          easing: "linear",
        }));
      }
      syncPlayback();
    };
    const observer = new ResizeObserver(build);
    observer.observe(node);
    startupFrame = requestAnimationFrame(() => {
      startupFrame = requestAnimationFrame(() => {
        const origin = node.getBoundingClientRect();
        if (origin.width <= 0 || origin.height <= 0) return;
        initialViews = [...surface.querySelectorAll<HTMLElement>(".artboard")]
          .filter(board => getComputedStyle(board).visibility !== "hidden")
          .map(board => {
            const rect = board.getBoundingClientRect();
            return { x: (rect.x - origin.x) / origin.width, y: (rect.y - origin.y) / origin.height, width: rect.width / origin.width, height: rect.height / origin.height };
          });
        build();
      });
    });
    preference.addEventListener("change", build);
    document.addEventListener("visibilitychange", syncPlayback);
    return () => {
      cancelAnimationFrame(startupFrame);
      observer.disconnect();
      preference.removeEventListener("change", build);
      document.removeEventListener("visibilitychange", syncPlayback);
      stop();
    };
  }, []);

  return <div className="canvas-background" aria-hidden="true" style={{ "--canvas-grid-size": `${CANVAS_GRID_SIZE}px` } as CSSProperties}>
    <div className="canvas-trail" ref={layer} />
  </div>;
}
