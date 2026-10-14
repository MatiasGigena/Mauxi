"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { gsap } from "gsap";

export function MotionProof() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update(); query.addEventListener("change", update);

    return () => query.removeEventListener("change", update);
  }, []);
  const target = useRef<HTMLButtonElement>(null);
  const [clicks, setClicks] = useState(0);
  useEffect(() => {
    const media = gsap.matchMedia();
    media.add("(prefers-reduced-motion: no-preference)", () => {
      gsap.to(target.current, { x: 48, duration: 1, repeat: -1, yoyo: true, ease: "none" });
    });

    return () => media.revert();
  }, []);

  return (
    <section aria-label="Animation fixture" style={{ padding: "24px 0", overflow: "hidden" }}>
      <h2>Motion and GSAP</h2>
      <motion.div animate={{ x: reduced ? 0 : [0, 48, 0] }} transition={{ duration: reduced ? 0 : 2, repeat: reduced ? 0 : Infinity, ease: "linear" }}>
        <button data-testid="motion-target" onClick={() => setClicks(value => value + 1)}>Motion moving target</button>
      </motion.div>
      <button ref={target} data-testid="gsap-target" onClick={() => setClicks(value => value + 1)}>GSAP moving target</button>
      <output data-testid="motion-clicks">Animation clicks: {clicks}</output>
    </section>
  );
}
