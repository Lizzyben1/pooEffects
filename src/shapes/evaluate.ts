// ─────────────────────────────────────────────────────────────────────────────
// Shape layer evaluation (After Effects semantics)
//
// Items in a group are processed top → bottom:
//   • path generators push a PathEntry onto the group's path stack;
//   • operators (Trim, Zig Zag, Round Corners, …) rewrite every entry above
//     them IN PLACE — including entries of nested groups — so renderers that
//     captured those entries earlier (a Stroke above a Trim Paths) render the
//     modified geometry, exactly like AE;
//   • renderers (Fill/Stroke/Gradient) capture the entries above them;
//   • Merge Paths collapses the stack into one compound entry;
//   • Repeater clones everything above it (paths + renderers) with cumulative
//     per-copy transforms.
// Groups return entries in their local space; the parent bakes the group
// transform into the geometry, so final geometry is in layer space.
// Draw ops are kept top-first; the rasteriser paints them bottom-up.
// ─────────────────────────────────────────────────────────────────────────────

import type { AnimProp, BezierPath, BlendMode, GradientStop, LineCap, LineJoin, PropValue, RGBA, ShapeItem, ShapeTransform, Vec2 } from '../core/types';
import { rectToPath, ellipseToPath, polystarToPath } from './generators';
import {
  apply2d, IDENTITY_2D, mul2d, rotate2d, scale2d, scaleOf2d, skew2d, transformPath, translate2d, invert2d, clonePath, reversePath,
  type Mat2d,
} from './path';
import { offsetPaths, puckerBloat, roundCorners, trimIndividually, trimRange, trimSimultaneous, twist, wigglePaths, zigzag } from './modifiers';

export type ValFn = <V extends PropValue>(p: AnimProp<V>, path: string, spatial?: boolean) => V;

export type MergeMode = 'merge' | 'add' | 'subtract' | 'intersect' | 'exclude';

export interface PathEntry {
  paths: BezierPath[];
  hidden: boolean;
  merge?: MergeMode;
  /** item id of the generator (for selection/hit testing) */
  sourceId: string;
}

export interface GradientPaint {
  type: 'linear' | 'radial';
  start: Vec2;
  end: Vec2;
  stops: GradientStop[];
}

export interface DrawOp {
  kind: 'fill' | 'stroke';
  itemId: string;
  entries: PathEntry[];
  color: RGBA | null;
  gradient: GradientPaint | null;
  opacity: number;
  fillRule: 'nonzero' | 'evenodd';
  width: number;
  lineCap: LineCap;
  lineJoin: LineJoin;
  miterLimit: number;
  dash: number[] | null;
  dashOffset: number;
  blendMode: BlendMode;
}

interface GroupResult {
  draws: DrawOp[];
  visible: PathEntry[];
  all: PathEntry[];
}

export function shapeGroupMatrix(t: ShapeTransform, val: ValFn, path: string): Mat2d {
  const a = val(t.anchor, `${path}.transform.anchor`, true);
  const p = val(t.position, `${path}.transform.position`, true);
  const s = val(t.scale, `${path}.transform.scale`);
  const r = val(t.rotation, `${path}.transform.rotation`);
  const sk = val(t.skew, `${path}.transform.skew`);
  const ska = val(t.skewAxis, `${path}.transform.skewAxis`);
  return mul2d(mul2d(mul2d(mul2d(translate2d(p[0], p[1]), rotate2d(r)), skew2d(sk, ska)), scale2d(s[0] / 100, s[1] / 100)), translate2d(-a[0], -a[1]));
}

function bake(res: GroupResult, m: Mat2d, opacity: number, blend: BlendMode): void {
  for (const e of res.all) e.paths = e.paths.map((p) => transformPath(p, m));
  const sc = scaleOf2d(m);
  for (const d of res.draws) {
    d.width *= sc;
    if (d.dash) d.dash = d.dash.map((x) => x * sc);
    d.dashOffset *= sc;
    if (d.gradient) d.gradient = { ...d.gradient, start: apply2d(m, d.gradient.start), end: apply2d(m, d.gradient.end) };
    d.opacity *= opacity;
    if (blend !== 'normal' && d.blendMode === 'normal') d.blendMode = blend;
  }
}

