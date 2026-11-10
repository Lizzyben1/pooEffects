// ─────────────────────────────────────────────────────────────────────────────
// Graph Editor: Value graph and Speed graph for the selected properties.
//
//   Value graph — one curve per dimension; a Bézier handle at (Δt, Δv) from its
//     keyframe maps to the ease as influence = Δt / segment, speed = Δv / Δt.
//   Speed graph — the derivative (path speed for spatial properties). A handle
//     sits at (influence · segment, speed) and edits exactly those two numbers.
//
// Interaction rules that keep it predictable:
//   • The vertical range auto-fits the curves, but is FROZEN for the length of a
//     gesture — the scale never changes under the cursor mid-drag — and refits
//     on release. Panning or zooming the value axis turns auto-fit off (F = fit).
//   • Handles are drawn for selected keyframes (and for every keyframe when
//     there are only a few), start from the ease the keyframe is effectively
//     using, and can be grabbed without selecting first.
//   • Dragging keyframes moves the whole selection in time, and in value on the
//     value graph. In the speed graph a vertical drag sets the keyframe's speed.
//   • Wheel: pan values · Shift: scroll time · Ctrl/⌘: zoom time · Alt: zoom values.
// ─────────────────────────────────────────────────────────────────────────────

import { memo, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { AnimProp, Composition, Keyframe, Layer, PropValue } from '../../core/types';
import { beginTx, endTx, getApp, keyOf, propKey, refOf, setApp, useApp, openContextMenu, setTimeline, timelineOf } from '../../state/store';
import { toCompTime, toLayerTime, stretchFactor } from '../../core/evaluate';
import { effectiveEase, isNumArray, keyframedValue, segmentControls, segmentSpeed } from '../../anim/interpolate';
import { getAt, getDescriptor, isAnimProp } from '../../core/props';
import * as A from '../../state/actions';
import { formatTime, snapToFrame } from '../../core/time';
import type { Row } from './rows';
import type { TimeMap } from './TimelinePanel';
import { keyframeContextMenu } from '../menus/layerMenu';
import { commands as C } from '../commands';
import { KeyframeIcon } from '../icons';
import { trackPointer, useWheel, wheelDelta } from '../pointer';

interface Series {
  layer: Layer;
  path: string;
  prop: AnimProp;
  spatial: boolean;
  dims: number;
  label: string;
}

type Side = 'in' | 'out';
type Mode = 'value' | 'speed';

/** Something drawn that can be grabbed. */
interface Mark {
  kind: 'kf' | 'handle';
  si: number;
  ki: number;
  dim: number;
  side: Side;
  x: number;
  y: number;
  /** anchor of a handle (its keyframe point) */
  ax: number;
  ay: number;
  key: string;
  selected: boolean;
}

const DIM_COLORS = ['#ff6b7a', '#4fe08f', '#5aa8ff', '#ffd34d'];
const ONE_COLOR = '#ffb565';
const PAD_T = 18;
const PAD_B = 46;
/** with this many keyframes or fewer, every keyframe shows its handles (no need to select first) */
const ALL_HANDLES_MAX = 24;

const scalar = (k: Keyframe, d: number): number => (typeof k.v === 'number' ? k.v : (k.v as number[])[d] ?? 0);

function markerType(k: Keyframe, side: Side): 'hold' | 'linear' | 'auto' | 'bezier' {
  const t = side === 'in' ? k.inType : k.outType;
  if (side === 'out' && k.outType === 'hold') return 'hold';
  if (t === 'linear') return 'linear';
  if (t === 'auto') return 'auto';
  return t === 'hold' ? 'linear' : 'bezier';
}

function drawMarker(ctx: CanvasRenderingContext2D, x: number, y: number, type: 'hold' | 'linear' | 'auto' | 'bezier', r = 4.5): void {
  const rx = Math.round(x), ry = Math.round(y);
  ctx.beginPath();
  if (type === 'hold') ctx.rect(rx - r + 1, ry - r + 1, 2 * r - 2, 2 * r - 2);
  else if (type === 'auto') ctx.arc(rx, ry, r - 0.5, 0, Math.PI * 2);
  else if (type === 'bezier') {
    ctx.moveTo(rx - r, ry - r);
    ctx.lineTo(rx, ry);
    ctx.lineTo(rx - r, ry + r);
    ctx.closePath();
    ctx.moveTo(rx + r, ry - r);
    ctx.lineTo(rx, ry);
    ctx.lineTo(rx + r, ry + r);
    ctx.closePath();
  } else {
    ctx.moveTo(rx, ry - r);
    ctx.lineTo(rx + r, ry);
    ctx.lineTo(rx, ry + r);
    ctx.lineTo(rx - r, ry);
    ctx.closePath();
  }
  ctx.fill();
  ctx.stroke();
}

const fmt = (v: number): string => {
  const a = Math.abs(v);
  return a >= 1000 ? v.toFixed(0) : a >= 100 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : v.toFixed(3);
};

interface Props {
  comp: Composition;
  tm: TimeMap;
  rows: Row[];
}

export const GraphEditor = memo(function GraphEditor({ comp, tm, rows }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 400, h: 200 });
  const selKeys = useApp((s) => s.selKeys);
  const selProps = useApp((s) => s.selProps);
  const selLayers = useApp((s) => s.selLayers);
  const liveComp = useApp((s) => s.project.comps[comp.id]) ?? comp;
  const graphMode = useApp((s) => timelineOf(s, comp.id).graphMode);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const hover = useRef<Mark | null>(null);
  const tip = useRef<{ x: number; y: number; text: string } | null>(null);
  /** value-axis view: auto-fit until the user pans / zooms it */
  const view = useRef({ auto: true, lo: 0, hi: 1 });
  /** a gesture is in progress: the range must not move */
  const gesture = useRef(false);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // ── which properties to graph ──
  const series = useMemo(() => {
    const out: Series[] = [];
    const seen = new Set<string>();
    const add = (layer: Layer, path: string) => {
      const k = propKey(layer.id, path);
      if (seen.has(k)) return;
      const p = getAt(layer, path);
      if (!isAnimProp(p) || !p.keyframes.length) return;
      const v = p.keyframes[0].v;
      if (!(typeof v === 'number' || isNumArray(v))) return;
      seen.add(k);
      const desc = getDescriptor(layer, path);
      const dims = typeof v === 'number' ? 1 : Math.min((v as number[]).length, desc.dims ?? (v as number[]).length, layer.threeD || !path.startsWith('transform.') ? 4 : 2);
      out.push({ layer, path, prop: p, spatial: !!desc.spatial, dims, label: `${layer.name} › ${desc.name}` });
    };
    for (const pk of selProps) {
      const [lid, path] = pk.split('|');
      const l = liveComp.layers.find((x) => x.id === lid);
      if (l) add(l, path);
    }
    for (const key of selKeys) {
      const r = refOf(key);
      const l = liveComp.layers.find((x) => x.id === r.layerId);
      if (l) add(l, r.path);
    }
    if (!out.length) {
      for (const r of rows) {
        if (r.kind === 'prop' && (selLayers.length === 0 || selLayers.includes(r.layer.id))) {
          const l = liveComp.layers.find((x) => x.id === r.layer.id);
          if (l) add(l, r.path);
        }
        if (out.length >= 8) break;
      }
    }
    return out;
  }, [liveComp, selProps, selKeys, selLayers, rows]);

  const mode: Mode = graphMode === 'auto' ? (series.length > 0 && series.every((s) => s.spatial) ? 'speed' : 'value') : graphMode;
  const seriesKey = series.map((s) => propKey(s.layer.id, s.path)).join(',');

  // a different set of curves or graph type starts from a fitted view again
  useEffect(() => {
    view.current.auto = true;
    redraw();
  }, [seriesKey, mode]);

  // ── per-series maths ──
  const W = size.w, H = size.h;
  const plotH = Math.max(20, H - PAD_T - PAD_B);
  const sfOf = (s: Series) => Math.abs(stretchFactor(s.layer)) || 1;
  const ctOf = (s: Series, k: Keyframe) => toCompTime(s.layer, k.t);
  const curveDims = (s: Series) => (mode === 'speed' && s.spatial ? 1 : s.dims);
  const easeDimOf = (s: Series, dim: number) => (s.spatial ? 0 : dim);
  const colorOf = (si: number, dim: number, dims: number) => (dims === 1 ? (series.length > 1 ? DIM_COLORS[si % 4] : ONE_COLOR) : DIM_COLORS[dim % 4]);

  const valueAt = (s: Series, ct: number, dim: number): number => {
    const v = keyframedValue(s.prop, toLayerTime(s.layer, ct), s.spatial);
    return typeof v === 'number' ? v : (v as number[])[dim] ?? 0;
  };

  /** Speed (units per comp second) inside segment `a` at layer time `lt`. */
  const segSpeed = (s: Series, a: number, lt: number, dim: number): number => segmentSpeed(s.prop.keyframes, a, lt, easeDimOf(s, dim), s.spatial) / sfOf(s);

  /** Speed-graph y of one side of a keyframe: the ease it is effectively using. */
  const sideSpeed = (s: Series, ki: number, side: Side, dim: number): number => {
    const kfs = s.prop.keyframes;
    if ((side === 'in' && ki === 0) || (side === 'out' && ki === kfs.length - 1)) return sideSpeed(s, ki, side === 'in' ? 'out' : 'in', dim);
    if (kfs.length < 2) return 0;
    if (side === 'out' && kfs[ki].outType === 'hold') return 0;
    if (side === 'in' && kfs[ki - 1].outType === 'hold') return 0;
    return effectiveEase(kfs, ki, side, easeDimOf(s, dim), s.spatial).speed / sfOf(s);
  };

  // ── vertical range ──
  const tA = tm.t(0), tB = tm.t(W);
  const fit = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    const take = (v: number) => {
      if (!Number.isFinite(v)) return;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    };
    for (const s of series) {
      const kfs = s.prop.keyframes;
      const dims = curveDims(s);
      for (let d = 0; d < dims; d++) {
        if (mode === 'value') {
          const steps = Math.max(40, Math.min(240, Math.ceil(W / 6)));
          for (let i = 0; i <= steps; i++) take(valueAt(s, tA + ((tB - tA) * i) / steps, d));
          for (const k of kfs) {
            const ct = ctOf(s, k);
            if (ct >= tA && ct <= tB) take(scalar(k, d));
          }
        } else {
          take(0);
          for (let a = 0; a < kfs.length - 1; a++) {
            const c0 = ctOf(s, kfs[a]), c1 = ctOf(s, kfs[a + 1]);
            if (Math.max(c0, c1) < tA || Math.min(c0, c1) > tB) continue;
            take(sideSpeed(s, a, 'out', d));
            take(sideSpeed(s, a + 1, 'in', d));
            for (let i = 1; i < 24; i++) take(segSpeed(s, a, kfs[a].t + ((kfs[a + 1].t - kfs[a].t) * i) / 24, d));
          }
        }
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      lo = 0;
      hi = 1;
    }
    if (hi - lo < 1e-6) {
      const pad = Math.max(1, Math.abs(hi) * 0.1);
      lo -= pad;
      hi += pad;
    }
    const pad = (hi - lo) * 0.14;
    return { lo: lo - pad, hi: hi + pad };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, mode, tA, tB, W]);
  if (view.current.auto && !gesture.current) {
    view.current.lo = fit.lo;
    view.current.hi = fit.hi;
  }
  const range = { lo: view.current.lo, hi: view.current.hi };
  const yOf = (v: number, r = range) => PAD_T + (1 - (v - r.lo) / (r.hi - r.lo)) * plotH;
  const vOf = (y: number, r = range) => r.lo + (1 - (y - PAD_T) / plotH) * (r.hi - r.lo);

  // ── geometry of everything grabbable ──
  const totalKeys = series.reduce((n, s) => n + s.prop.keyframes.length, 0);
  const allHandles = totalKeys <= ALL_HANDLES_MAX;
  const marks: Mark[] = [];
  series.forEach((s, si) => {
    const kfs = s.prop.keyframes;
    const dims = curveDims(s);
    for (let d = 0; d < dims; d++) {
      kfs.forEach((k, ki) => {
        const key = keyOf({ layerId: s.layer.id, path: s.path, kfId: k.id });
        const selected = selKeys.includes(key);
        const ct = ctOf(s, k);
        const x = tm.x(ct);
        const next = kfs[ki + 1], prev = kfs[ki - 1];
        const hasOut = !!next && k.outType !== 'hold';
        const hasIn = !!prev && prev.outType !== 'hold';
        if (mode === 'value') {
          const y = yOf(scalar(k, d));
          marks.push({ kind: 'kf', si, ki, dim: d, side: 'out', x, y, ax: x, ay: y, key, selected });
          // spatial properties ease distance along the path, not each component: their handles live in the speed graph
          if (s.spatial || !(selected || allHandles)) return;
          if (hasOut) {
            const c = segmentControls(kfs, ki, d, scalar(k, d), scalar(next, d), scalar);
            marks.push({ kind: 'handle', si, ki, dim: d, side: 'out', x: tm.x(ct + c.x1 * (ctOf(s, next) - ct)), y: yOf(c.y1), ax: x, ay: y, key, selected });
          }
          if (hasIn) {
            const pt = ctOf(s, prev);
            const c = segmentControls(kfs, ki - 1, d, scalar(prev, d), scalar(k, d), scalar);
            marks.push({ kind: 'handle', si, ki, dim: d, side: 'in', x: tm.x(pt + c.x2 * (ct - pt)), y: yOf(c.y2), ax: x, ay: y, key, selected });
          }
          return;
        }
        // speed graph: the incoming and outgoing speed are separate points when they differ
        const yOut = yOf(sideSpeed(s, ki, 'out', d)), yIn = yOf(sideSpeed(s, ki, 'in', d));
        marks.push({ kind: 'kf', si, ki, dim: d, side: 'out', x, y: yOut, ax: x, ay: yOut, key, selected });
        if (Math.abs(yIn - yOut) > 1.5) marks.push({ kind: 'kf', si, ki, dim: d, side: 'in', x, y: yIn, ax: x, ay: yIn, key, selected });
        if (!(selected || allHandles)) return;
        const ed = easeDimOf(s, d);
        if (hasOut) {
          const e = effectiveEase(kfs, ki, 'out', ed, s.spatial);
          marks.push({ kind: 'handle', si, ki, dim: d, side: 'out', x: tm.x(ct + e.influence * (ctOf(s, next) - ct)), y: yOut, ax: x, ay: yOut, key, selected });
        }
        if (hasIn) {
          const e = effectiveEase(kfs, ki, 'in', ed, s.spatial);
          marks.push({ kind: 'handle', si, ki, dim: d, side: 'in', x: tm.x(ct - e.influence * (ct - ctOf(s, prev))), y: yIn, ax: x, ay: yIn, key, selected });
        }
      });
    }
  });

  const sameMark = (a: Mark | null, b: Mark | null) => !!a && !!b && a.kind === b.kind && a.key === b.key && a.dim === b.dim && a.side === b.side;

  /** Nearest grabbable thing. Handles of selected keyframes win over keyframes, which win over other handles. */
  const hitTest = (x: number, y: number): Mark | null => {
    let best: Mark | null = null, bestScore = Infinity;
    for (const m of marks) {
      const dist = Math.hypot(m.x - x, m.y - y);
      const reach = m.kind === 'handle' ? 9 : 8;
      if (dist > reach) continue;
      const tier = m.kind === 'handle' ? (m.selected ? 0 : 2) : 1;
      const score = tier * 100 + dist;
      if (score < bestScore) {
        best = m;
        bestScore = score;
      }
    }
    return best;
  };

  // ── draw ──
  const draw = () => {
    const c = canvas.current;
    if (!c || W < 2 || H < 2) return;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0d0f14';
    ctx.fillRect(0, 0, W, H);
    // horizontal grid + value labels
    const span = range.hi - range.lo;
    const mag = Math.pow(10, Math.floor(Math.log10(span / 5)));
    const step = [1, 2, 5, 10].map((m) => m * mag).find((st) => span / st <= 8) ?? mag * 10;
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    for (let v = Math.ceil(range.lo / step) * step; v <= range.hi; v += step) {
      const y = Math.round(yOf(v)) + 0.5;
      const zero = Math.abs(v) < step * 1e-6;
      ctx.strokeStyle = zero ? '#39445a' : '#1a1f29';
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
      ctx.fillStyle = zero ? '#8a93a6' : '#5b6474';
      ctx.fillText(Number(v.toPrecision(6)).toString(), 4, y - 6);
    }
    // vertical second lines
    ctx.strokeStyle = '#171b24';
    const tStep = tm.pxPerSec >= 30 ? 1 : tm.pxPerSec >= 6 ? 5 : 30;
    for (let t = Math.ceil(tA / tStep) * tStep; t <= tB; t += tStep) {
      const x = Math.round(tm.x(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
    if (!series.length) {
      ctx.fillStyle = '#5b6474';
      ctx.font = '12px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Select an animated property (or its keyframes) to see its curves', W / 2, H / 2 - 10);
      ctx.textAlign = 'left';
      return;
    }
    // curves
    series.forEach((s, si) => {
      const kfs = s.prop.keyframes;
      const dims = curveDims(s);
      for (let d = 0; d < dims; d++) {
        const col = colorOf(si, d, dims);
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.6;
        ctx.shadowColor = col + '66';
        ctx.shadowBlur = 6;
        ctx.beginPath();
        if (mode === 'value') {
          for (let x = 0; x <= W; x += 2) {
            const y = yOf(valueAt(s, tm.t(x), d));
            if (x === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
        } else {
          // segment by segment, so the jump in speed at a keyframe is drawn exactly
          const y0 = yOf(0);
          ctx.moveTo(0, y0);
          for (let a = 0; a < kfs.length - 1; a++) {
            const xa = tm.x(ctOf(s, kfs[a])), xb = tm.x(ctOf(s, kfs[a + 1]));
            const left = Math.min(xa, xb), right = Math.max(xa, xb);
            if (right < 0 || left > W) continue;
            if (a === 0) ctx.lineTo(xa, y0);
            const n = Math.max(2, Math.min(600, Math.ceil((Math.min(W, right) - Math.max(0, left)) / 2)));
            const fa = Math.max(0, Math.min(1, (Math.max(0, left) - xa) / (xb - xa || 1)));
            const fb = Math.max(0, Math.min(1, (Math.min(W, right) - xa) / (xb - xa || 1)));
            const f0 = Math.min(fa, fb), f1 = Math.max(fa, fb);
            for (let i = 0; i <= n; i++) {
              const f = f0 + ((f1 - f0) * i) / n;
              const yv = i === 0 && f === 0 ? sideSpeed(s, a, 'out', d) : i === n && f === 1 ? sideSpeed(s, a + 1, 'in', d) : segSpeed(s, a, kfs[a].t + (kfs[a + 1].t - kfs[a].t) * f, d);
              ctx.lineTo(xa + (xb - xa) * f, yOf(yv));
            }
            if (a === kfs.length - 2) ctx.lineTo(xb, y0);
          }
          ctx.lineTo(W, y0);
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
    });
    // handles first, keyframes on top
    const hv = hover.current;
    for (const m of marks) {
      if (m.kind !== 'handle') continue;
      const s = series[m.si];
      const col = colorOf(m.si, m.dim, curveDims(s));
      const hot = sameMark(hv, m);
      ctx.globalAlpha = m.selected || hot ? 1 : 0.5;
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(m.ax, m.ay);
      ctx.lineTo(m.x, m.y);
      ctx.stroke();
      ctx.fillStyle = hot ? '#fff' : '#0d0f14';
      ctx.beginPath();
      ctx.arc(m.x, m.y, hot ? 5.5 : 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    for (const m of marks) {
      if (m.kind !== 'kf') continue;
      const k = series[m.si].prop.keyframes[m.ki];
      const hot = hv?.kind === 'kf' && hv.key === m.key;
      ctx.fillStyle = m.selected ? '#ffc46b' : hot ? '#fff' : '#d8dee9';
      ctx.strokeStyle = '#000a';
      ctx.lineWidth = 1;
      drawMarker(ctx, m.x, m.y, markerType(k, m.side), m.selected || hot ? 5.5 : 4.5);
    }
    // legend
    let ly = 12;
    ctx.font = '600 10.5px Inter, sans-serif';
    ctx.textBaseline = 'middle';
    series.slice(0, 6).forEach((s, si) => {
      const dims = curveDims(s);
      const label = mode === 'speed' ? `${s.label} — speed (${s.spatial ? 'px' : 'units'}/s)` : s.label;
      const w = ctx.measureText(label).width + (dims > 1 ? dims * 9 + 4 : 12);
      ctx.fillStyle = '#12151cdd';
      ctx.fillRect(W - w - 16, ly - 8, w + 10, 16);
      let cx = W - w - 10;
      for (let d = 0; d < dims; d++) {
        ctx.fillStyle = colorOf(si, d, dims);
        ctx.fillRect(cx, ly - 3, 6, 6);
        cx += 9;
      }
      ctx.fillStyle = '#c9d1de';
      ctx.fillText(label, cx + 3, ly);
      ly += 18;
    });
    // readout next to the cursor while dragging
    const tp = tip.current;
    if (tp) {
      ctx.font = '600 10.5px "JetBrains Mono", monospace';
      const w = ctx.measureText(tp.text).width + 12;
      const bx = Math.max(4, Math.min(W - w - 4, tp.x + 14));
      const by = Math.max(4, Math.min(H - 24, tp.y - 26));
      ctx.fillStyle = '#000c';
      ctx.fillRect(bx, by, w, 18);
      ctx.fillStyle = '#ffe2b8';
      ctx.fillText(tp.text, bx + 6, by + 9.5);
    }
  };

  useEffect(draw);

  // ── helpers for gestures ──
  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = wrap.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const timeLabel = (ct: number) => formatTime(Math.max(0, ct), comp.frameRate, comp.dropFrame, getApp().project.settings.timeDisplay);
  const beginGesture = () => {
    gesture.current = true;
    return { lo: view.current.lo, hi: view.current.hi };
  };
  const endGesture = () => {
    gesture.current = false;
    tip.current = null;
    redraw();
  };
  const fitView = () => {
    view.current.auto = true;
    redraw();
  };

  // F fits the view (while the graph editor is showing)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'KeyF' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (getApp().dialog) return;
      fitView();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ── keyframe drag: retime the selection; revalue it (value graph) or set its speed (speed graph) ──
  const dragKeys = (e: React.PointerEvent, h: Mark) => {
    const st = getApp();
    let keys = st.selKeys;
    if (e.shiftKey || e.ctrlKey || e.metaKey) keys = keys.includes(h.key) ? keys.filter((k) => k !== h.key) : [...keys, h.key];
    else if (!keys.includes(h.key)) keys = [h.key];
    if (keys !== st.selKeys) setApp({ selKeys: keys });
    if (!keys.includes(h.key)) return;
    const s = series[h.si];
    const orig = A.keyframeCompTimes(comp.id, keys);
    const grabbedT = orig.get(h.key) ?? 0;
    // starting values of every selected numeric keyframe
    const startVals = new Map<string, PropValue>();
    for (const k of keys) {
      const r = refOf(k);
      const p = getAt(liveComp.layers.find((l) => l.id === r.layerId), r.path);
      const kf = isAnimProp(p) ? p.keyframes.find((x) => x.id === r.kfId) : undefined;
      if (kf && (typeof kf.v === 'number' || isNumArray(kf.v))) startVals.set(k, kf.v);
    }
    const x0 = e.clientX, y0 = e.clientY;
    const r0 = beginGesture();
    const perPx = (r0.hi - r0.lo) / plotH;
    const sf = sfOf(s);
    let moved = false;
    let axis: 'x' | 'y' | null = null;
    trackPointer(e, (ev) => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      if (!moved) {
        if (Math.hypot(dx, dy) < 4) return;
        moved = true;
        beginTx();
        // the speed graph commits to one axis per drag, so a retime never disturbs the easing
        if (mode === 'speed') axis = Math.abs(dy) > Math.abs(dx) * 1.2 ? 'y' : 'x';
      }
      const lock = mode === 'speed' ? axis : ev.shiftKey ? (Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y') : null;
      const dt = lock === 'y' ? 0 : snapToFrame(grabbedT + dx / tm.pxPerSec, comp.frameRate) - grabbedT;
      A.retimeKeyframes(comp.id, orig, dt, false);
      const [mx, my] = local(ev);
      if (mode === 'value') {
        const dv = lock === 'x' ? 0 : -dy * perPx;
        const next = new Map<string, PropValue>();
        for (const [k, v0] of startVals) {
          if (typeof v0 === 'number') next.set(k, v0 + dv);
          else {
            const nv = (v0 as number[]).slice();
            if (h.dim < nv.length) nv[h.dim] += dv;
            next.set(k, nv);
          }
        }
        A.setKeyframeValues(comp.id, next);
        const gv = startVals.get(h.key);
        const cur = gv === undefined ? 0 : (typeof gv === 'number' ? gv : (gv as number[])[h.dim] ?? 0) + dv;
        tip.current = { x: mx, y: my, text: `${timeLabel(grabbedT + dt)}   ${fmt(cur)}` };
      } else if (axis === 'y') {
        let speed = vOf(h.y + dy, r0) * sf;
        if (s.spatial) speed = Math.max(0, speed);
        const ed = easeDimOf(s, h.dim);
        const kfs = s.prop.keyframes;
        // one speed through the keyframe: both sides follow the cursor
        if (h.ki > 0) A.setKeyframeEase(comp.id, h.key, 'in', ed, { speed, influence: effectiveEase(kfs, h.ki, 'in', ed, s.spatial).influence }, false, true);
        if (h.ki < kfs.length - 1) A.setKeyframeEase(comp.id, h.key, 'out', ed, { speed, influence: effectiveEase(kfs, h.ki, 'out', ed, s.spatial).influence }, false, true);
        tip.current = { x: mx, y: my, text: `speed ${fmt(speed / sf)}/s` };
      } else tip.current = { x: mx, y: my, text: timeLabel(grabbedT + dt) };
    }, () => {
      if (moved) {
        A.mergeKeyframeCollisions(comp.id, [...orig.keys()]);
        endTx();
      }
      endGesture();
    });
  };

  // ── handle drag: influence (horizontal reach) and speed ──
  const dragHandle = (e: React.PointerEvent, h: Mark) => {
    const s = series[h.si];
    const kfs = s.prop.keyframes;
    const k = kfs[h.ki];
    const other = kfs[h.side === 'out' ? h.ki + 1 : h.ki - 1];
    if (!k || !other) return;
    if (!getApp().selKeys.includes(h.key)) setApp({ selKeys: e.shiftKey ? [...getApp().selKeys, h.key] : [h.key] });
    const ct = ctOf(s, k);
    const segC = ctOf(s, other) - ct; // signed comp-time span towards the neighbour
    const segL = Math.abs(other.t - k.t); // layer seconds
    const kv = scalar(k, h.dim);
    const sf = sfOf(s);
    const ed = easeDimOf(s, h.dim);
    const e0 = effectiveEase(kfs, h.ki, h.side, ed, s.spatial);
    const wasLinked = k.inType === 'continuous' || k.outType === 'continuous';
    // Alt toggles between one speed through the keyframe and separate incoming / outgoing speeds
    const link = e.altKey ? !wasLinked : undefined;
    const x0 = e.clientX, y0 = e.clientY;
    // the handle follows the cursor from where it was grabbed (no jump to the pointer on the first move)
    const [gx, gy] = local(e);
    const offX = h.x - gx, offY = h.y - gy;
    const r0 = beginGesture();
    let moved = false;
    trackPointer(e, (ev) => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      if (!moved) {
        if (Math.hypot(dx, dy) < 3) return;
        moved = true;
        beginTx();
      }
      const [px, py] = local(ev);
      const mx = px + offX, my = py + offY;
      let influence = Math.min(1, Math.max(0.001, (tm.t(mx) - ct) / (segC || 1e-9)));
      let speed: number;
      if (mode === 'value') {
        const v = vOf(my, r0);
        speed = (h.side === 'out' ? v - kv : kv - v) / (influence * segL || 1e-9);
        // Shift keeps the slope and only changes the reach
        if (ev.shiftKey) speed = e0.speed;
      } else {
        speed = vOf(my, r0) * sf;
        if (ev.shiftKey) {
          if (Math.abs(dx) >= Math.abs(dy)) speed = e0.speed;
          else influence = e0.influence;
        }
        if (s.spatial) speed = Math.max(0, speed);
      }
      A.setKeyframeEase(comp.id, h.key, h.side, ed, { speed, influence }, false, link);
      tip.current = { x: mx, y: my, text: `speed ${fmt(speed / sf)}/s   influence ${(influence * 100).toFixed(0)}%` };
    }, () => {
      if (moved) endTx();
      endGesture();
    });
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.button === 2) return;
    const [x, y] = local(e);
    const h = hitTest(x, y);
    // middle button (or Alt on empty space) pans the value axis
    if (e.button === 1 || (e.button === 0 && e.altKey && !h)) {
      e.preventDefault();
      const y0 = e.clientY;
      const r0 = { lo: view.current.lo, hi: view.current.hi };
      const perPx = (r0.hi - r0.lo) / plotH;
      view.current.auto = false;
      trackPointer(e, (ev) => {
        const dv = (ev.clientY - y0) * perPx;
        view.current.lo = r0.lo + dv;
        view.current.hi = r0.hi + dv;
        redraw();
      });
      return;
    }
    if (e.button !== 0) return;
    if (h?.kind === 'kf') return dragKeys(e, h);
    if (h?.kind === 'handle') return dragHandle(e, h);
    // empty space: marquee (a plain click clears the selection)
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const base = additive ? getApp().selKeys : [];
    if (!additive && getApp().selKeys.length) setApp({ selKeys: [] });
    setMarquee({ x0: x, y0: y, x1: x, y1: y });
    beginGesture();
    trackPointer(e, (ev) => {
      const [mx, my] = local(ev);
      setMarquee({ x0: x, y0: y, x1: mx, y1: my });
      const xa = Math.min(x, mx), xb = Math.max(x, mx), ya = Math.min(y, my), yb = Math.max(y, my);
      const keys = new Set(base);
      for (const m of marks) if (m.kind === 'kf' && m.x >= xa && m.x <= xb && m.y >= ya && m.y <= yb) keys.add(m.key);
      setApp({ selKeys: [...keys] });
    }, () => {
      setMarquee(null);
      endGesture();
    });
  };

  // wheel: pan values · Shift: scroll time · Ctrl/⌘: zoom time · Alt: zoom values
  useWheel(wrap, (e) => {
    e.preventDefault();
    e.stopPropagation();
    const { dx, dy } = wheelDelta(e);
    const [mx, my] = local(e);
    if (e.ctrlKey || e.metaKey) {
      const nz = Math.max(2, Math.min(4000, tm.pxPerSec * Math.pow(1.002, -dy)));
      setTimeline(comp.id, { pxPerSec: nz, scrollTime: Math.max(0, tm.t(mx) - mx / nz) });
    } else if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) {
      const d = e.shiftKey ? dy || dx : dx;
      const maxScroll = Math.max(0, comp.duration - W / tm.pxPerSec);
      setTimeline(comp.id, { scrollTime: Math.max(0, Math.min(maxScroll, tm.scrollTime + d / tm.pxPerSec)) });
    } else if (e.altKey) {
      const f = Math.pow(1.002, dy);
      const v = vOf(my);
      view.current = { auto: false, lo: v - (v - view.current.lo) * f, hi: v + (view.current.hi - v) * f };
      redraw();
    } else {
      const dv = -dy * ((view.current.hi - view.current.lo) / plotH) * 0.6;
      view.current = { auto: false, lo: view.current.lo + dv, hi: view.current.hi + dv };
      redraw();
    }
  });

  const spatialHint = mode === 'value' && series.some((s) => s.spatial);
  const setMode = (m: 'auto' | Mode) => setTimeline(comp.id, { graphMode: m });

  return (
    <div
      ref={wrap}
      className="tl-graph"
      onPointerDown={onDown}
      onPointerMove={(e) => {
        if (e.buttons) return;
        const [x, y] = local(e);
        const h = hitTest(x, y);
        (e.currentTarget as HTMLElement).style.cursor = h ? (h.kind === 'handle' ? 'grab' : 'move') : 'default';
        if (!sameMark(h, hover.current) || !!h !== !!hover.current) {
          hover.current = h;
          draw();
        }
      }}
      onPointerLeave={() => {
        if (hover.current) {
          hover.current = null;
          draw();
        }
      }}
      onDoubleClick={(e) => {
        // double-click a curve to add a keyframe there
        const [x, y] = local(e);
        if (hitTest(x, y)) return;
        const ct = tm.t(x);
        for (const s of series) {
          const kfs = s.prop.keyframes;
          const lt = toLayerTime(s.layer, ct);
          const a = kfs.findIndex((k, i) => i < kfs.length - 1 && lt >= k.t && lt <= kfs[i + 1].t);
          for (let d = 0; d < curveDims(s); d++) {
            const cy = yOf(mode === 'value' ? valueAt(s, ct, d) : a >= 0 ? segSpeed(s, a, lt, d) : 0);
            if (Math.abs(cy - y) > 7) continue;
            A.addKeyframeAt(comp.id, s.layer.id, s.path, snapToFrame(ct, comp.frameRate));
            return;
          }
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const [x, y] = local(e);
        const h = hitTest(x, y);
        // the menu acts on what is under the cursor, not on a stale selection
        if (h && !getApp().selKeys.includes(h.key)) setApp({ selKeys: [h.key] });
        if (h || getApp().selKeys.length) {
          openContextMenu(e.clientX, e.clientY, keyframeContextMenu());
          return;
        }
        openContextMenu(e.clientX, e.clientY, [
          { label: 'Fit View', shortcut: 'F', action: fitView },
          { label: 'Select All Keyframes', disabled: !totalKeys, action: () => setApp({ selKeys: [...new Set(marks.filter((m) => m.kind === 'kf').map((m) => m.key))] }) },
          { separator: true },
          { label: 'Auto-Select Graph Type', checked: graphMode === 'auto', action: () => setMode('auto') },
          { label: 'Value Graph', checked: graphMode === 'value', action: () => setMode('value') },
          { label: 'Speed Graph', checked: graphMode === 'speed', action: () => setMode('speed') },
        ]);
      }}
    >
      <canvas ref={canvas} style={{ width: W, height: H, display: 'block' }} />
      {marquee && (
        <div className="tl-marquee" style={{ left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }} />
      )}
      {spatialHint && (
        <div className="ge-hint" onPointerDown={(e) => e.stopPropagation()}>
          Position eases along its motion path, so its easing handles are in the Speed Graph.
          <button className="link-btn" onClick={() => setMode('speed')}>Show Speed Graph</button>
        </div>
      )}
      <div className="ge-tools" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <button className="icon-btn" title="Toggle Hold (Ctrl+Alt+H)" onClick={C.interpHold}><KeyframeIcon size={11} type="hold" /></button>
        <button className="icon-btn" title="Convert to Linear" onClick={C.interpLinear}><KeyframeIcon size={11} type="linear" /></button>
        <button className="icon-btn" title="Convert to Auto Bezier" onClick={C.interpAuto}><KeyframeIcon size={11} type="auto" /></button>
        <button className="icon-btn" title="Convert to Bezier (keeps the curve, adds handles)" onClick={C.interpBezier}><KeyframeIcon size={11} type="bezier" /></button>
        <span className="ge-sep" />
        <button className="btn sm ghost" title="Easy Ease (F9)" onClick={C.easyEase}>Easy Ease</button>
        <button className="btn sm ghost" title="Easy Ease In (Shift+F9)" onClick={C.easeIn}>Ease In</button>
        <button className="btn sm ghost" title="Easy Ease Out (Ctrl+Shift+F9)" onClick={C.easeOut}>Ease Out</button>
        <span className="ge-sep" />
        <div className="seg" role="group" aria-label="Graph type">
          <button className={`btn sm ${graphMode === 'auto' ? 'primary' : 'ghost'}`} title="Speed graph for Position-like properties, value graph for the rest" onClick={() => setMode('auto')}>Auto</button>
          <button className={`btn sm ${graphMode === 'value' ? 'primary' : 'ghost'}${graphMode === 'auto' && mode === 'value' ? ' hinted' : ''}`} title="Value Graph" onClick={() => setMode('value')}>Value</button>
          <button className={`btn sm ${graphMode === 'speed' ? 'primary' : 'ghost'}${graphMode === 'auto' && mode === 'speed' ? ' hinted' : ''}`} title="Speed Graph" onClick={() => setMode('speed')}>Speed</button>
        </div>
        <span className="ge-sep" />
        <button className={`btn sm ${view.current.auto ? 'ghost' : 'primary'}`} title="Fit the curves vertically (F). Wheel pans values · Alt+wheel zooms values · Ctrl+wheel zooms time · Shift+wheel scrolls time" onClick={fitView}>Fit</button>
      </div>
    </div>
  );
});

