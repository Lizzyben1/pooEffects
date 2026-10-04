// ─────────────────────────────────────────────────────────────────────────────
// Expression engine
//
// Expressions are JavaScript evaluated with After Effects semantics:
//   * the value of the LAST statement is the result (no `return` needed),
//   * undeclared assignments (`freq = 2;`) stay local to the expression,
//   * an AE-style helper vocabulary is in scope (wiggle, loopOut, linear,
//     ease, valueAtTime, thisComp.layer("Null").transform.position, …).
//
// Compilation strategy (fast path first):
//   1. `return ( <src> )`                 – single-expression code
//   2. insert `return` before the last top-level expression statement
//   3. `eval(src)` inside the scope       – exact completion-value semantics
// The code runs inside `with (scopeProxy)` so identifier reads/writes are
// captured by the scope object instead of leaking to globals.
// ─────────────────────────────────────────────────────────────────────────────

import { cssEase } from '../math/bezier';
import { hash32, mulberry32, noise1, noise2, wiggleValue } from '../math/noise';
import { hsvToRgb, rgbToHsv } from '../math/color';

export interface KeyInfo {
  time: number;
  value: unknown;
  index: number;
}

/** Everything an expression may query. Implemented by the frame evaluator. */
export interface ExprHost {
  time: number;
  value: unknown;
  /** keyframed (pre-expression) value of this property at comp time t */
  valueAtTime(t: number): unknown;
  velocityAtTime(t: number): unknown;
  numKeys: number;
  key(i: number): KeyInfo | null;
  frameDuration: number;
  seed: number;
  thisLayer: Record<string, unknown>;
  thisComp: Record<string, unknown>;
  comp(name: string): Record<string, unknown> | null;
  /** layer time → comp time for keyframes */
  inPoint: number;
  outPoint: number;
}

export interface CompiledExpression {
  run: ((scope: object, src: string) => unknown) | null;
  error: string | null;
}

const compiled = new Map<string, CompiledExpression>();

const SAFE_GLOBALS = new Set([
  'Math', 'Number', 'String', 'Array', 'Object', 'JSON', 'Boolean', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'Infinity', 'NaN', 'undefined', 'Date', 'RegExp', 'console', 'eval', 'Symbol', 'Error',
]);

const handler: ProxyHandler<Record<string | symbol, unknown>> = {
  has: () => true,
  get(target, key) {
    if (key === Symbol.unscopables) return undefined;
    if (key in target) return target[key];
    if (typeof key === 'string' && SAFE_GLOBALS.has(key)) return (globalThis as Record<string, unknown>)[key];
    return undefined;
  },
  set(target, key, value) {
    target[key] = value;
    return true;
  },
};

const STATEMENT_KEYWORDS = /^(if|for|while|do|switch|var|let|const|function|class|try|throw|return|break|continue|\})\b/;

/** Candidate positions where the last top-level statement may begin. */
function statementStarts(src: string): number[] {
  const starts: number[] = [0];
  let depth = 0;
  let i = 0;
  let lastSignificant = '';
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') i++;
        i++;
      }
      i++;
      lastSignificant = q;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (ch === '}' && depth === 0) starts.push(i + 1);
    } else if (depth === 0 && ch === ';') starts.push(i + 1);
    else if (depth === 0 && ch === '\n') {
      if (!/[+\-*/%=&|^<>!?:,.]/.test(lastSignificant)) starts.push(i + 1);
    }
    if (!/\s/.test(ch)) lastSignificant = ch;
    i++;
  }
  return starts;
}

function tryCompile(body: string): ((scope: object, src: string) => unknown) | null {
  try {
    // eslint-disable-next-line no-new-func
    return new Function('__scope', '__src', `with (__scope) {\n${body}\n}`) as (scope: object, src: string) => unknown;
  } catch {
    return null;
  }
}

