// Types for selection.mjs, which `npm run bend:build` compiles from bend/selection.bend.

export type BendList<T> = { $: "Nil" } | { $: "Con"; head: T; tail: BendList<T> };

export interface BendSel { $: "Sel"; preview: string; generation: string; current: boolean; repick: boolean }

declare const selection: {
  "Selection.markers": (xs: BendList<BendSel>, n: number, preview: string, generation: string) => BendList<boolean>;
  "Selection.stale_after_route": (xs: BendList<BendSel>, preview: string) => BendList<boolean>;
  "Selection.stale_after_document": (xs: BendList<BendSel>, preview: string, generation: string) => BendList<boolean>;
};

export default selection;
