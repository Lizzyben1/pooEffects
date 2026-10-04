// ─────────────────────────────────────────────────────────────────────────────
// Text animators: range & wiggly selectors and per-glyph property application.
//
// Each animator computes a selection amount per glyph (per dimension for
// wiggly selectors), combining its selectors with Add/Subtract/Intersect/
// Min/Max/Difference. Animator properties are then applied proportionally:
//   position += value·s,   rotation += value·s,   scale ×= 1 + (value/100 − 1)·s,
//   opacity ×= 1 + (value/100 − 1)·s,  colors mix toward the animator color.
// Tracking is resolved first because it changes the layout.
// ─────────────────────────────────────────────────────────────────────────────

import type { AnimProp, PropValue, RangeSelector, RGBA, TextAnimator, TextBasedOn, TextLayerData, WigglySelector } from '../core/types';
import { layoutText, type Glyph, type Measure, type TextLayout } from './layout';
import { cssEase } from '../math/bezier';
import { mulberry32, noise1 } from '../math/noise';

export type TextValFn = <V extends PropValue>(p: AnimProp<V>, path: string) => V;

export interface GlyphRender {
  glyph: Glyph;
  /** pivot (anchor point grouping) */
  px: number;
  py: number;
  dx: number;
  dy: number;
  dz: number;
  ax: number;
  ay: number;
  sx: number;
  sy: number;
  rot: number;
  skew: number;
  opacity: number;
  fill: RGBA;
  stroke: RGBA;
  strokeWidth: number;
  blur: number;
}

export interface TextEvalResult {
  layout: TextLayout;
  glyphs: GlyphRender[];
  text: string;
}

function unitIndex(g: Glyph, basedOn: TextBasedOn): number {
  switch (basedOn) {
    case 'characters': return g.charIdx;
    case 'charactersExcludingSpaces': return g.charNoSpaceIdx;
    case 'words': return g.wordIdx;
    case 'lines': return g.lineIdx;
  }
}

function unitCount(layout: TextLayout, basedOn: TextBasedOn): number {
  switch (basedOn) {
    case 'characters': return layout.counts.characters;
    case 'charactersExcludingSpaces': return layout.counts.charactersExcludingSpaces;
    case 'words': return layout.counts.words;
    case 'lines': return layout.counts.lines;
  }
}

const permCache = new Map<string, number[]>();
function permutation(n: number, seed: number): number[] {
  const key = `${n}:${seed}`;
  let p = permCache.get(key);
  if (!p) {
    p = Array.from({ length: n }, (_, i) => i);
    const rnd = mulberry32(seed * 9973 + 17);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    if (permCache.size > 500) permCache.clear();
    permCache.set(key, p);
  }
  return p;
}

function rangeValues(sel: RangeSelector, layout: TextLayout, val: TextValFn, path: string): Float32Array {
  const glyphs = layout.glyphs;
  const out = new Float32Array(glyphs.length * 3);
  const N = unitCount(layout, sel.basedOn);
  if (N <= 0) return out;
  const start = val(sel.start, `${path}.start`);
  const end = val(sel.end, `${path}.end`);
  const offset = val(sel.offset, `${path}.offset`);
  const amount = val(sel.amount, `${path}.amount`) / 100;
  const smooth = Math.max(0, Math.min(100, val(sel.smoothness, `${path}.smoothness`))) / 100;
  const easeHigh = Math.max(0, Math.min(100, val(sel.easeHigh, `${path}.easeHigh`))) / 100;
  const easeLow = Math.max(0, Math.min(100, val(sel.easeLow, `${path}.easeLow`))) / 100;
  let rs: number, re: number;
  if (sel.units === 'percent') {
    rs = (start + offset) / 100;
    re = (end + offset) / 100;
  } else {
    rs = (start + offset) / N;
    re = (end + offset) / N;
  }
  if (rs > re) [rs, re] = [re, rs];
  const perm = sel.randomize ? permutation(N, sel.seed) : null;
  const span = re - rs;
  for (let gi = 0; gi < glyphs.length; gi++) {
    const u = unitIndex(glyphs[gi], sel.basedOn);
    if (u < 0) continue;
    const k = perm ? perm[u] : u;
    const a = k / N, b = (k + 1) / N;
    let v = 0;
    if (sel.shape === 'square') {
      const cov = Math.max(0, Math.min(b, re) - Math.max(a, rs)) / (b - a);
      v = smooth * cov + (1 - smooth) * (cov >= 0.5 ? 1 : 0);
    } else {
      const c = (a + b) / 2;
      const t = span > 1e-9 ? (c - rs) / span : c >= rs ? 1 : 0;
      switch (sel.shape) {
        case 'rampUp': v = Math.max(0, Math.min(1, t)); break;
        case 'rampDown': v = 1 - Math.max(0, Math.min(1, t)); break;
        case 'triangle': v = t >= 0 && t <= 1 ? 1 - Math.abs(2 * t - 1) : 0; break;
        case 'round': v = t >= 0 && t <= 1 ? Math.sqrt(Math.max(0, 1 - (2 * t - 1) ** 2)) : 0; break;
        case 'smooth': v = t >= 0 && t <= 1 ? 0.5 - 0.5 * Math.cos(2 * Math.PI * t) : 0; break;
      }
      if ((easeHigh > 0 || easeLow > 0) && v > 0 && v < 1) v = cssEase(easeLow * 0.66, 0, 1 - easeHigh * 0.66, 1, v);
    }
    v *= amount;
    out[gi * 3] = out[gi * 3 + 1] = out[gi * 3 + 2] = v;
  }
  return out;
}

