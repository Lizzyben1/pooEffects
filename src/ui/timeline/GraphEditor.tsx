// ─────────────────────────────────────────────────────────────────────────────
// Graph Editor: Value graph and Speed graph for selected properties.
//   Value graph — per-dimension value curves; Bézier handles map to AE eases:
//     out-handle (Δt, Δv) → influence = Δt/segment, speed = Δv/Δt (per layer second).
//   Speed graph — derivative (|velocity| for spatial props); handles are drawn
//     at (influence·segment, speed) and edit those two numbers directly.
// Keyframes can be retimed (x) and revalued (y), box-selected and eased.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AnimProp, Composition, Keyframe, Layer } from '../../core/types';
import { beginTx, endTx, getApp, keyOf, propKey, refOf, setApp, useApp, openContextMenu, setTimeline } from '../../state/store';
import { getTime, timeStore } from '../../state/time';
import { toCompTime, toLayerTime, stretchFactor } from '../../core/evaluate';
import { keyframedValue, segmentControls, speedAt, isNumArray } from '../../anim/interpolate';
import { getAt, getDescriptor, isAnimProp } from '../../core/props';
import * as A from '../../state/actions';
import { snapToFrame } from '../../core/time';
import type { Row } from './rows';
import type { TimeMap } from './TimelinePanel';
import { keyframeContextMenu } from '../menus/layerMenu';
import { commands as C } from '../commands';
import { KeyframeIcon } from '../icons';

interface Series {
  layer: Layer;
  path: string;
  prop: AnimProp;
  spatial: boolean;
  dims: number;
  label: string;
}

const DIM_COLORS = ['#ff6b7a', '#4fe08f', '#5aa8ff', '#ffd34d'];
const ONE_COLOR = '#ffb565';

type Hit =
  | { kind: 'kf'; s: Series; k: Keyframe; dim: number }
  | { kind: 'handle'; s: Series; k: Keyframe; idx: number; side: 'in' | 'out'; dim: number };

function kfMarkerType(k: Keyframe, side?: 'in' | 'out'): 'hold' | 'linear' | 'auto' | 'bezier' {
  if (side === 'in') {
    if (k.inType === 'hold') return 'hold';
    if (k.inType === 'linear') return 'linear';
    if (k.inType === 'auto') return 'auto';
    return 'bezier';
  }
  if (k.outType === 'hold') return 'hold';
  if (k.inType === 'auto' && k.outType === 'auto') return 'auto';
  if (k.inType === 'linear' && k.outType === 'linear') return 'linear';
  return 'bezier';
}

function drawKeyframeMarker(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  type: 'hold' | 'linear' | 'auto' | 'bezier',
): void {
  const rx = Math.round(x);
  const ry = Math.round(y);
  if (type === 'hold') {
    ctx.fillRect(rx - 3.5, ry - 3.5, 7, 7);
    ctx.strokeRect(rx - 3.5, ry - 3.5, 7, 7);
    return;
  }
  ctx.beginPath();
  if (type === 'auto') {
    ctx.arc(rx, ry, 4, 0, Math.PI * 2);
  } else if (type === 'bezier') {
    ctx.moveTo(rx - 4, ry - 4);
    ctx.lineTo(rx, ry);
    ctx.lineTo(rx - 4, ry + 4);
    ctx.closePath();
    ctx.moveTo(rx + 4, ry - 4);
    ctx.lineTo(rx, ry);
    ctx.lineTo(rx + 4, ry + 4);
    ctx.closePath();
  } else {
    ctx.moveTo(rx, ry - 4.5);
    ctx.lineTo(rx + 4.5, ry);
    ctx.lineTo(rx, ry + 4.5);
    ctx.lineTo(rx - 4.5, ry);
    ctx.closePath();
  }
  ctx.fill();
  ctx.stroke();
}

