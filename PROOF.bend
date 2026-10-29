# Proofs for LAWS.bend. Every law reduces to a lemma by induction on the
# list: cap and the stale masks emit one entry per input, cap never emits
# more Trues than its budget, and cap only keeps Trues it was given.

import Base
import ./bend/selection.bend as S
import ./LAWS.bend as Laws

# One step of cap: whatever b and n are, the head adds one entry, and the
# hypothesis (taken for every budget) covers the tail.
def cap_step(b: Bool, -t: List<Bool>, -m: Nat, n: Nat,
  ih: @k:Nat -> {List.length(&1, Bool, S.Selection.cap(t, k)) == m : Nat})
  -> {List.length(&1, Bool, S.Selection.cap(b <> t, n)) == 1n+m : Nat}:
  match b n:
    case True{} 1n+k:
      %ih(k) : {1n+List.length(&1, Bool, S.Selection.cap(t, k)) == 1n+_ : Nat}
      {==}
    case True{} 0n:
      %ih(0n) : {1n+List.length(&1, Bool, S.Selection.cap(t, 0n)) == 1n+_ : Nat}
      {==}
    case False{} k:
      %ih(k) : {1n+List.length(&1, Bool, S.Selection.cap(t, k)) == 1n+_ : Nat}
      {==}

def markers_len(xs: List<S.Sel>, n: Nat, +p: String, +g: String) -> {List.length(&1, Bool, S.Selection.markers(xs, n, p, g)) == List.length(&1, S.Sel, xs) : Nat}:
  match xs:
    case Nil{}:
      {==}
    case Con{s, t}:
      cap_step(S.Selection.live(p, g, s), S.Selection.live_mask(t, p, g), List.length(&1, S.Sel, t), n, k => markers_len(t, k, p, g))

def Laws.markers_aligned(xs, n, p, g):
  markers_len(xs, n, p, g)

def Laws.route_aligned(xs, p):
  match xs:
    case Nil{}:
      {==}
    case Con{S.Sel{preview, generation, current, repick}, t}:
      %Laws.route_aligned(t, p) : {1n+List.length(&1, Bool, S.Selection.stale_after_route(t, p)) == 1n+_ : Nat}
      {==}

def Laws.document_aligned(xs, p, g):
  match xs:
    case Nil{}:
      {==}
    case Con{S.Sel{preview, generation, current, repick}, t}:
      %Laws.document_aligned(t, p, g) : {1n+List.length(&1, Bool, S.Selection.stale_after_document(t, p, g)) == 1n+_ : Nat}
      {==}

def le_zero(n: Nat) -> {Nat.is_le(0n, n) == True{} : Bool}:
  match n:
    case 0n:
      {==}
    case 1n+k:
      {==}

def cap_count(bs: List<Bool>, n: Nat) -> {Nat.is_le(Laws.count(S.Selection.cap(bs, n)), n) == True{} : Bool}:
  match bs:
    case Nil{}:
      le_zero(n)
    case Con{b, t}:
      match b n:
        case True{} 1n+k:
          cap_count(t, k)
        case True{} 0n:
          cap_count(t, 0n)
        case False{} m:
          cap_count(t, m)

def Laws.markers_capped(xs, n, p, g):
  cap_count(S.Selection.live_mask(xs, p, g), n)

def cap_within(bs: List<Bool>, n: Nat) -> {Laws.within(S.Selection.cap(bs, n), bs) == True{} : Bool}:
  match bs:
    case Nil{}:
      {==}
    case Con{b, t}:
      match b n:
        case True{} 1n+k:
          cap_within(t, k)
        case True{} 0n:
          cap_within(t, 0n)
        case False{} m:
          cap_within(t, m)

def Laws.markers_live(xs, n, p, g):
  cap_within(S.Selection.live_mask(xs, p, g), n)

def Laws.route_exact(xs, p):
  match xs:
    case Nil{}:
      {==}
    case Con{S.Sel{preview, generation, current, repick}, t}:
      %Laws.route_exact(t, p) : {String.eq(preview, p) <> S.Selection.stale_after_route(t, p) == String.eq(preview, p) <> _ : List<Bool>}
      {==}

# within's head check, (not(a && b) || a) or (not(a && b) || b), is True for
# every a and b, so each step reduces to the hypothesis on the tail.
def keep_left(a: Bool, b: Bool, -r: Bool, ih: {r == True{} : Bool}) -> {(Bool.not(a && b) || a) && r == True{} : Bool}:
  match a b:
    case True{} True{}:
      ih
    case True{} False{}:
      ih
    case False{} True{}:
      ih
    case False{} False{}:
      ih

def keep_right(a: Bool, b: Bool, -r: Bool, ih: {r == True{} : Bool}) -> {(Bool.not(a && b) || b) && r == True{} : Bool}:
  match a b:
    case True{} True{}:
      ih
    case True{} False{}:
      ih
    case False{} True{}:
      ih
    case False{} False{}:
      ih

def Laws.document_same_preview(xs, p, g):
  match xs:
    case Nil{}:
      {==}
    case Con{S.Sel{preview, generation, current, repick}, t}:
      keep_left(String.eq(preview, p), Bool.not(String.eq(generation, g)),
        Laws.within(S.Selection.stale_after_document(t, p, g), Laws.on_preview(t, p)),
        Laws.document_same_preview(t, p, g))

def Laws.document_keeps_new(xs, p, g):
  match xs:
    case Nil{}:
      {==}
    case Con{S.Sel{preview, generation, current, repick}, t}:
      keep_right(String.eq(preview, p), Bool.not(String.eq(generation, g)),
        Laws.within(S.Selection.stale_after_document(t, p, g), Laws.off_document(t, g)),
        Laws.document_keeps_new(t, p, g))