function wigglyValues(sel: WigglySelector, layout: TextLayout, val: TextValFn, path: string, time: number): Float32Array {
  const glyphs = layout.glyphs;
  const out = new Float32Array(glyphs.length * 3);
  const maxA = val(sel.maxAmount, `${path}.maxAmount`) / 100;
  const minA = val(sel.minAmount, `${path}.minAmount`) / 100;
  const wps = val(sel.wigglesPerSecond, `${path}.wigglesPerSecond`);
  const corr = Math.max(0, Math.min(100, val(sel.correlation, `${path}.correlation`))) / 100;
  const tPhase = val(sel.temporalPhase, `${path}.temporalPhase`) / 360;
  const sPhase = val(sel.spatialPhase, `${path}.spatialPhase`) / 360;
  const spatialFreq = 0.08 + (1 - corr) * 1.6;
  for (let gi = 0; gi < glyphs.length; gi++) {
    const u = unitIndex(glyphs[gi], sel.basedOn);
    if (u < 0) continue;
    for (let d = 0; d < 3; d++) {
      const dd = sel.lockDimensions ? 0 : d;
      const n = noise1(u * spatialFreq + sPhase * 4 + time * wps + tPhase, sel.seed * 31 + dd * 1013 + 7);
      out[gi * 3 + d] = minA + (maxA - minA) * Math.max(0, Math.min(1, (n + 1) / 2));
    }
  }
  return out;
}

const BASE_ONE = new Set(['subtract', 'intersect', 'min', 'difference']);

function animatorSelection(anim: TextAnimator, layout: TextLayout, val: TextValFn, path: string, time: number): Float32Array {
  const n = layout.glyphs.length;
  const sels = anim.selectors.filter((s) => s.enabled);
  const acc = new Float32Array(n * 3);
  if (!sels.length) {
    acc.fill(1);
    return acc;
  }
  acc.fill(BASE_ONE.has(sels[0].mode) ? 1 : 0);
  for (const s of sels) {
    const sp = `${path}.selectors.${s.id}`;
    const v = s.type === 'range' ? rangeValues(s, layout, val, sp) : wigglyValues(s, layout, val, sp, time);
    for (let k = 0; k < acc.length; k++) {
      const a = acc[k], b = v[k];
      switch (s.mode) {
        case 'add': acc[k] = Math.min(1, a + b); break;
        case 'subtract': acc[k] = Math.max(-1, a - b); break;
        case 'intersect': acc[k] = a * b; break;
        case 'min': acc[k] = Math.min(a, b); break;
        case 'max': acc[k] = Math.max(a, b); break;
        case 'difference': acc[k] = Math.abs(a - b); break;
      }
    }
  }
  return acc;
}

