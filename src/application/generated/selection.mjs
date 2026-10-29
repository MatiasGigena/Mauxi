function word_to_u32(w) {
  let x = 0;
  for (let i = 0; w.$ === "WCon"; i++) {
    x |= Number(w.head) << i;
    w = w.tail;
  }
  return x >>> 0;
}

function u32_to_word(x) {
  let w = {$: "WNil"};
  for (let i = 31; i >= 0; i--) {
    w = {$: "WCon", head: ((x >>> i) & 1) === 1, tail: w};
  }
  return w;
}

function cmp_new(a, b) {
  return {$: a < b ? "LT" : a === b ? "EQ" : "GT"};
}

function nat_divmod(a, b) {
  return b === 0 ? {$: "Tuple", fst: 0, snd: a}
    : {$: "Tuple", fst: Math.trunc(a / b), snd: a % b};
}

function nat_chk(n) {
  if (n > 281474976710655) {
    throw "bend: a Nat past the largest immediate 2^48-1";
  }
  return n;
}

function nat_in(n) {
  if (!Number.isInteger(n) || n < 0 || n > 2 ** 53) {
    throw "bend: expected a Nat host number: an integer from 0 to 2^53";
  }
  return n;
}

function f32_show(x) {
  let s = "nan";
  for (let p = 1; x === x && p <= 9 && f32_round(s) !== x; p += 1) {
    s = String(Number(x.toExponential(p - 1)));
  }
  return (Object.is(x, -0) ? "-0" : s).replace("Infinity", "inf");
}

function f32_bits(x) {
  return new Uint32Array(new Float32Array([x]).buffer)[0];
}

function f32_from_bits(u) {
  return new Float32Array(new Uint32Array([u]).buffer)[0];
}

function f32_read(s) {
  const re = /^[\t\n\v\f\r ]*[+-]?((\d+(?:\.\d*)?|\.\d+)(e[+-]?\d+)?|inf(inity)?|nan)$/i;
  const v = f32_round(s.replace(/inf\w*/i, "Infinity"));
  return re.test(s) ? {$: "Some", value: v} : {$: "None"};
}

const f32_round = function f32_round(s) {
  const d = Number(s);
  const a = Math.abs(d);
  const f = Math.fround(a);
  const g = 2 * a - Math.min(f, 2 ** 128);
  if (g === f || Math.fround(g) !== g || g === Infinity) {
    return Math.sign(d) * f;
  }
  let k = 0;
  while (a * 2 ** k % 1 !== 0) {
    k += 1;
  }
  const [, i, r, e] = /(\d*)\.?(\d*)(?:e([+-]?\d+))?$/i.exec(s);
  const n = Number(e ?? 0) - r.length;
  const x = BigInt(i + r) * 2n ** BigInt(k) * 10n ** BigInt(Math.max(n, 0));
  const y = BigInt(a * 2 ** k) * 10n ** BigInt(Math.max(-n, 0));
  return Math.sign(d) * (x === y || x > y !== g > f ? f : g);
};

const char_new = function char_new(c) {
  return c < 55296 || c >= 57344 && c <= 1114111 ? String.fromCodePoint(c) : String.fromCharCode(56320, c >>> 22, c >>> 11 & 2047, c & 2047);
};

function char_len(s, at = 0) {
  return s[at] === "\uDC00" ? 4 : s.codePointAt(at) > 0xFFFF ? 2 : 1;
}

function char_code(s) {
  return s.length < 4 ? s.codePointAt(0)
    : (s.charCodeAt(1) << 22 | s.charCodeAt(2) << 11 | s.charCodeAt(3)) >>> 0;
}

function string_contains(s, p) {
  // A match must start at a Char boundary, not inside a packed U32 code.
  for (let at = 0; at <= s.length; at += char_len(s, at)) {
    if (s.startsWith(p, at)) {
      return true;
    }
  }
  return false;
}

function str_out(s) {
  return s.replace(/\uDC00[^]{3}/gu, "\uFFFD");
}

function str_in(s) {
  return s.replace(/\p{Cs}/gu, "\uFFFD");
}

// Array
// =====

function array_new(d, v) {
  if (d > 31) {
    throw "bend: an array past the deepest block class 31";
  }
  return Array(2 ** d).fill(v);
}

function array_node(a, b) {
  if (a.length !== b.length) {
    throw "bend: runtime fail-stop";
  }
  return a.concat(b);
}

function array_rmw(a, i, f) {
  const at = i % a.length;
  const old = a[at];
  a[at] = f(old);
  return {$: "Tuple", fst: a, snd: old};
}

// Run
// ===

function run_tail(f, x) {
  return {$: "$JMP", f: f.j?.f === f ? f.j : f, x};
}

function run_clo(j) {
  const f = (x) => run_loop(j(x));
  f.j = j;
  j.f = f;
  return f;
}

function run_loop(r) {
  while (r !== null && typeof r === "object" && r.$ === "$JMP") {
    r = r.f(r.x);
  }
  return r;
}

function run_lib(f, n) {
  return (...a) => a.length < n ? run_lib((...b) => f(...a, ...b), n - a.length)
    : run_loop(f(...a));
}

// Effect
// ======

const $0eff = Object.create(null);

function io_eff(k, run) {
  if (arguments.length > 2) {
    throw new Error("bend: " + k + " takes no need: an effect that waits parks itself");
  }
  if (k in $0eff) {
    throw new Error("bend: two effects register " + k);
  }
  $0eff[k] = run;
}
// Program
// =======