function cloneResult(res: GroupResult): GroupResult {
  const map = new Map<PathEntry, PathEntry>();
  const all = res.all.map((e) => {
    const c: PathEntry = { paths: e.paths.map(clonePath), hidden: e.hidden, merge: e.merge, sourceId: e.sourceId };
    map.set(e, c);
    return c;
  });
  const draws = res.draws.map((d) => ({
    ...d,
    entries: d.entries.map((e) => map.get(e) ?? e),
    dash: d.dash ? d.dash.slice() : null,
    gradient: d.gradient ? { ...d.gradient } : null,
  }));
  const visible = res.visible.map((e) => map.get(e) ?? e);
  return { draws, visible, all };
}

function repeaterStep(a: number[], p: number[], s: number[], r: number, f: number): Mat2d {
  const sx = Math.sign(s[0] || 1) * Math.pow(Math.abs(s[0] / 100) || 1e-6, f);
  const sy = Math.sign(s[1] || 1) * Math.pow(Math.abs(s[1] / 100) || 1e-6, f);
  return mul2d(mul2d(mul2d(mul2d(translate2d(p[0] * f, p[1] * f), translate2d(a[0], a[1])), rotate2d(r * f)), scale2d(sx, sy)), translate2d(-a[0], -a[1]));
}

function makeDraw(item: ShapeItem, entries: PathEntry[], val: ValFn, path: string): DrawOp | null {
  const base = {
    itemId: item.id, entries, color: null, gradient: null, opacity: 1, fillRule: 'nonzero' as const,
    width: 0, lineCap: 'butt' as LineCap, lineJoin: 'miter' as LineJoin, miterLimit: 4, dash: null, dashOffset: 0, blendMode: 'normal' as BlendMode,
  };
  switch (item.type) {
    case 'fill': {
      const c = val(item.color, `${path}.color`);
      return { ...base, kind: 'fill', color: c, opacity: (val(item.opacity, `${path}.opacity`) / 100) * (c[3] ?? 1), fillRule: item.fillRule, blendMode: item.blendMode };
    }
    case 'gfill':
      return {
        ...base, kind: 'fill', opacity: val(item.opacity, `${path}.opacity`) / 100, fillRule: item.fillRule, blendMode: item.blendMode,
        gradient: {
          type: item.gradientType,
          start: val(item.start, `${path}.start`, true) as Vec2,
          end: val(item.end, `${path}.end`, true) as Vec2,
          stops: val(item.colors, `${path}.colors`),
        },
      };
    case 'stroke':
    case 'gstroke': {
      const isGrad = item.type === 'gstroke';
      const c = isGrad ? null : val(item.color, `${path}.color`);
      const dash = item.dashes.enabled
        ? [Math.max(0, val(item.dashes.dash, `${path}.dashes.dash`)), Math.max(0, val(item.dashes.gap, `${path}.dashes.gap`))]
        : null;
      return {
        ...base, kind: 'stroke', color: c,
        opacity: (val(item.opacity, `${path}.opacity`) / 100) * (c ? c[3] ?? 1 : 1),
        width: Math.max(0, val(item.width, `${path}.width`)),
        lineCap: item.lineCap, lineJoin: item.lineJoin, miterLimit: item.miterLimit,
        dash: dash && dash[0] + dash[1] > 0 ? dash : null,
        dashOffset: item.dashes.enabled ? val(item.dashes.offset, `${path}.dashes.offset`) : 0,
        blendMode: item.blendMode,
        gradient: isGrad
          ? {
            type: item.gradientType,
            start: val(item.start, `${path}.start`, true) as Vec2,
            end: val(item.end, `${path}.end`, true) as Vec2,
            stops: val(item.colors, `${path}.colors`),
          }
          : null,
      };
    }
    default:
      return null;
  }
}