export function compileExpression(src: string): CompiledExpression {
  const hit = compiled.get(src);
  if (hit) return hit;
  let result: CompiledExpression;
  const trimmed = src.trim();
  if (!trimmed) {
    result = { run: null, error: null };
  } else {
    let run = tryCompile(`return (\n${trimmed}\n);`);
    if (!run) {
      const starts = statementStarts(trimmed);
      for (let k = starts.length - 1; k >= 0 && !run; k--) {
        const head = trimmed.slice(0, starts[k]);
        const tail = trimmed.slice(starts[k]).trim().replace(/;+\s*$/, '');
        if (!tail || STATEMENT_KEYWORDS.test(tail)) continue;
        run = tryCompile(`${head}\nreturn (\n${tail}\n);`);
      }
    }
    if (!run) {
      // exact completion-value semantics; also validates syntax
      let syntaxError: string | null = null;
      try {
        // eslint-disable-next-line no-new-func
        new Function(trimmed);
      } catch (e) {
        syntaxError = (e as Error).message;
      }
      run = syntaxError ? null : tryCompile('return eval(__src);');
      result = { run, error: syntaxError };
    } else {
      result = { run, error: null };
    }
  }
  compiled.set(src, result);
  if (compiled.size > 2000) compiled.delete(compiled.keys().next().value as string);
  return result;
}

// ── vector helpers ──────────────────────────────────────────────────────────

const unwrap = (x: unknown): unknown => (x instanceof Number ? x.valueOf() : x);
const asArr = (x: unknown): number[] => (Array.isArray(x) ? x.map((v) => Number(unwrap(v))) : [Number(unwrap(x))]);
const isArr = Array.isArray;

function vadd(a: unknown, b: unknown): unknown {
  a = unwrap(a); b = unwrap(b);
  if (!isArr(a) && !isArr(b)) return (a as number) + (b as number);
  const A = asArr(a), B = asArr(b);
  const n = Math.max(A.length, B.length);
  return Array.from({ length: n }, (_, i) => (A[i] ?? 0) + (B[i] ?? 0));
}
function vsub(a: unknown, b: unknown): unknown {
  a = unwrap(a); b = unwrap(b);
  if (!isArr(a) && !isArr(b)) return (a as number) - (b as number);
  const A = asArr(a), B = asArr(b);
  const n = Math.max(A.length, B.length);
  return Array.from({ length: n }, (_, i) => (A[i] ?? 0) - (B[i] ?? 0));
}
function vmul(a: unknown, s: unknown): unknown {
  a = unwrap(a); s = unwrap(s);
  if (isArr(a)) return asArr(a).map((x) => x * Number(s));
  if (isArr(s)) return asArr(s).map((x) => x * Number(a));
  return (a as number) * (s as number);
}
function vdiv(a: unknown, s: unknown): unknown {
  a = unwrap(a); s = unwrap(s);
  if (isArr(a)) return asArr(a).map((x) => x / Number(s));
  return (a as number) / (s as number);
}
function vlength(a: unknown, b?: unknown): number {
  const A = asArr(a);
  const B = b === undefined ? A.map(() => 0) : asArr(b);
  return Math.hypot(...A.map((x, i) => x - (B[i] ?? 0)));
}
function vnormalize(a: unknown): number[] {
  const A = asArr(a);
  const l = Math.hypot(...A) || 1;
  return A.map((x) => x / l);
}
function vdot(a: unknown, b: unknown): number {
  const A = asArr(a), B = asArr(b);
  return A.reduce((s, x, i) => s + x * (B[i] ?? 0), 0);
}
function vcross(a: unknown, b: unknown): number[] {
  const A = asArr(a), B = asArr(b);
  return [A[1] * B[2] - A[2] * B[1], A[2] * B[0] - A[0] * B[2], A[0] * B[1] - A[1] * B[0]];
}
function vclamp(v: unknown, lo: unknown, hi: unknown): unknown {
  v = unwrap(v);
  if (isArr(v)) {
    const L = asArr(lo), H = asArr(hi);
    return asArr(v).map((x, i) => Math.min(Math.max(x, L[i] ?? L[0]), H[i] ?? H[0]));
  }
  return Math.min(Math.max(v as number, Number(unwrap(lo))), Number(unwrap(hi)));
}
function vlerp(a: unknown, b: unknown, f: number): unknown {
  a = unwrap(a); b = unwrap(b);
  if (isArr(a) || isArr(b)) {
    const A = asArr(a), B = asArr(b);
    const n = Math.max(A.length, B.length);
    return Array.from({ length: n }, (_, i) => (A[i] ?? A[0]) + ((B[i] ?? B[0]) - (A[i] ?? A[0])) * f);
  }
  return (a as number) + ((b as number) - (a as number)) * f;
}

