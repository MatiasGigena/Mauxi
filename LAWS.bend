# Rules Mauxi's selection freshness must never break.
# Humans own this file; PROOF.bend proves every law in it.

import Base
import ./bend/selection.bend as S

# Number of True entries in a mask.
def count(bs: List<Bool>) -> Nat:
  match bs:
    case Nil{}:
      0n
    case Con{b, t}:
      match b:
        case True{}:
          1n+count(t)
        case False{}:
          count(t)

# True when every True in the first mask is also True in the second.
def within(as: List<Bool>, bs: List<Bool>) -> Bool:
  match as bs:
    case Nil{} _:
      True{}
    case Con{a, at} Nil{}:
      Bool.not(a)
    case Con{a, at} Con{b, bt}:
      (Bool.not(a) || b) && within(at, bt)

# LAW: the marker mask has one entry per stored selection.
law markers_aligned:
  for xs: List<S.Sel>
  for +n: Nat
  for +p: String
  for +g: String
  {List.length(&1, Bool, S.Selection.markers(xs, n, p, g)) == List.length(&1, S.Sel, xs) : Nat}

# LAW: the route-change mask has one entry per stored selection.
law route_aligned:
  for xs: List<S.Sel>
  for +p: String
  {List.length(&1, Bool, S.Selection.stale_after_route(xs, p)) == List.length(&1, S.Sel, xs) : Nat}

# LAW: the document-change mask has one entry per stored selection.
law document_aligned:
  for xs: List<S.Sel>
  for +p: String
  for +g: String
  {List.length(&1, Bool, S.Selection.stale_after_document(xs, p, g)) == List.length(&1, S.Sel, xs) : Nat}

# LAW: never more than n markers.
law markers_capped:
  for xs: List<S.Sel>
  for +n: Nat
  for +p: String
  for +g: String
  {Nat.is_le(count(S.Selection.markers(xs, n, p, g)), n) == True{} : Bool}

# LAW: only live selections (current, no repick, this preview and document) get a marker.
law markers_live:
  for xs: List<S.Sel>
  for +n: Nat
  for +p: String
  for +g: String
  {within(S.Selection.markers(xs, n, p, g), S.Selection.live_mask(xs, p, g)) == True{} : Bool}

# Which selections were captured on preview p.
def on_preview(xs: List<S.Sel>, +p: String) -> List<Bool>:
  match xs:
    case Nil{}:
      Nil{}
    case Con{S.Sel{preview, generation, current, repick}, t}:
      String.eq(preview, p) <> on_preview(t, p)

# Which selections were captured on a document other than g.
def off_document(xs: List<S.Sel>, +g: String) -> List<Bool>:
  match xs:
    case Nil{}:
      Nil{}
    case Con{S.Sel{preview, generation, current, repick}, t}:
      Bool.not(String.eq(generation, g)) <> off_document(t, g)

# LAW: a route change on p stales exactly the selections on p, and no others.
law route_exact:
  for xs: List<S.Sel>
  for +p: String
  {S.Selection.stale_after_route(xs, p) == on_preview(xs, p) : List<Bool>}

# LAW: a document change on p never stales a selection on the other preview.
law document_same_preview:
  for xs: List<S.Sel>
  for +p: String
  for +g: String
  {within(S.Selection.stale_after_document(xs, p, g), on_preview(xs, p)) == True{} : Bool}

# LAW: a document change never stales a selection already on the new document.
law document_keeps_new:
  for xs: List<S.Sel>
  for +p: String
  for +g: String
  {within(S.Selection.stale_after_document(xs, p, g), off_document(xs, g)) == True{} : Bool}