function $Selection_live(_p_0, _g_0, _s_0) {
  const _preview_0 = _s_0["preview"];
  const _generation_0 = _s_0["generation"];
  const _current_0 = _s_0["current"];
  const _repick_0 = _s_0["repick"];
  return $Bool_and(($Bool_and(($Bool_and(_current_0, ($Bool_not(_repick_0)))), ($String_eq(_preview_0, _p_0)))), ($String_eq(_generation_0, _g_0)));
}

function $Selection_live_mask(_xs_0, _p_0, _g_0) {
  if (_xs_0.$ === "Nil") {
    return {$: "Nil"};
  } else {
    const _s_0 = _xs_0["head"];
    const _t_0 = _xs_0["tail"];
    return {$: "Con", "head": ($Selection_live(_p_0, _g_0, _s_0)), "tail": ($Selection_live_mask(_t_0, _p_0, _g_0))};
  }
}

function $Selection_cap(_bs_0, _n_0) {
  if (_bs_0.$ === "Nil") {
    return {$: "Nil"};
  } else {
    const _t_0 = _bs_0["head"];
    if (_t_0) {
      const _t_1 = _bs_0["tail"];
      if (_n_0 === 0) {
        return {$: "Con", "head": false, "tail": ($Selection_cap(_t_1, 0))};
      } else {
        const _k_0 = (_n_0 - 1);
        return {$: "Con", "head": true, "tail": ($Selection_cap(_t_1, _k_0))};
      }
    } else {
      const _t_2 = _bs_0["tail"];
      return {$: "Con", "head": false, "tail": ($Selection_cap(_t_2, _n_0))};
    }
  }
}

function $Selection_markers(_xs_0, _n_0, _p_0, _g_0) {
  return $Selection_cap(($Selection_live_mask(_xs_0, _p_0, _g_0)), _n_0);
}

function $Selection_stale_after_route(_xs_0, _p_0) {
  if (_xs_0.$ === "Nil") {
    return {$: "Nil"};
  } else {
    const _t_0 = _xs_0["head"];
    const _preview_0 = _t_0["preview"];
    const _t_1 = _xs_0["tail"];
    return {$: "Con", "head": ($String_eq(_preview_0, _p_0)), "tail": ($Selection_stale_after_route(_t_1, _p_0))};
  }
}

function $Selection_stale_after_document(_xs_0, _p_0, _g_0) {
  if (_xs_0.$ === "Nil") {
    return {$: "Nil"};
  } else {
    const _t_0 = _xs_0["head"];
    const _preview_0 = _t_0["preview"];
    const _generation_0 = _t_0["generation"];
    const _t_1 = _xs_0["tail"];
    return {$: "Con", "head": ($Bool_and(($String_eq(_preview_0, _p_0)), ($Bool_not(($String_eq(_generation_0, _g_0)))))), "tail": ($Selection_stale_after_document(_t_1, _p_0, _g_0))};
  }
}

function $Bool_and(_a_0, _b_0) {
  if (!_a_0) {
    return false;
  } else {
    return _b_0;
  }
}

function $Bool_not(_b_0) {
  if (!_b_0) {
    return true;
  } else {
    return false;
  }
}

function $String_eq(_a_0, _b_0) {
  return $Cmp_is_eq(($String_order(_a_0, _b_0)));
}

function $Cmp_is_eq(_c_0) {
  if (_c_0.$ === "EQ") {
    return true;
  } else {
    return false;
  }
}

function $String_order(_a_0, _b_0) {
  return $String_order_go(_a_0, _b_0, {$: "EQ"});
}

function $String_order_go($0, $1, $2) {
  for (;;) {
    {
      const _a_0 = $0;
      const _b_0 = $1;
      const _c_0 = $2;
      if (_a_0 === "") {
        if (_b_0 !== "") {
          if (_c_0.$ === "EQ") {
            return {$: "LT"};
          } else {
            return _c_0;
          }
        } else {
          return _c_0;
        }
      } else {
        const _t_1 = _a_0.slice(0, char_len(_a_0));
        const _t_2 = _a_0.slice(char_len(_a_0));
        if (_b_0 === "") {
          if (_c_0.$ === "EQ") {
            return {$: "GT"};
          } else {
            return _c_0;
          }
        } else {
          const _t_3 = _b_0.slice(0, char_len(_b_0));
          const _t2_0 = _b_0.slice(char_len(_b_0));
          if (_c_0.$ === "EQ") {
            const _x_0 = char_code(_t_1);
            const _x_1 = char_code(_t_3);
            $0 = _t_2;
            $1 = _t2_0;
            $2 = cmp_new(_x_0, _x_1);
            continue;
          } else {
            return _c_0;
          }
        }
      }
    }
  }
}
export default {
  "Selection.live": run_lib((a0,a1,a2) => run_loop($Selection_live(str_in(a0),str_in(a1),a2)), 3),
  "Selection.live_mask": run_lib((a0,a1,a2) => run_loop($Selection_live_mask(a0,str_in(a1),str_in(a2))), 3),
  "Selection.cap": run_lib((a0,a1) => run_loop($Selection_cap(a0,nat_in(a1))), 2),
  "Selection.markers": run_lib((a0,a1,a2,a3) => run_loop($Selection_markers(a0,nat_in(a1),str_in(a2),str_in(a3))), 4),
  "Selection.stale_after_route": run_lib((a0,a1) => run_loop($Selection_stale_after_route(a0,str_in(a1))), 2),
  "Selection.stale_after_document": run_lib((a0,a1,a2) => run_loop($Selection_stale_after_document(a0,str_in(a1),str_in(a2))), 3),
};