type EaseFn = (u: number) => number;
const EASE: EaseFn = (u) => cssEase(0.333, 0, 0.667, 1, u);
const EASE_IN: EaseFn = (u) => cssEase(0.333, 0, 0.667, 0.667, u);
const EASE_OUT: EaseFn = (u) => cssEase(0.333, 0.333, 0.667, 1, u);

function interp(fn: EaseFn) {
  return (t: unknown, a: unknown, b: unknown, c?: unknown, d?: unknown): unknown => {
    let tMin = 0, tMax = 1, v1 = a, v2 = b;
    if (c !== undefined) {
      tMin = Number(unwrap(a)); tMax = Number(unwrap(b)); v1 = c; v2 = d;
    }
    const tt = Number(unwrap(t));
    let u = tMax === tMin ? (tt >= tMax ? 1 : 0) : (tt - tMin) / (tMax - tMin);
    if (tMax < tMin) u = (tt - tMax) / (tMin - tMax), [v1, v2] = [v2, v1];
    u = Math.min(1, Math.max(0, u));
    return vlerp(v1, v2, fn(u));
  };
}

function hslToRgbArr(hsla: unknown): number[] {
  const [h, s, l, a = 1] = asArr(hsla);
  const v = l + s * Math.min(l, 1 - l);
  const sv = v === 0 ? 0 : 2 * (1 - l / v);
  const [r, g, b] = hsvToRgb(h * 360, sv, v);
  return [r, g, b, a];
}
function rgbToHslArr(rgba: unknown): number[] {
  const [r, g, b, a = 1] = asArr(rgba);
  const [h, sv, v] = rgbToHsv(r, g, b);
  const l = v * (1 - sv / 2);
  const s = l === 0 || l === 1 ? 0 : (v - l) / Math.min(l, 1 - l);
  return [h / 360, s, l, a];
}

// ── scope construction ──────────────────────────────────────────────────────