export function evaluateText(data: TextLayerData, val: TextValFn, time: number, measure: Measure, basePath = 'text'): TextEvalResult {
  const text = val(data.sourceText, `${basePath}.sourceText`) ?? '';
  const doc = data.document;
  const anims = data.animators.filter((a) => a.enabled);
  // pass 1: base layout for indices and counts
  let layout = layoutText(text, doc, measure);
  const selections = anims.map((a) => animatorSelection(a, layout, val, `${basePath}.animators.${a.id}`, time));
  // tracking pass
  const trackVals = anims.map((a) => (a.props.tracking ? val(a.props.tracking, `${basePath}.animators.${a.id}.props.tracking`) : 0));
  if (trackVals.some((t) => t !== 0)) {
    layout = layoutText(text, doc, measure, (idx) => {
      let sum = 0;
      anims.forEach((_, ai) => {
        if (trackVals[ai]) sum += trackVals[ai] * selections[ai][idx * 3];
      });
      return sum;
    });
  }
  // pivots
  const pivots = computePivots(layout, data.grouping);
  const glyphs: GlyphRender[] = layout.glyphs.map((g, gi) => ({
    glyph: g, px: pivots[gi][0], py: pivots[gi][1], dx: 0, dy: 0, dz: 0, ax: 0, ay: 0, sx: 1, sy: 1, rot: 0, skew: 0,
    opacity: 1, fill: [...doc.fill] as RGBA, stroke: [...doc.stroke] as RGBA, strokeWidth: doc.strokeWidth, blur: 0,
  }));
  anims.forEach((a, ai) => {
    const sel = selections[ai];
    const p = a.props;
    const ap = `${basePath}.animators.${a.id}.props`;
    const pos = p.position ? val(p.position, `${ap}.position`) : null;
    const anc = p.anchor ? val(p.anchor, `${ap}.anchor`) : null;
    const scl = p.scale ? val(p.scale, `${ap}.scale`) : null;
    const rot = p.rotation ? val(p.rotation, `${ap}.rotation`) : 0;
    const skw = p.skew ? val(p.skew, `${ap}.skew`) : 0;
    const opa = p.opacity ? val(p.opacity, `${ap}.opacity`) : null;
    const fc = p.fillColor ? val(p.fillColor, `${ap}.fillColor`) : null;
    const sc = p.strokeColor ? val(p.strokeColor, `${ap}.strokeColor`) : null;
    const sw = p.strokeWidth ? val(p.strokeWidth, `${ap}.strokeWidth`) : 0;
    const blr = p.blur ? val(p.blur, `${ap}.blur`) : null;
    for (let gi = 0; gi < glyphs.length; gi++) {
      const s0 = sel[gi * 3], s1 = sel[gi * 3 + 1], s2 = sel[gi * 3 + 2];
      if (s0 === 0 && s1 === 0 && s2 === 0) continue;
      const r = glyphs[gi];
      if (pos) { r.dx += pos[0] * s0; r.dy += pos[1] * s1; r.dz += (pos[2] ?? 0) * s2; }
      if (anc) { r.ax += anc[0] * s0; r.ay += anc[1] * s1; }
      if (scl) { r.sx *= 1 + (scl[0] / 100 - 1) * s0; r.sy *= 1 + (scl[1] / 100 - 1) * s1; }
      if (rot) r.rot += rot * s0;
      if (skw) r.skew += skw * s0;
      if (opa !== null) r.opacity *= Math.max(0, 1 + (opa / 100 - 1) * s0);
      if (fc) {
        const f = Math.max(0, Math.min(1, s0)) * (fc[3] ?? 1);
        r.fill = [r.fill[0] + (fc[0] - r.fill[0]) * f, r.fill[1] + (fc[1] - r.fill[1]) * f, r.fill[2] + (fc[2] - r.fill[2]) * f, r.fill[3]];
      }
      if (sc) {
        const f = Math.max(0, Math.min(1, s0)) * (sc[3] ?? 1);
        r.stroke = [r.stroke[0] + (sc[0] - r.stroke[0]) * f, r.stroke[1] + (sc[1] - r.stroke[1]) * f, r.stroke[2] + (sc[2] - r.stroke[2]) * f, r.stroke[3]];
      }
      if (sw) r.strokeWidth += sw * s0;
      if (blr) r.blur += ((Math.abs(blr[0]) + Math.abs(blr[1])) / 2) * Math.abs(s0);
    }
  });
  for (const g of glyphs) g.opacity = Math.max(0, Math.min(1, g.opacity));
  return { layout, glyphs, text };
}

function computePivots(layout: TextLayout, grouping: TextLayerData['grouping']): [number, number][] {
  const gs = layout.glyphs;
  if (grouping === 'character') return gs.map((g) => [g.x + g.width / 2, g.y]);
  if (grouping === 'all') {
    if (!gs.length) return [];
    const minX = Math.min(...gs.map((g) => g.x)), maxX = Math.max(...gs.map((g) => g.x + g.width));
    const minY = Math.min(...gs.map((g) => g.y)), maxY = Math.max(...gs.map((g) => g.y));
    const c: [number, number] = [(minX + maxX) / 2, (minY + maxY) / 2];
    return gs.map(() => c);
  }
  const key = (g: Glyph) => (grouping === 'word' ? `w${g.wordIdx}` : `l${g.lineIdx}`);
  const ext = new Map<string, [number, number, number]>();
  for (const g of gs) {
    if (grouping === 'word' && g.wordIdx < 0) continue;
    const k = key(g);
    const e = ext.get(k);
    if (!e) ext.set(k, [g.x, g.x + g.width, g.y]);
    else { e[0] = Math.min(e[0], g.x); e[1] = Math.max(e[1], g.x + g.width); }
  }
  return gs.map((g) => {
    const e = ext.get(key(g));
    return e ? [(e[0] + e[1]) / 2, e[2]] : [g.x + g.width / 2, g.y];
  });
}

/** Per-glyph 2D matrix [a,b,c,d,e,f] mapping glyph-local (baseline layout coords) to layer space. */
export function glyphMatrix(r: GlyphRender): [number, number, number, number, number, number] {
  const px = r.px + r.ax, py = r.py + r.ay;
  const rad = (r.rot * Math.PI) / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  const k = Math.tan((-r.skew * Math.PI) / 180);
  // M = T(px+dx, py+dy) · R · Skew · S · T(-px, -py)
  const a0 = r.sx, d0 = r.sy;
  // Skew·S = [[sx, k·sy],[0, sy]]
  const m00 = c * a0, m01 = c * k * d0 - s * d0;
  const m10 = s * a0, m11 = s * k * d0 + c * d0;
  const tx = px + r.dx - (m00 * px + m01 * py);
  const ty = py + r.dy - (m10 * px + m11 * py);
  return [m00, m10, m01, m11, tx, ty];
}
