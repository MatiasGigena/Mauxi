# Selection freshness decisions for Mauxi's picked elements.
#
# TypeScript keeps the full SelectionCapture records; it hands Bend one Sel per
# stored selection and applies the Bool mask Bend returns, index for index.

import Base

type Sel is Data:
  Sel{preview: String, generation: String, current: Bool, repick: Bool}

# True when s is a current, still-valid pick on this preview's live document.
def Selection.live(+p: String, +g: String, s: Sel) -> Bool:
  match s:
    case Sel{preview, generation, current, repick}:
      current && Bool.not(repick) && String.eq(preview, p) && String.eq(generation, g)

# Which selections are live, in order.
def Selection.live_mask(xs: List<Sel>, +p: String, +g: String) -> List<Bool>:
  match xs:
    case Nil{}:
      Nil{}
    case Con{s, t}:
      Selection.live(p, g, s) <> Selection.live_mask(t, p, g)

# Keeps the first n True entries of a mask and clears the rest.
def Selection.cap(bs: List<Bool>, n: Nat) -> List<Bool>:
  match bs:
    case Nil{}:
      Nil{}
    case Con{b, t}:
      match b n:
        case True{} 1n+k:
          True{} <> Selection.cap(t, k)
        case True{} 0n:
          False{} <> Selection.cap(t, 0n)
        case False{} m:
          False{} <> Selection.cap(t, m)

# Marks at most n live selections, in order.
def Selection.markers(xs: List<Sel>, n: Nat, +p: String, +g: String) -> List<Bool>:
  Selection.cap(Selection.live_mask(xs, p, g), n)

# A route change invalidates every selection captured on that preview.
def Selection.stale_after_route(xs: List<Sel>, +p: String) -> List<Bool>:
  match xs:
    case Nil{}:
      Nil{}
    case Con{Sel{preview, generation, current, repick}, t}:
      String.eq(preview, p) <> Selection.stale_after_route(t, p)

# A document change invalidates that preview's selections from older documents.
def Selection.stale_after_document(xs: List<Sel>, +p: String, +g: String) -> List<Bool>:
  match xs:
    case Nil{}:
      Nil{}
    case Con{Sel{preview, generation, current, repick}, t}:
      (String.eq(preview, p) && Bool.not(String.eq(generation, g))) <> Selection.stale_after_document(t, p, g)