function buildScope(host: ExprHost, src: string): Record<string | symbol, unknown> {
  const s: Record<string | symbol, unknown> = Object.create(null);
  s.__src = src;
  s.time = host.time;
  s.value = host.value;
  s.thisLayer = host.thisLayer;
  s.thisComp = host.thisComp;
  s.comp = (name: string) => host.comp(name);
  s.thisProperty = {
    value: host.value,
    valueAtTime: (t: number) => host.valueAtTime(t),
    velocityAtTime: (t: number) => host.velocityAtTime(t),
    numKeys: host.numKeys,
    key: (i: number) => host.key(i),
  };
  s.valueAtTime = (t: number) => host.valueAtTime(t);
  s.velocityAtTime = (t: number) => host.velocityAtTime(t);
  Object.defineProperty(s, 'velocity', { get: () => host.velocityAtTime(s.time as number), enumerable: true, configurable: true });
  Object.defineProperty(s, 'speed', { get: () => vlength(host.velocityAtTime(s.time as number)), enumerable: true, configurable: true });
  s.numKeys = host.numKeys;
  s.key = (i: number) => host.key(i);
  s.nearestKey = (t: number) => {
    let best: KeyInfo | null = null;
    for (let i = 1; i <= host.numKeys; i++) {
      const k = host.key(i);
      if (k && (!best || Math.abs(k.time - t) < Math.abs(best.time - t))) best = k;
    }
    return best;
  };
  // expose the layer vocabulary at top level (AE lets you write `transform.position`, `index`, …)
  for (const k of Object.keys(host.thisLayer)) {
    const desc = Object.getOwnPropertyDescriptor(host.thisLayer, k);
    if (desc) Object.defineProperty(s, k, { ...desc, configurable: true });
  }

  // wiggle & noise
  const seed = host.seed;
  s.wiggle = (freq: number, amp: number, octaves = 1, ampMult = 0.5, t: number = s.time as number) => {
    const v = unwrap(s.value);
    if (typeof v === 'number') return v + wiggleValue(seed, t, freq, amp, octaves, ampMult, 0);
    if (Array.isArray(v)) return v.map((x, d) => Number(unwrap(x)) + wiggleValue(seed, t, freq, amp, octaves, ampMult, d));
    return v;
  };
  s.noise = (v: unknown) => {
    const A = asArr(v);
    return A.length > 1 ? noise2(A[0], A[1], seed) : noise1(A[0], seed);
  };

  // random
  let rng = mulberry32(hash32(seed ^ Math.floor((host.time as number) / host.frameDuration + 0.5)));
  const rand = (a?: unknown, b?: unknown): unknown => {
    const r = rng();
    if (a === undefined) return r;
    if (b === undefined) {
      a = unwrap(a);
      return isArr(a) ? asArr(a).map((x) => rng() * x) : r * (a as number);
    }
    a = unwrap(a); b = unwrap(b);
    if (isArr(a) || isArr(b)) {
      const A = asArr(a), B = asArr(b);
      return A.map((x, i) => x + rng() * ((B[i] ?? B[0]) - x));
    }
    return (a as number) + r * ((b as number) - (a as number));
  };
  s.random = rand;
  s.gaussRandom = (a?: unknown, b?: unknown) => {
    const g = () => {
      let u = 0, v = 0;
      while (u === 0) u = rng();
      while (v === 0) v = rng();
      return Math.min(1, Math.max(0, 0.5 + Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) / 6));
    };
    if (a === undefined) return g();
    if (b === undefined) return Number(unwrap(a)) * g();
    return Number(unwrap(a)) + g() * (Number(unwrap(b)) - Number(unwrap(a)));
  };
  s.seedRandom = (n: number, timeless = false) => {
    rng = mulberry32(hash32((seed + Math.floor(n) * 7919) ^ (timeless ? 0 : Math.floor((s.time as number) / host.frameDuration + 0.5))));
  };

  // loops
  const keyTime = (i: number) => host.key(i)?.time ?? 0;
  const loop = (dir: 'in' | 'out', type: string, numKf: number) => {
    const n = host.numKeys;
    if (n < 2) return s.value;
    const t = s.time as number;
    let t0: number, t1: number;
    if (dir === 'out') {
      const first = numKf > 0 ? Math.max(1, n - numKf) : 1;
      t0 = keyTime(first); t1 = keyTime(n);
      if (t <= t1) return s.value;
    } else {
      const last = numKf > 0 ? Math.min(n, 1 + numKf) : n;
      t0 = keyTime(1); t1 = keyTime(last);
      if (t >= t0) return s.value;
    }
    const dur = t1 - t0;
    if (dur <= 0) return s.value;
    const off = dir === 'out' ? t - t1 : t0 - t;
    const cycles = Math.floor(off / dur);
    const frac = off - cycles * dur;
    switch (type) {
      case 'pingpong': {
        const forward = cycles % 2 === 1;
        if (dir === 'out') return host.valueAtTime(forward ? t0 + frac : t1 - frac);
        return host.valueAtTime(forward ? t1 - frac : t0 + frac);
      }
      case 'offset': {
        const delta = vsub(host.valueAtTime(t1), host.valueAtTime(t0));
        if (dir === 'out') return vadd(host.valueAtTime(t0 + frac), vmul(delta, cycles + 1));
        return vsub(host.valueAtTime(t1 - frac), vmul(delta, cycles + 1));
      }
      case 'continue': {
        const edge = dir === 'out' ? t1 : t0;
        const vel = host.velocityAtTime(edge);
        return vadd(host.valueAtTime(edge), vmul(vel, dir === 'out' ? off : -off));
      }
      default:
        return dir === 'out' ? host.valueAtTime(t0 + frac) : host.valueAtTime(t1 - frac);
    }
  };
  s.loopOut = (type = 'cycle', numKf = 0) => loop('out', type, numKf);
  s.loopIn = (type = 'cycle', numKf = 0) => loop('in', type, numKf);
  s.loopOutDuration = (type = 'cycle') => loop('out', type, 0);
  s.loopInDuration = (type = 'cycle') => loop('in', type, 0);

  // interpolation & math
  s.linear = interp((u) => u);
  s.ease = interp(EASE);
  s.easeIn = interp(EASE_IN);
  s.easeOut = interp(EASE_OUT);
  s.add = vadd; s.sub = vsub; s.mul = vmul; s.div = vdiv;
  s.length = vlength; s.normalize = vnormalize; s.dot = vdot; s.cross = vcross; s.clamp = vclamp;
  s.degreesToRadians = (d: number) => (Number(unwrap(d)) * Math.PI) / 180;
  s.radiansToDegrees = (r: number) => (Number(unwrap(r)) * 180) / Math.PI;
  s.timeToFrames = (t: number = s.time as number, fps = 1 / host.frameDuration) => Math.floor(t * fps + 1e-6);
  s.framesToTime = (f: number, fps = 1 / host.frameDuration) => f / fps;
  s.posterizeTime = (fps: number) => {
    if (fps > 0) s.time = Math.floor((host.time as number) * fps + 1e-6) / fps;
    return s.time;
  };
  s.hslToRgb = hslToRgbArr;
  s.rgbToHsl = rgbToHslArr;
  s.inPoint = host.inPoint;
  s.outPoint = host.outPoint;
  return s;
}