export function GraphEditor({ comp, tm, rows }: { comp: Composition; tm: TimeMap; rows: Row[] }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 400, h: 200 });
  const selKeys = useApp((s) => s.selKeys);
  const selProps = useApp((s) => s.selProps);
  const selLayers = useApp((s) => s.selLayers);
  const project = useApp((s) => s.project);
  const mode = useApp((s) => s.timelines[comp.id]?.graphMode ?? 'value');
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const hover = useRef<Hit | null>(null);
  const yRange = useRef<{ lo: number; hi: number }>({ lo: 0, hi: 1 });
  const [yPan, setYPan] = useState(0);
  const [yZoom, setYZoom] = useState(1);
  const baseBounds = useRef({ lo: 0, hi: 1 });

  useEffect(() => {
    setYPan(0);
    setYZoom(1);
  }, [mode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        setYPan(0);
        setYZoom(1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // which properties to graph
  const liveComp = project.comps[comp.id] ?? comp;
  const series: Series[] = [];
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
    series.push({ layer, path, prop: p, spatial: !!desc.spatial, dims, label: `${layer.name} › ${desc.name}` });
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
  if (!series.length) {
    for (const r of rows) {
      if (r.kind === 'prop' && (selLayers.length === 0 || selLayers.includes(r.layer.id))) {
        const l = liveComp.layers.find((x) => x.id === r.layer.id);
        if (l) add(l, r.path);
      }
      if (series.length >= 8) break;
    }
  }

  const valueAt = (s: Series, ct: number, dim: number): number => {
    const v = keyframedValue(s.prop, toLayerTime(s.layer, ct), s.spatial);
    return typeof v === 'number' ? v : (v as number[])[dim] ?? 0;
  };
  const speedAtT = (s: Series, ct: number, dim: number): number => {
    const sp = speedAt(s.prop, toLayerTime(s.layer, ct), s.spatial);
    const k = Math.abs(stretchFactor(s.layer));
    return (s.spatial ? sp[0] : sp[dim] ?? 0) / k;
  };
  const curveDims = (s: Series) => (mode === 'speed' && s.spatial ? 1 : s.dims);
  const sample = (s: Series, ct: number, dim: number) => (mode === 'value' ? valueAt(s, ct, dim) : speedAtT(s, ct, dim));

  // fit y range to visible curves
  const tA = tm.t(0), tB = tm.t(size.w);
  let lo = Infinity, hi = -Infinity;
  for (const s of series) {
    const kfs = s.prop.keyframes;
    const dims = curveDims(s);
    for (let d = 0; d < dims; d++) {
      // 1. Screen sweep at dense resolution across visible width
      const steps = Math.max(80, Math.min(300, Math.ceil(size.w / 4)));
      for (let i = 0; i <= steps; i++) {
        const v = sample(s, tA + ((tB - tA) * i) / steps, d);
        if (Number.isFinite(v)) {
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
      // 2. Sample keyframe incoming/outgoing speeds and ease tangents
      for (let idx = 0; idx < kfs.length; idx++) {
        const k = kfs[idx];
        const ct = toCompTime(s.layer, k.t);
        if (mode === 'value') {
          const v = valueAt(s, ct, d);
          if (Number.isFinite(v)) {
            lo = Math.min(lo, v);
            hi = Math.max(hi, v);
          }
        } else {
          if (idx > 0) {
            const vIn = speedAtT(s, ct - 1e-4, d);
            if (Number.isFinite(vIn)) {
              lo = Math.min(lo, vIn);
              hi = Math.max(hi, vIn);
            }
          }
          if (idx < kfs.length - 1) {
            const vOut = speedAtT(s, ct + 1e-4, d);
            if (Number.isFinite(vOut)) {
              lo = Math.min(lo, vOut);
              hi = Math.max(hi, vOut);
            }
          }
          const sf = Math.abs(stretchFactor(s.layer));
          const easeOf = (list: { speed: number; influence: number }[]) => list[d] ?? list[0];
          if (k.easeIn) {
            const e = easeOf(k.easeIn);
            if (e && Number.isFinite(e.speed)) {
              lo = Math.min(lo, e.speed / sf);
              hi = Math.max(hi, e.speed / sf);
            }
          }
          if (k.easeOut) {
            const e = easeOf(k.easeOut);
            if (e && Number.isFinite(e.speed)) {
              lo = Math.min(lo, e.speed / sf);
              hi = Math.max(hi, e.speed / sf);
            }
          }
        }
        // 3. Dense segment sampling between neighbouring keyframes in or near view
        if (idx < kfs.length - 1) {
          const nextK = kfs[idx + 1];
          const ctNext = toCompTime(s.layer, nextK.t);
          if (ctNext >= tA && ct <= tB) {
            const segSpan = ctNext - ct;
            for (let step = 1; step <= 9; step++) {
              const v = sample(s, ct + segSpan * (step / 10), d);
              if (Number.isFinite(v)) {
                lo = Math.min(lo, v);
                hi = Math.max(hi, v);
              }
            }
          }
        }
      }
    }
  }
  if (!Number.isFinite(lo)) lo = 0;
  if (!Number.isFinite(hi)) hi = 1;
  if (mode === 'speed' && !series.some((s) => !s.spatial && curveDims(s) > 1 && lo < 0)) {
    lo = Math.min(0, lo);
  }
  if (hi - lo < 1e-6) {
    hi += 1;
    lo -= 1;
  }
  const pad = (hi - lo) * 0.15;
  const baseLo = lo - pad;
  const baseHi = hi + pad;
  baseBounds.current = { lo: baseLo, hi: baseHi };
  const span = (baseHi - baseLo) / Math.max(0.01, yZoom);
  const center = (baseLo + baseHi) / 2 + yPan;
  yRange.current = { lo: center - span / 2, hi: center + span / 2 };
  const yOf = (v: number) => {
    const { lo: a, hi: b } = yRange.current;
    return size.h - 14 - ((v - a) / (b - a)) * (size.h - 28);
  };
  const vOf = (y: number) => {
    const { lo: a, hi: b } = yRange.current;
    return a + ((size.h - 14 - y) / (size.h - 28)) * (b - a);
  };

  const scalarOf = (s: Series) => (k: Keyframe, d: number) => {
    if (s.spatial && mode === 'speed') return 0;
    return typeof k.v === 'number' ? k.v : (k.v as number[])[d] ?? 0;
  };

  /** handle screen positions for keyframe idx of series s */
  const handles = (s: Series, idx: number, dim: number): { side: 'in' | 'out'; x: number; y: number; ax: number; ay: number }[] => {
    const kfs = s.prop.keyframes;
    const out: { side: 'in' | 'out'; x: number; y: number; ax: number; ay: number }[] = [];
    const k = kfs[idx];
    const ct = toCompTime(s.layer, k.t);
    const sf = Math.abs(stretchFactor(s.layer));
    if (mode === 'value') {
      if (s.spatial) return out;
      const sc = scalarOf(s);
      if (idx < kfs.length - 1 && k.outType !== 'hold') {
        const n = kfs[idx + 1];
        const dt = toCompTime(s.layer, n.t) - ct;
        const c = segmentControls(kfs, idx, dim, sc(k, dim), sc(n, dim), sc);
        out.push({ side: 'out', x: tm.x(ct + c.x1 * dt), y: yOf(c.y1), ax: tm.x(ct), ay: yOf(sc(k, dim)) });
      }
      if (idx > 0 && kfs[idx - 1].outType !== 'hold') {
        const p = kfs[idx - 1];
        const pt = toCompTime(s.layer, p.t);
        const dt = ct - pt;
        const c = segmentControls(kfs, idx - 1, dim, sc(p, dim), sc(k, dim), sc);
        out.push({ side: 'in', x: tm.x(pt + c.x2 * dt), y: yOf(c.y2), ax: tm.x(ct), ay: yOf(sc(k, dim)) });
      }
      return out;
    }
    // speed graph
    const easeOf = (list: { speed: number; influence: number }[]) => list[dim] ?? list[0] ?? { speed: 0, influence: 1 / 3 };
    if (idx < kfs.length - 1 && k.outType !== 'hold') {
      const n = kfs[idx + 1];
      const dt = toCompTime(s.layer, n.t) - ct;
      const e = k.outType === 'bezier' || k.outType === 'continuous' ? easeOf(k.easeOut) : { speed: speedAtT(s, ct + 1e-4, dim) * sf, influence: 1 / 6 };
      out.push({ side: 'out', x: tm.x(ct + e.influence * dt), y: yOf(e.speed / sf), ax: tm.x(ct), ay: yOf(e.speed / sf) });
    }
    if (idx > 0 && kfs[idx - 1].outType !== 'hold') {
      const p = kfs[idx - 1];
      const dt = ct - toCompTime(s.layer, p.t);
      const e = k.inType === 'bezier' || k.inType === 'continuous' ? easeOf(k.easeIn) : { speed: speedAtT(s, ct - 1e-4, dim) * sf, influence: 1 / 6 };
      out.push({ side: 'in', x: tm.x(ct - e.influence * dt), y: yOf(e.speed / sf), ax: tm.x(ct), ay: yOf(e.speed / sf) });
    }
    return out;
  };

  const kfPoint = (s: Series, k: Keyframe, dim: number, side: 'in' | 'out' = 'out'): [number, number] => {
    const ct = toCompTime(s.layer, k.t);
    if (mode === 'value') return [tm.x(ct), yOf(valueAt(s, ct, dim))];
    return [tm.x(ct), yOf(speedAtT(s, ct + (side === 'out' ? 1e-4 : -1e-4), dim))];
  };

  // ── draw ──
  const draw = () => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = size.w * dpr;
    c.height = size.h * dpr;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    ctx.fillStyle = '#0d0f14';
    ctx.fillRect(0, 0, size.w, size.h);
    // horizontal grid
    const { lo: a, hi: b } = yRange.current;
    const span = b - a;
    const mag = Math.pow(10, Math.floor(Math.log10(span / 5)));
    const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => span / s <= 8) ?? mag * 10;
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textBaseline = 'middle';
    for (let v = Math.ceil(a / step) * step; v <= b; v += step) {
      const y = Math.round(yOf(v)) + 0.5;
      ctx.strokeStyle = Math.abs(v) < step * 1e-6 ? '#2e3646' : '#1a1f29';
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(size.w, y);
      ctx.stroke();
      ctx.fillStyle = '#5b6474';
      ctx.fillText(Number(v.toFixed(4)).toString(), 4, y - 6);
    }
    // vertical second lines
    ctx.strokeStyle = '#171b24';
    for (let t = Math.ceil(tA); t <= tB; t += 1) {
      const x = Math.round(tm.x(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, size.h);
      ctx.stroke();
    }
    if (!series.length) {
      ctx.fillStyle = '#5b6474';
      ctx.font = '12px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Select animated properties (or keyframes) to see their curves', size.w / 2, size.h / 2);
      ctx.textAlign = 'left';
      return;
    }
    // curves
    series.forEach((s, si) => {
      const dims = curveDims(s);
      for (let d = 0; d < dims; d++) {
        const col = dims === 1 ? (series.length > 1 ? DIM_COLORS[si % 4] : ONE_COLOR) : DIM_COLORS[d];
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.6;
        ctx.shadowColor = col + '66';
        ctx.shadowBlur = 6;
        ctx.beginPath();
        const kfs = s.prop.keyframes;
        for (let x = 0; x <= size.w; x += 2) {
          const ct = tm.t(x);
          let v = sample(s, ct, d);
          // speed graph is discontinuous at hold keyframes
          if (mode === 'speed') {
            const lt = toLayerTime(s.layer, ct);
            const seg = kfs.findIndex((k, i) => i < kfs.length - 1 && lt >= k.t && lt < kfs[i + 1].t);
            if (seg >= 0 && kfs[seg].outType === 'hold') v = 0;
          }
          const y = yOf(v);
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
        // keyframes & handles
        kfs.forEach((k, idx) => {
          const key = keyOf({ layerId: s.layer.id, path: s.path, kfId: k.id });
          const sel = selKeys.includes(key);
          if (sel) {
            for (const h of handles(s, idx, d)) {
              ctx.strokeStyle = col + 'aa';
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.moveTo(h.ax, h.ay);
              ctx.lineTo(h.x, h.y);
              ctx.stroke();
              const hv = hover.current?.kind === 'handle' && hover.current.k.id === k.id && hover.current.side === h.side && hover.current.dim === d;
              ctx.fillStyle = hv ? '#fff' : '#0d0f14';
              ctx.strokeStyle = col;
              ctx.beginPath();
              ctx.arc(h.x, h.y, hv ? 5 : 4, 0, Math.PI * 2);
              ctx.fill();
              ctx.stroke();
            }
          }
          const sides: ('in' | 'out')[] = mode === 'speed' ? ['in', 'out'] : ['out'];
          for (const side of sides) {
            if (mode === 'speed' && ((side === 'in' && idx === 0) || (side === 'out' && idx === kfs.length - 1))) continue;
            const [x, y] = kfPoint(s, k, d, side);
            const hv = hover.current?.kind === 'kf' && hover.current.k.id === k.id && hover.current.dim === d;
            ctx.fillStyle = sel ? '#ffc46b' : hv ? '#fff' : '#d8dee9';
            ctx.strokeStyle = '#000a';
            ctx.lineWidth = 1;
            drawKeyframeMarker(ctx, x, y, kfMarkerType(k, side));
          }
        });
      }
    });
    // legend
    let ly = 10;
    ctx.font = '600 10.5px Inter, sans-serif';
    ctx.textBaseline = 'middle';
    series.slice(0, 6).forEach((s, si) => {
      const dims = curveDims(s);
      const col = dims === 1 ? (series.length > 1 ? DIM_COLORS[si % 4] : ONE_COLOR) : '#c9d1de';
      ctx.fillStyle = col;
      const label = mode === 'speed' && s.spatial ? `${s.label} (px/s)` : s.label;
      const w = ctx.measureText(label).width;
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = '#12151cdd';
      ctx.fillRect(size.w - w - 22, ly - 8, w + 16, 16);
      ctx.globalAlpha = 1;
      ctx.fillStyle = col;
      ctx.fillText(label, size.w - w - 14, ly);
      ly += 18;
    });
    // CTI
    const cx = tm.x(getTime(comp.id));
    ctx.strokeStyle = '#ff9b3f';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(cx) + 0.5, 0);
    ctx.lineTo(Math.round(cx) + 0.5, size.h);
    ctx.stroke();
  };

  useEffect(draw);
  useEffect(() => timeStore.subscribe(draw));

  // ── hit testing ──
  const hitTest = (x: number, y: number): Hit | null => {
    for (const s of series) {
      for (let d = 0; d < curveDims(s); d++) {
        const kfs = s.prop.keyframes;
        for (let idx = 0; idx < kfs.length; idx++) {
          const k = kfs[idx];
          const key = keyOf({ layerId: s.layer.id, path: s.path, kfId: k.id });
          if (selKeys.includes(key)) {
            for (const h of handles(s, idx, d)) if (Math.hypot(h.x - x, h.y - y) < 7) return { kind: 'handle', s, k, idx, side: h.side, dim: d };
          }
        }
        for (const k of kfs) {
          for (const side of ['out', 'in'] as const) {
            const [px, py] = kfPoint(s, k, d, side);
            if (Math.abs(px - x) < 6 && Math.abs(py - y) < 6) return { kind: 'kf', s, k, dim: d };
          }
        }
      }
    }
    return null;
  };

  const local = (e: { clientX: number; clientY: number }) => {
    const r = wrap.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.button === 2) return;
    const [x, y] = local(e);
    const h = hitTest(x, y);
    if (e.button === 1 || (e.button === 0 && e.altKey && !h)) {
      e.preventDefault();
      const y0 = e.clientY;
      const pan0 = yPan;
      const { lo: a, hi: b } = yRange.current;
      const move = (ev: PointerEvent) => {
        const dy = ev.clientY - y0;
        const dv = ((b - a) / (size.h - 28)) * dy;
        setYPan(pan0 + dv);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      return;
    }
    if (h?.kind === 'kf') {
      const key = keyOf({ layerId: h.s.layer.id, path: h.s.path, kfId: h.k.id });
      const s = getApp();
      let keys = s.selKeys;
      if (e.shiftKey) keys = keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key];
      else if (!keys.includes(key)) keys = [key];
      setApp({ selKeys: keys });
      const orig = A.keyframeCompTimes(comp.id, keys);
      const grabbed = orig.get(key) ?? 0;
      const v0 = h.k.v;
      const x0 = e.clientX, y0 = e.clientY;
      let moved = false;
      const valueMode = mode === 'value';
      const move = (ev: PointerEvent) => {
        if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 3) return;
        if (!moved) {
          moved = true;
          beginTx();
        }
        const dx = ev.clientX - x0, dy = ev.clientY - y0;
        const lockAxis = ev.shiftKey ? (Math.abs(dx) > Math.abs(dy) ? 'x' : 'y') : null;
        if (lockAxis !== 'y') {
          const nt = snapToFrame(grabbed + dx / tm.pxPerSec, comp.frameRate);
          A.retimeKeyframes(comp.id, orig, nt - grabbed);
        }
        if (valueMode && lockAxis !== 'x') {
          const r = wrap.current!.getBoundingClientRect();
          const dv = vOf(ev.clientY - r.top) - vOf(y0 - r.top);
          if (typeof v0 === 'number') A.setKeyframeValue(comp.id, key, v0 + dv);
          else if (Array.isArray(v0)) {
            const nv = (v0 as number[]).slice();
            nv[h.dim] = (nv[h.dim] ?? 0) + dv;
            A.setKeyframeValue(comp.id, key, nv);
          }
        }
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (moved) endTx();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      return;
    }
    if (h?.kind === 'handle') {
      const key = keyOf({ layerId: h.s.layer.id, path: h.s.path, kfId: h.k.id });
      const kfs = h.s.prop.keyframes;
      const ct = toCompTime(h.s.layer, h.k.t);
      const sf = Math.abs(stretchFactor(h.s.layer));
      const other = h.side === 'out' ? kfs[h.idx + 1] : kfs[h.idx - 1];
      if (!other) return;
      const segDt = Math.abs(toCompTime(h.s.layer, other.t) - ct);
      const kv = typeof h.k.v === 'number' ? h.k.v : (h.k.v as number[])[h.dim] ?? 0;
      const easeDim = h.s.spatial ? 0 : h.dim;
      beginTx();
      const move = (ev: PointerEvent) => {
        const [mx, my] = local(ev);
        const t = tm.t(mx);
        if (mode === 'value') {
          const v = vOf(my);
          const dtc = h.side === 'out' ? Math.max(1e-4, t - ct) : Math.max(1e-4, ct - t);
          const influence = Math.min(1, Math.max(0.001, dtc / segDt));
          const speed = ((h.side === 'out' ? v - kv : kv - v) / dtc) * sf;
          A.setKeyframeEase(comp.id, key, h.side, easeDim, { speed, influence }, false);
        } else {
          const dtc = h.side === 'out' ? Math.max(1e-4, t - ct) : Math.max(1e-4, ct - t);
          const influence = Math.min(1, Math.max(0.001, dtc / segDt));
          const speed = vOf(my) * sf;
          A.setKeyframeEase(comp.id, key, h.side, easeDim, { speed, influence }, false);
        }
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        endTx();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      return;
    }
    // marquee
    if (!e.shiftKey) setApp({ selKeys: [] });
    const base = e.shiftKey ? getApp().selKeys : [];
    setMarquee({ x0: x, y0: y, x1: x, y1: y });
    const move = (ev: PointerEvent) => {
      const [mx, my] = local(ev);
      setMarquee({ x0: x, y0: y, x1: mx, y1: my });
      const xa = Math.min(x, mx), xb = Math.max(x, mx), ya = Math.min(y, my), yb = Math.max(y, my);
      const keys = new Set(base);
      for (const s of series) {
        for (let d = 0; d < curveDims(s); d++) {
          for (const k of s.prop.keyframes) {
            const [px, py] = kfPoint(s, k, d);
            if (px >= xa && px <= xb && py >= ya && py <= yb) keys.add(keyOf({ layerId: s.layer.id, path: s.path, kfId: k.id }));
          }
        }
      }
      setApp({ selKeys: [...keys] });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setMarquee(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      ref={wrap}
      className="tl-graph"
      onPointerDown={onDown}
      onPointerMove={(e) => {
        if (e.buttons) return;
        const [x, y] = local(e);
        const h = hitTest(x, y);
        const changed = JSON.stringify(h ? [h.kind, h.k.id, h.dim, (h as { side?: string }).side] : null) !== JSON.stringify(hover.current ? [hover.current.kind, hover.current.k.id, hover.current.dim, (hover.current as { side?: string }).side] : null);
        hover.current = h;
        (e.currentTarget as HTMLElement).style.cursor = h ? (h.kind === 'handle' ? 'grab' : 'pointer') : 'default';
        if (changed) draw();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (getApp().selKeys.length) openContextMenu(e.clientX, e.clientY, keyframeContextMenu());
      }}
      onWheel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const { lo: a, hi: b } = yRange.current;
        if (e.ctrlKey || e.metaKey || e.altKey) {
          const r = wrap.current?.getBoundingClientRect();
          if (!r) return;
          const my = e.clientY - r.top;
          const vMouse = vOf(my);
          const factor = Math.pow(1.002, -e.deltaY);
          const nextZoom = Math.min(50, Math.max(0.05, yZoom * factor));
          const nextSpan = (baseBounds.current.hi - baseBounds.current.lo) / nextZoom;
          const frac = (size.h - 14 - my) / (size.h - 28);
          const nextLo = vMouse - frac * nextSpan;
          const nextCenter = nextLo + nextSpan / 2;
          const baseCenter = (baseBounds.current.lo + baseBounds.current.hi) / 2;
          setYZoom(nextZoom);
          setYPan(nextCenter - baseCenter);
        } else {
          const dv = ((b - a) / (size.h - 28)) * e.deltaY * 0.5;
          setYPan((p) => p + dv);
        }
      }}
    >
      <canvas ref={canvas} style={{ width: size.w, height: size.h, display: 'block' }} />
      {marquee && (
        <div className="tl-marquee" style={{ left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }} />
      )}
      <div className="ge-tools" onPointerDown={(e) => e.stopPropagation()}>
        <button className="icon-btn" title="Convert to Hold" onClick={C.interpHold}><KeyframeIcon size={11} type="hold" /></button>
        <button className="icon-btn" title="Convert to Linear" onClick={C.interpLinear}><KeyframeIcon size={11} type="linear" /></button>
        <button className="icon-btn" title="Convert to Auto Bezier" onClick={C.interpAuto}><KeyframeIcon size={11} type="auto" /></button>
        <span className="ge-sep" />
        <button className="btn sm ghost" title="Easy Ease (F9)" onClick={C.easyEase}>Easy Ease</button>
        <button className="btn sm ghost" title="Easy Ease In (Shift+F9)" onClick={C.easeIn}>Ease In</button>
        <button className="btn sm ghost" title="Easy Ease Out (Ctrl+Shift+F9)" onClick={C.easeOut}>Ease Out</button>
        <span className="ge-sep" />
        <button
          className={`btn sm ${mode === 'speed' ? 'primary' : 'ghost'}`}
          title={mode === 'value' && series.some((s) => s.spatial) ? 'Switch to Speed Graph to edit easing handles on Position' : 'Switch between Value and Speed Graph'}
          onClick={() => setTimeline(comp.id, { graphMode: mode === 'speed' ? 'value' : 'speed' })}
        >
          {mode === 'speed' ? 'Speed Graph' : 'Value Graph'}
        </button>
        <button
          className="btn sm ghost"
          title="Fit all curves vertically and horizontally (F)"
          onClick={() => { setYPan(0); setYZoom(1); }}
        >
          Fit View
        </button>
      </div>
    </div>
  );
}