function evalContents(items: ShapeItem[], val: ValFn, basePath: string, time: number): GroupResult {
  let draws: DrawOp[] = [];
  let visible: PathEntry[] = [];
  let all: PathEntry[] = [];
  const push = (p: BezierPath, id: string) => {
    const e: PathEntry = { paths: [p], hidden: false, sourceId: id };
    visible.push(e);
    all.push(e);
  };
  for (const item of items) {
    if (!item.enabled) continue;
    const path = `${basePath}.${item.id}`;
    switch (item.type) {
      case 'rect':
        push(rectToPath(val(item.size, `${path}.size`), val(item.position, `${path}.position`, true), val(item.roundness, `${path}.roundness`), item.reversed), item.id);
        break;
      case 'ellipse':
        push(ellipseToPath(val(item.size, `${path}.size`), val(item.position, `${path}.position`, true), item.reversed), item.id);
        break;
      case 'polystar':
        push(polystarToPath(
          item.starType, val(item.points, `${path}.points`), val(item.position, `${path}.position`, true), val(item.rotation, `${path}.rotation`),
          val(item.innerRadius, `${path}.innerRadius`), val(item.outerRadius, `${path}.outerRadius`),
          val(item.innerRoundness, `${path}.innerRoundness`), val(item.outerRoundness, `${path}.outerRoundness`), item.reversed,
        ), item.id);
        break;
      case 'path': {
        const p = val(item.path, `${path}.path`);
        if (p && p.v && p.v.length) push(item.reversed ? reversePath(p) : clonePath(p), item.id);
        break;
      }
      case 'group': {
        const sub = evalContents(item.contents, val, `${path}.contents`, time);
        const m = shapeGroupMatrix(item.transform, val, path);
        const op = Math.max(0, Math.min(100, val(item.transform.opacity, `${path}.transform.opacity`))) / 100;
        bake(sub, m, op, item.blendMode);
        draws.push(...sub.draws);
        visible.push(...sub.visible);
        all.push(...sub.all);
        break;
      }
      case 'fill':
      case 'gfill':
      case 'stroke':
      case 'gstroke': {
        const d = makeDraw(item, visible.slice(), val, path);
        if (d) draws.push(d);
        break;
      }
      case 'trim': {
        const range = trimRange(val(item.start, `${path}.start`), val(item.end, `${path}.end`), val(item.offset, `${path}.offset`));
        if (item.mode === 'individual') {
          const res = trimIndividually(visible.map((e) => e.paths), range);
          visible.forEach((e, k) => (e.paths = res[k]));
        } else {
          for (const e of visible) e.paths = trimSimultaneous(e.paths, range);
        }
        break;
      }
      case 'zigzag': {
        const size = val(item.size, `${path}.size`), ridges = val(item.ridges, `${path}.ridges`);
        for (const e of visible) e.paths = zigzag(e.paths, size, ridges, item.pointType === 'smooth');
        break;
      }
      case 'roundCorners': {
        const r = val(item.radius, `${path}.radius`);
        for (const e of visible) e.paths = roundCorners(e.paths, r);
        break;
      }
      case 'offset': {
        const a = val(item.amount, `${path}.amount`);
        for (const e of visible) e.paths = offsetPaths(e.paths, a, item.miterLimit);
        break;
      }
      case 'puckerBloat': {
        const a = val(item.amount, `${path}.amount`);
        for (const e of visible) e.paths = puckerBloat(e.paths, a);
        break;
      }
      case 'twist': {
        const a = val(item.angle, `${path}.angle`), c = val(item.center, `${path}.center`, true);
        for (const e of visible) e.paths = twist(e.paths, a, c);
        break;
      }
      case 'wiggle': {
        const args = [
          val(item.size, `${path}.size`), val(item.detail, `${path}.detail`), val(item.wigglesPerSecond, `${path}.wigglesPerSecond`),
          val(item.correlation, `${path}.correlation`), val(item.temporalPhase, `${path}.temporalPhase`), val(item.spatialPhase, `${path}.spatialPhase`),
        ];
        for (const e of visible) e.paths = wigglePaths(e.paths, args[0], args[1], args[2], args[3], args[4], args[5], item.seed, time, item.pointType === 'smooth');
        break;
      }
      case 'merge': {
        if (!visible.length) break;
        const merged: PathEntry = { paths: visible.flatMap((e) => e.paths), hidden: false, merge: item.mode, sourceId: item.id };
        for (const e of visible) e.hidden = true;
        visible = [merged];
        all.push(merged);
        break;
      }
      case 'repeater': {
        const rawCopies = Math.max(0, val(item.copies, `${path}.copies`));
        const copies = Math.min(1000, Math.ceil(rawCopies - 1e-6));
        const frac = rawCopies - Math.floor(rawCopies);
        const offset = val(item.offset, `${path}.offset`);
        const t = item.transform;
        const a = val(t.anchor, `${path}.transform.anchor`, true);
        const p = val(t.position, `${path}.transform.position`, true);
        const s = val(t.scale, `${path}.transform.scale`);
        const r = val(t.rotation, `${path}.transform.rotation`);
        const so = val(t.startOpacity, `${path}.transform.startOpacity`) / 100;
        const eo = val(t.endOpacity, `${path}.transform.endOpacity`) / 100;
        const step = repeaterStep(a, p, s, r, 1);
        // base matrix for the (possibly fractional / negative) offset
        const n0 = Math.floor(offset), f0 = offset - n0;
        let baseM: Mat2d = IDENTITY_2D;
        const inv = invert2d(step) ?? IDENTITY_2D;
        for (let k = 0; k < Math.min(1000, Math.abs(n0)); k++) baseM = mul2d(baseM, n0 > 0 ? step : inv);
        if (f0 > 1e-9) baseM = mul2d(baseM, repeaterStep(a, p, s, r, f0));
        const src: GroupResult = { draws, visible, all };
        const outDraws: DrawOp[][] = [];
        const outVisible: PathEntry[] = [];
        const outAll: PathEntry[] = [];
        let cur = baseM;
        for (let k = 0; k < copies; k++) {
          const c = cloneResult(src);
          let op = copies > 1 ? so + (eo - so) * (k / (copies - 1)) : so;
          if (k === copies - 1 && frac > 1e-6) op *= frac;
          bake(c, cur, op, 'normal');
          outDraws.push(c.draws);
          outVisible.push(...c.visible);
          outAll.push(...c.all);
          cur = mul2d(cur, step);
        }
        if (item.composite === 'above') outDraws.reverse();
        draws = outDraws.flat();
        visible = outVisible;
        all = outAll;
        break;
      }
    }
  }
  return { draws, visible, all };
}

/** Evaluate shape layer contents into draw ops (top-first), geometry in layer space. */
export function evaluateShapeContents(contents: ShapeItem[], val: ValFn, time: number, basePath = 'shape.contents'): DrawOp[] {
  return evalContents(contents, val, basePath, time).draws;
}

/** Matrix (layer space) of a nested shape group, for editing paths inside groups in the viewport. */
export function groupChainMatrix(contents: ShapeItem[], targetId: string, val: ValFn, basePath = 'shape.contents'): Mat2d | null {
  for (const item of contents) {
    if (item.id === targetId) return IDENTITY_2D;
    if (item.type === 'group') {
      const path = `${basePath}.${item.id}`;
      const inner = groupChainMatrix(item.contents, targetId, val, `${path}.contents`);
      if (inner) return mul2d(shapeGroupMatrix(item.transform, val, path), inner);
    }
  }
  return null;
}