export function normalizeExprResult(r: unknown, fallback: unknown): unknown {
  r = unwrap(r);
  if (Array.isArray(r)) r = r.map((x) => unwrap(x));
  if (typeof fallback === 'number') {
    const n = Array.isArray(r) ? Number(r[0]) : Number(r);
    return Number.isFinite(n) ? n : fallback;
  }
  if (Array.isArray(fallback) && (fallback.length === 0 || typeof fallback[0] === 'number')) {
    if (typeof r === 'number') return Number.isFinite(r) ? fallback.map(() => r) : fallback;
    if (Array.isArray(r)) return fallback.map((f, i) => {
      const n = Number(r[i]);
      return Number.isFinite(n) ? n : f;
    });
    return fallback;
  }
  if (typeof fallback === 'string') return r === undefined || r === null ? fallback : String(r);
  if (typeof fallback === 'boolean') return !!r;
  return r ?? fallback;
}

export interface ExprResult {
  value: unknown;
  error: string | null;
}

export function evaluateExpression(src: string, host: ExprHost): ExprResult {
  const c = compileExpression(src);
  if (!c.run) return { value: host.value, error: c.error };
  try {
    const scope = buildScope(host, src);
    const proxy = new Proxy(scope, handler);
    const raw = c.run(proxy, src);
    return { value: normalizeExprResult(raw, host.value), error: null };
  } catch (e) {
    return { value: host.value, error: (e as Error)?.message ?? String(e) };
  }
}

/** Attach AE-style methods to a value read from another property (numbers become Number objects). */
export function wrapPropertyValue(v: unknown, atTime: (t: number) => unknown, velAt: (t: number) => unknown): unknown {
  let w: any;
  if (typeof v === 'number') w = new Number(v);
  else if (Array.isArray(v)) w = v.slice();
  else return v;
  Object.defineProperty(w, 'valueAtTime', { value: atTime, enumerable: false });
  Object.defineProperty(w, 'velocityAtTime', { value: velAt, enumerable: false });
  Object.defineProperty(w, 'value', { get: () => v, enumerable: false });
  return w;
}
