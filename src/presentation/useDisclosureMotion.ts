import { useEffect, useRef } from "react";
import { flushSync } from "react-dom";

const easeOut = "cubic-bezier(0.23, 1, 0.32, 1)";
const easeMove = "cubic-bezier(0.77, 0, 0.175, 1)";

type MotionChange = {
  moving: HTMLElement[];
  layers: HTMLElement[];
  update: () => void;
  opening: boolean;
  keyboard?: boolean;
};

export function useDisclosureMotion() {
  const animations = useRef<Animation[]>([]);

  function cancel() {
    animations.current.forEach(animation => animation.cancel());
    animations.current = [];
  }

  useEffect(() => {
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    window.addEventListener("resize", cancel);
    preference.addEventListener("change", cancel);

    return () => { cancel(); window.removeEventListener("resize", cancel); preference.removeEventListener("change", cancel); };
  }, []);

  function animate(node: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions) {
    const animation = node.animate(frames, options);
    animations.current.push(animation);
    animation.onfinish = () => { animation.cancel(); animations.current = animations.current.filter(item => item !== animation); };
  }

  function enter(nodes: HTMLElement[]) {
    cancel();
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    nodes.forEach((node, index) => {
      const frames: Keyframe[] = [{ opacity: 0 }, { opacity: 1 }];

      if (!reduce) { frames[0].transform = "translateY(8px)"; frames[1].transform = "translateY(0)"; }

      animate(node, frames, { id: "setup-entrance", duration: reduce ? 120 : 200, delay: reduce ? 0 : index * 20, easing: easeOut, fill: "backwards" });
    });
  }

  function change({ moving, layers, update, opening, keyboard = false }: MotionChange) {
    const before = moving.map(node => ({ top: node.getBoundingClientRect().top, opacity: Number(getComputedStyle(node).opacity) }));
    const appearances = layers.map(node => ({ opacity: Number(getComputedStyle(node).opacity), top: node.getBoundingClientRect().top }));
    cancel();
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    flushSync(update);

    if (keyboard) return;
    const duration = opening ? 220 : 180;
    moving.forEach((node, index) => {
      const delta = before[index].top - node.getBoundingClientRect().top;
      const fading = before[index].opacity < 1;

      if (!fading && (reduce || Math.abs(delta) <= .5)) return;
      const frames: Keyframe[] = [{}, {}];

      if (fading) { frames[0].opacity = before[index].opacity; frames[1].opacity = 1; }

      if (!reduce) { frames[0].transform = `translateY(${delta}px)`; frames[1].transform = "translateY(0)"; }

      animate(node, frames, { duration: reduce ? 100 : duration, easing: fading ? easeOut : easeMove });
    });
    layers.forEach((node, index) => {
      const visible = node.getAttribute("aria-hidden") !== "true";
      const from = appearances[index];

      if (!visible && from.opacity === 0) return;
      const delta = from.top - node.getBoundingClientRect().top;
      const fading = !visible || from.opacity < 1;

      if (!fading) {
        if (!reduce && Math.abs(delta) > .5) animate(node, [{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }], { duration, easing: easeMove });

        return;
      }

      const frames: Keyframe[] = [{ opacity: from.opacity, visibility: "visible" }, { opacity: visible ? 1 : 0, visibility: "visible" }];

      if (!reduce) {
        frames[0].transform = from.opacity < .01 ? "translateY(-6px)" : `translateY(${delta}px)`;
        frames[1].transform = visible ? "translateY(0)" : `translateY(${delta - 6}px)`;
      }

      animate(node, frames, { duration: reduce ? 100 : visible ? duration - 60 : 90, delay: reduce || !visible ? 0 : 60, fill: "both", easing: easeOut });
    });
  }

  return { change, cancel, enter };
}
