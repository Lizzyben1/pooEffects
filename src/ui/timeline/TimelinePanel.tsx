// The Timeline: layer outline + switches on the left, time ruler / work area / RAM cache bar,
// layer duration bars and keyframes on the right (or the Graph Editor), virtualized rows.

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Search, Eye, ZoomIn, ZoomOut, Scan } from 'lucide-react';
import type { Composition, Layer } from '../../core/types';
import {
  beginTx, endTx, getApp, setApp, setTimeline, timelineOf, useActiveComp, useApp, keyOf, openContextMenu,
} from '../../state/store';
import { getTime, setTime, timeStore, useThrottledTime } from '../../state/time';
import { FrameEval, toCompTime, layerSpan } from '../../core/evaluate';
import { exactFps, frameDuration, snapToFrame, formatTime } from '../../core/time';
import * as A from '../../state/actions';
import { buildRows, ROW_H, type Row } from './rows';
import { ExprLeft, FieldLeft, GroupLeft, LayerLeft, PropLeft } from './TimelineLeft';
import { KeyframeIcon, GraphIcon, ShyIcon, MotionBlurIcon } from '../icons';
import { forEachAnimProp, getAt } from '../../core/props';
import { LABEL_COLORS } from '../../math/color';
import { cachedFrames } from '../../state/cache';
import { cfgKey, getViewParams } from '../../state/engine';
import { keyframeContextMenu, layerContextMenu } from '../menus/layerMenu';
import { TimeDisplay } from '../controls/TimeDisplay';
import { GraphEditor } from './GraphEditor';
import { scrubAt } from '../../audio/engine';
import { useTracking, findTracker } from '../../state/tracking';
import { rotoEffectOf } from '../../state/roto';

export function TimelinePanel() {
  const comp = useActiveComp();
  if (!comp) return <div className="empty"><div><div className="big">No composition</div>Open or create a composition to see its layers here.</div></div>;
  return <Timeline key={comp.id} comp={comp} />;
}

export interface TimeMap {
  scrollTime: number;
  pxPerSec: number;
  x: (t: number) => number;
  t: (x: number) => number;
}

function kfType(k: { inType: string; outType: string }): string {
  if (k.outType === 'hold') return 'hold';
  if (k.inType === 'auto' && k.outType === 'auto') return 'auto';
  if (k.inType === 'linear' && k.outType === 'linear') return 'linear';
  return 'bezier';
}

const layerKeyTimes = new WeakMap<Layer, number[]>();
function summaryTimes(layer: Layer, prefix?: string): number[] {
  if (!prefix) {
    const hit = layerKeyTimes.get(layer);
    if (hit) return hit;
  }
  const out: number[] = [];
  forEachAnimProp(prefix ? getAt(layer, prefix) : layer, prefix ?? '', (p) => {
    for (const k of p.keyframes) out.push(toCompTime(layer, k.t));
  });
  const uniq = [...new Set(out.map((t) => Math.round(t * 1000) / 1000))];
  if (!prefix) layerKeyTimes.set(layer, uniq);
  return uniq;
}

function Timeline({ comp }: { comp: Composition }) {
  const tl = useApp((s) => timelineOf(s, comp.id));
  const project = useApp((s) => s.project);
  const expanded = useApp((s) => s.expanded);
  const reveal = useApp((s) => s.reveal);
  const selLayers = useApp((s) => s.selLayers);
  const selKeys = useApp((s) => s.selKeys);
  const [search, setSearch] = useState('');
  const t = useThrottledTime(comp.id, 10);
  const rows = useMemo(
    () => buildRows(project, comp, expanded, reveal, reveal.kind === 'none' ? [] : selLayers, search),
    [project, comp, expanded, reveal, reveal.kind === 'none' ? null : selLayers, search],
  );
  const offsets = useMemo(() => {
    const o = new Float64Array(rows.length + 1);
    for (let i = 0; i < rows.length; i++) o[i + 1] = o[i] + rows[i].h;
    return o;
  }, [rows]);
  const totalH = offsets[rows.length] ?? 0;
  const scrollRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(400);
  const [trackW, setTrackW] = useState(800);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [dropRow, setDropRow] = useState<number | null>(null);
  const fe = useMemo(() => new FrameEval(project, comp, t, 0, null), [project, comp, t]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const r = rightRef.current;
    if (!el || !r) return;
    const ro = new ResizeObserver(() => {
      setViewH(el.clientHeight);
      setTrackW(r.clientWidth);
    });
    ro.observe(el);
    ro.observe(r);
    setViewH(el.clientHeight);
    setTrackW(r.clientWidth);
    return () => ro.disconnect();
  }, []);

  // initial zoom: fit comp duration
  useEffect(() => {
    if (trackW > 50 && !getApp().timelines[comp.id]?.pxPerSec) setTimeline(comp.id, { pxPerSec: (trackW - 20) / comp.duration, scrollTime: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackW > 50]);

  const pxPerSec = Math.max(1, tl.pxPerSec);
  const maxScroll = Math.max(0, comp.duration - trackW / pxPerSec);
  const scrollTime = Math.max(0, Math.min(maxScroll, tl.scrollTime));
  const tm: TimeMap = { scrollTime, pxPerSec, x: (tt) => (tt - scrollTime) * pxPerSec, t: (x) => scrollTime + x / pxPerSec };

  // visible rows
  let start = 0;
  {
    let lo = 0, hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid + 1] <= scrollTop) lo = mid + 1; else hi = mid;
    }
    start = lo;
  }
  let end = start;
  while (end < rows.length && offsets[end] < scrollTop + viewH + 40) end++;

  const zoomAround = (factor: number, atX: number) => {
    const tt = tm.t(atX);
    const nz = Math.max(2, Math.min(4000, pxPerSec * factor));
    setTimeline(comp.id, { pxPerSec: nz, scrollTime: Math.max(0, tt - atX / nz) });
  };

  // ── right-side interactions ──
  const localRight = (e: { clientX: number; clientY: number }) => {
    const r = rightRef.current!.getBoundingClientRect();
    const sr = scrollRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - sr.top + scrollRef.current!.scrollTop };
  };
  const rowAtY = (y: number) => {
    let lo = 0, hi = rows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= y) lo = mid; else hi = mid - 1;
    }
    return rows[lo];
  };

  const snapTimes = (exclude: Set<string>): number[] => {
    const out = [getTime(comp.id), comp.workArea[0], comp.workArea[1], ...comp.markers.map((m) => m.time)];
    for (const l of comp.layers) {
      out.push(l.inPoint, l.outPoint);
      forEachAnimProp(l, '', (p, path) => {
        for (const k of p.keyframes) if (!exclude.has(keyOf({ layerId: l.id, path, kfId: k.id }))) out.push(toCompTime(l, k.t));
      });
    }
    return out;
  };

  const onRightDown = (e: React.PointerEvent) => {
    if (e.button === 2) return;
    const { x, y } = localRight(e);
    const target = e.target as HTMLElement;
    const kfEl = target.closest('[data-kf]') as HTMLElement | null;
    const barEl = target.closest('[data-bar]') as HTMLElement | null;
    if (kfEl) {
      const key = kfEl.dataset.kf!;
      const s = getApp();
      let keys = s.selKeys;
      if (e.shiftKey || e.metaKey || e.ctrlKey) keys = keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key];
      else if (!keys.includes(key)) keys = [key];
      setApp({ selKeys: keys, selLayers: [...new Set([...(e.shiftKey ? s.selLayers : []), key.split('|')[0]])] });
      if (e.altKey) return;
      const orig = A.keyframeCompTimes(comp.id, keys);
      const grabbed = orig.get(key) ?? 0;
      const x0 = e.clientX;
      let moved = false;
      const snaps = snapTimes(new Set(keys));
      const move = (ev: PointerEvent) => {
        if (!moved && Math.abs(ev.clientX - x0) < 3) return;
        if (!moved) {
          moved = true;
          beginTx();
        }
        let nt = grabbed + (ev.clientX - x0) / pxPerSec;
        nt = snapToFrame(nt, comp.frameRate);
        if (ev.shiftKey) {
          const near = snaps.reduce((b, s2) => (Math.abs(s2 - nt) < Math.abs(b - nt) ? s2 : b), Infinity);
          if (Math.abs(near - nt) * pxPerSec < 10) nt = near;
        }
        A.retimeKeyframes(comp.id, orig, nt - grabbed);
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
    if (barEl) {
      const layerId = barEl.dataset.layer!;
      const part = barEl.dataset.bar as 'move' | 'in' | 'out';
      const s = getApp();
      if (!s.selLayers.includes(layerId)) A.selectLayers([layerId], e.shiftKey ? 'add' : 'set');
      const ids = part === 'move' ? getApp().selLayers : [layerId];
      const startState = new Map(comp.layers.filter((l) => ids.includes(l.id) && !l.locked).map((l) => [l.id, { s: l.startTime, i: l.inPoint, o: l.outPoint }]));
      const x0 = e.clientX;
      const fd = frameDuration(comp.frameRate);
      let moved = false;
      const snaps = snapTimes(new Set());
      const move = (ev: PointerEvent) => {
        if (!moved && Math.abs(ev.clientX - x0) < 3) return;
        if (!moved) {
          moved = true;
          beginTx();
        }
        let dt = (ev.clientX - x0) / pxPerSec;
        const first = startState.get(layerId)!;
        if (!first) return;
        const anchorT = part === 'out' ? first.o : first.i;
        let nt = snapToFrame(anchorT + dt, comp.frameRate);
        if (ev.shiftKey) {
          const near = snaps.reduce((b, s2) => (Math.abs(s2 - nt) < Math.abs(b - nt) ? s2 : b), Infinity);
          if (Math.abs(near - nt) * pxPerSec < 10) nt = near;
        }
        dt = nt - anchorT;
        for (const [id, st] of startState) {
          const l = comp.layers.find((q) => q.id === id)!;
          if (part === 'move') A.setLayerFields(comp.id, [id], { startTime: st.s + dt, inPoint: st.i + dt, outPoint: st.o + dt });
          else {
            const k = l.stretch / 100;
            const f = l.source?.footageId ? project.footage[l.source.footageId] : undefined;
            const srcDur = f && f.duration > 0 && !l.timeRemapEnabled ? f.duration * Math.abs(k) * Math.max(1, f.interpret.loop) : Infinity;
            const lo = Number.isFinite(srcDur) ? Math.min(st.s, st.s + srcDur * Math.sign(k)) : -Infinity;
            const hi = Number.isFinite(srcDur) ? Math.max(st.s, st.s + srcDur * Math.sign(k)) : Infinity;
            if (part === 'in') A.setLayerFields(comp.id, [id], { inPoint: Math.max(lo, Math.min(st.o - fd, st.i + dt)) });
            else A.setLayerFields(comp.id, [id], { outPoint: Math.min(hi, Math.max(st.i + fd, st.o + dt)) });
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
    // empty area: marquee keyframe selection
    const row = rowAtY(y);
    if (!e.shiftKey) setApp({ selKeys: [] });
    if (row && row.kind === 'layer' && !e.shiftKey) A.selectLayers([row.layer.id]);
    const x0 = x, y0 = y;
    const base = e.shiftKey ? getApp().selKeys : [];
    setMarquee({ x0, y0, x1: x0, y1: y0 });
    const move = (ev: PointerEvent) => {
      const p = localRight(ev);
      setMarquee({ x0, y0, x1: p.x, y1: p.y });
      const t0 = tm.t(Math.min(x0, p.x)), t1 = tm.t(Math.max(x0, p.x));
      const ya = Math.min(y0, p.y), yb = Math.max(y0, p.y);
      const keys = new Set(base);
      rows.forEach((r, i) => {
        if (r.kind !== 'prop') return;
        const top = offsets[i], bot = offsets[i + 1];
        if (bot < ya || top > yb) return;
        for (const k of r.prop.keyframes) {
          const ct = toCompTime(r.layer, k.t);
          if (ct >= t0 && ct <= t1) keys.add(keyOf({ layerId: r.layer.id, path: r.path, kfId: k.id }));
        }
      });
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

  // ── layer reorder & pick whip ──
  const onLayerPointerDown = (e: React.PointerEvent, layer: Layer) => {
    if (e.button !== 0) return;
    const s = getApp();
    if (e.shiftKey && s.selLayers.length) {
      const idx = comp.layers.findIndex((l) => l.id === layer.id);
      const anchor = comp.layers.findIndex((l) => l.id === s.selLayers[s.selLayers.length - 1]);
      const [a, b] = [Math.min(idx, anchor), Math.max(idx, anchor)];
      A.selectLayers(comp.layers.slice(a, b + 1).map((l) => l.id), 'add');
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      A.selectLayers([layer.id], 'toggle');
      return;
    }
    if (!s.selLayers.includes(layer.id)) A.selectLayers([layer.id]);
    setApp({ selProps: [], selKeys: [] });
    const y0 = e.clientY;
    let dragging = false;
    let dropIndex = -1;
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.abs(ev.clientY - y0) < 5) return;
      dragging = true;
      const { y } = localRight(ev);
      const r = rowAtY(y);
      const ri = rows.indexOf(r);
      if (r && r.kind === 'layer') {
        dropIndex = r.index + (y - offsets[ri] > ROW_H / 2 ? 1 : 0);
        setDropRow(ri);
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDropRow(null);
      if (dragging && dropIndex >= 0) A.reorderLayers(comp.id, getApp().selLayers, dropIndex);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onPickWhip = (_e: React.PointerEvent, layer: Layer) => {
    let target: Layer | null = null;
    const move = (ev: PointerEvent) => {
      const { y } = localRight(ev);
      const r = rowAtY(y);
      target = r && r.kind === 'layer' && r.layer.id !== layer.id ? r.layer : null;
      setDropRow(target ? rows.indexOf(r) : null);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDropRow(null);
      if (target) A.setParent(comp.id, layer.id, target.id);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const lw = tl.leftWidth;
  // zoom slider: 0 = whole comp fits, 1 = 400× closer
  const fitPps = Math.max(1, trackW - 20) / comp.duration;
  const zoomNorm = Math.max(0, Math.min(1, Math.log(pxPerSec / fitPps) / Math.log(400))) || 0;
  return (
    <div className="timeline" style={{ ['--lw' as string]: `${lw}px` }}>
      <div className="tl-top">
        <div className="tl-top-left">
          <TimeDisplay comp={comp} big />
          <span className="tl-frames mono">{formatTime(t, comp.frameRate, comp.dropFrame, 'frames')} <span>({comp.frameRate} fps)</span></span>
          <div className="search tl-search">
            <Search size={12} />
            <input placeholder="Search layers" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          </div>
          <div className="tl-toggles">
            <button className={`icon-btn${comp.hideShyLayers ? ' active' : ''}`} title="Hide Shy Layers" onClick={() => A.updateComp(comp.id, { hideShyLayers: !comp.hideShyLayers })}><ShyIcon size={14} /></button>
            <button className={`icon-btn${comp.motionBlur ? ' active' : ''}`} title="Enable Motion Blur for all layers with the switch set" onClick={() => A.updateComp(comp.id, { motionBlur: !comp.motionBlur })}><MotionBlurIcon size={14} /></button>
            <button className={`icon-btn${tl.graphEditor ? ' active' : ''}`} title="Graph Editor (Shift+F3)" onClick={() => setTimeline(comp.id, { graphEditor: !tl.graphEditor })}><GraphIcon size={14} /></button>
          </div>
        </div>
        <div className="tl-top-right">
          <Navigator comp={comp} tm={tm} trackW={trackW} />
          <Ruler comp={comp} tm={tm} trackW={trackW} />
          <TrackStrip comp={comp} tm={tm} trackW={trackW} />
        </div>
      </div>
      <div className="tl-colhead">
        <div className="tl-colhead-left">
          <span className="ch-av" title="A/V Features"><Eye size={11} /></span>
          <span className="ch-label" />
          <span className="ch-idx">#</span>
          <span className="ch-name">Layer Name</span>
          <span className="ch-sw" onClick={() => setTimeline(comp.id, { showModes: !tl.showModes })} title="Toggle Switches / Modes (F4)">
            {tl.showModes ? 'Mode · TrkMat' : 'Switches'}
          </span>
          <span className="ch-parent">Parent & Link</span>
        </div>
        <div className="tl-colhead-right" />
      </div>
      <div className="tl-body">
        <div
          className="tl-splitter"
          onPointerDown={(e) => {
            const x0 = e.clientX, w0 = lw;
            const move = (ev: PointerEvent) => setTimeline(comp.id, { leftWidth: Math.max(320, Math.min(900, w0 + ev.clientX - x0)) });
            const up = () => {
              window.removeEventListener('pointermove', move);
              window.removeEventListener('pointerup', up);
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up);
          }}
        />
        <div
          ref={scrollRef}
          className="tl-scroll"
          onScroll={(e) => setScrollTop((e.target as HTMLElement).scrollTop)}
          onWheel={(e) => {
            if (e.ctrlKey || e.metaKey || e.altKey) {
              e.preventDefault();
              const r = rightRef.current!.getBoundingClientRect();
              zoomAround(Math.pow(1.002, -e.deltaY), Math.max(0, e.clientX - r.left));
            } else if (e.shiftKey) {
              setTimeline(comp.id, { scrollTime: Math.max(0, Math.min(maxScroll, scrollTime + (e.deltaY || e.deltaX) / pxPerSec)) });
            }
          }}
        >
          <div
            className="tl-inner"
            style={{ height: Math.max(totalH + 60, viewH) }}
            onPointerDown={(e) => {
              // rows are click-through except their left cells, keyframes and layer bars; everything on the
              // right side (bars, keyframes, empty track space) is handled here
              if (tl.graphEditor || (e.target as HTMLElement).closest('.tl-left')) return;
              if (e.clientX < rightRef.current!.getBoundingClientRect().left) {
                if (e.button === 0) A.deselectAll();
                return;
              }
              onRightDown(e);
            }}
            onContextMenu={(e) => {
              const target = e.target as HTMLElement;
              if (tl.graphEditor || target.closest('.tl-left')) return;
              e.preventDefault();
              const kf = target.closest('[data-kf]') as HTMLElement | null;
              if (kf) {
                if (!getApp().selKeys.includes(kf.dataset.kf!)) setApp({ selKeys: [kf.dataset.kf!] });
                openContextMenu(e.clientX, e.clientY, keyframeContextMenu());
                return;
              }
              const bar = target.closest('[data-layer]') as HTMLElement | null;
              if (bar) {
                if (!getApp().selLayers.includes(bar.dataset.layer!)) A.selectLayers([bar.dataset.layer!]);
                openContextMenu(e.clientX, e.clientY, layerContextMenu(comp.id, getApp().selLayers));
              }
            }}
          >
            {rows.slice(start, end).map((r, k) => {
              const i = start + k;
              return (
                <div key={r.key} className={`tl-row k-${r.kind}${r.kind === 'layer' && selLayers.includes(r.layer.id) ? ' sel' : ''}`} style={{ top: offsets[i], height: r.h }}>
                  <LeftCell row={r} comp={comp} fe={fe} t={t} showModes={tl.showModes} selected={r.kind === 'layer' && selLayers.includes(r.layer.id)} onLayerPointerDown={onLayerPointerDown} onPickWhip={onPickWhip} dropTarget={dropRow === i} />
                  {!tl.graphEditor && <TrackCell row={r} tm={tm} trackW={trackW} selKeys={selKeys} />}
                </div>
              );
            })}
            <div ref={rightRef} className="tl-right-hit" style={{ height: Math.max(totalH + 60, viewH), visibility: tl.graphEditor ? 'hidden' : undefined }} />
            {marquee && (
              <div className="tl-marquee" style={{ left: `calc(var(--lw) + ${Math.min(marquee.x0, marquee.x1)}px)`, top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }} />
            )}
            {!rows.length && (
              <div className="tl-empty">
                Drop footage here, or add layers from <b>Layer ▸ New</b>
              </div>
            )}
          </div>
        </div>
        {tl.graphEditor && <GraphEditor comp={comp} tm={tm} rows={rows} />}
        <Playhead comp={comp} tm={tm} trackW={trackW} />
      </div>
      <div className="tl-footer">
        <span className="tl-hint">
          {selKeys.length ? `${selKeys.length} keyframe${selKeys.length > 1 ? 's' : ''} selected` : selLayers.length ? `${selLayers.length} layer${selLayers.length > 1 ? 's' : ''} selected` : `${comp.layers.length} layers`}
        </span>
        <div className="grow" />
        {tl.graphEditor && (
          <div className="ge-mode">
            <button className={`btn sm${tl.graphMode === 'value' ? ' primary' : ' ghost'}`} onClick={() => setTimeline(comp.id, { graphMode: 'value' })}>Value Graph</button>
            <button className={`btn sm${tl.graphMode === 'speed' ? ' primary' : ' ghost'}`} onClick={() => setTimeline(comp.id, { graphMode: 'speed' })}>Speed Graph</button>
          </div>
        )}
        <button className="icon-btn" title="Zoom to fit comp" onClick={() => setTimeline(comp.id, { pxPerSec: fitPps, scrollTime: 0 })}><Scan size={13} /></button>
        <button className="icon-btn" title="Zoom out" onClick={() => zoomAround(1 / 1.5, trackW / 2)}><ZoomOut size={13} /></button>
        <input
          type="range"
          className="slider tl-zoom"
          min={0}
          max={1}
          step={0.001}
          value={zoomNorm}
          style={{ ['--pct' as string]: `${zoomNorm * 100}%` }}
          onChange={(e) => {
            const base = fitPps;
            const nz = base * Math.pow(400, Number(e.target.value));
            const ct = getTime(comp.id);
            const cx = tm.x(ct);
            setTimeline(comp.id, { pxPerSec: nz, scrollTime: Math.max(0, ct - Math.max(0, Math.min(trackW, cx)) / nz) });
          }}
        />
        <button className="icon-btn" title="Zoom in" onClick={() => zoomAround(1.5, tm.x(getTime(comp.id)))}><ZoomIn size={13} /></button>
      </div>
    </div>
  );
}

function LeftCell(props: { row: Row; comp: Composition; fe: FrameEval; t: number; showModes: boolean; selected: boolean; onLayerPointerDown: (e: React.PointerEvent, l: Layer) => void; onPickWhip: (e: React.PointerEvent, l: Layer) => void; dropTarget: boolean }) {
  const { row } = props;
  switch (row.kind) {
    case 'layer': return <LayerLeft {...props} />;
    case 'prop': return <PropLeft row={row} comp={props.comp} fe={props.fe} t={props.t} />;
    case 'group': return <GroupLeft row={row} comp={props.comp} />;
    case 'field': return <FieldLeft row={row} comp={props.comp} />;
    case 'expr': return <ExprLeft row={row} comp={props.comp} />;
  }
}

const TrackCell = memo(function TrackCell({ row, tm, trackW, selKeys }: { row: Row; tm: TimeMap; trackW: number; selKeys: string[] }) {
  const labelBars = useApp((s) => s.prefs.timelineLabelBars);
  const inView = (x: number) => x > -20 && x < trackW + 20;
  if (row.kind === 'layer') {
    const l = row.layer;
    const [a, b] = layerSpan(l);
    const x0 = tm.x(a), x1 = tm.x(b);
    const col = labelBars ? LABEL_COLORS[l.label]?.hex ?? '#556' : '#5d6880';
    const times = summaryTimes(l);
    return (
      <div className="tl-track">
        <div
          className={`tl-bar${l.locked ? ' locked' : ''}${!l.enabled ? ' disabled' : ''}`}
          data-layer={l.id}
          data-bar="move"
          style={{ left: x0, width: Math.max(2, x1 - x0), ['--bar' as string]: col }}
        >
          <span className="tl-bar-name">{l.name}</span>
          {times.filter((tt) => tt >= a && tt <= b).map((tt) => <span key={tt} className="tl-sum" style={{ left: tm.x(tt) - x0 }} />)}
          <span className="tl-trim in" data-layer={l.id} data-bar="in" />
          <span className="tl-trim out" data-layer={l.id} data-bar="out" />
        </div>
        {l.markers.map((m) => {
          const mx = tm.x(toCompTime(l, m.time));
          return inView(mx) ? <span key={m.id} className="tl-lmarker" style={{ left: mx }} title={m.comment} /> : null;
        })}
      </div>
    );
  }
  if (row.kind === 'prop') {
    const { layer, path, prop } = row;
    const kfs = prop.keyframes;
    if (!kfs.length) return <div className="tl-track" />;
    const xs = kfs.map((k) => tm.x(toCompTime(layer, k.t)));
    return (
      <div className="tl-track">
        {kfs.length > 1 && <span className="tl-kfline" style={{ left: Math.max(-10, Math.min(...xs)), width: Math.max(0, Math.min(trackW + 10, Math.max(...xs)) - Math.max(-10, Math.min(...xs))) }} />}
        {kfs.map((k, i) => {
          const x = xs[i];
          if (!inView(x)) return null;
          const key = keyOf({ layerId: layer.id, path, kfId: k.id });
          const sel = selKeys.includes(key);
          return (
            <span key={k.id} className={`tl-kf${sel ? ' sel' : ''}`} data-kf={key} style={{ left: x - 5 }} title={`${kfType(k)} · ${k.t.toFixed(3)}s`}>
              <KeyframeIcon size={10} type={kfType(k)} selected={sel} color={k.roving ? '#8899aa' : undefined} />
            </span>
          );
        })}
      </div>
    );
  }
  if (row.kind === 'group') {
    const prefix = row.key.slice(row.layer.id.length + 1);
    if (prefix.includes('|')) return <div className="tl-track" />;
    const times = summaryTimes(row.layer, prefix);
    return (
      <div className="tl-track">
        {times.map((tt) => {
          const x = tm.x(tt);
          return inView(x) ? <span key={tt} className="tl-sumkf" style={{ left: x - 3 }} /> : null;
        })}
      </div>
    );
  }
  return <div className="tl-track" />;
});

function Playhead({ comp, tm, trackW }: { comp: Composition; tm: TimeMap; trackW: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const tmRef = useRef(tm);
  tmRef.current = tm;
  useEffect(() => {
    const place = () => {
      const x = tmRef.current.x(getTime(comp.id));
      if (ref.current) {
        ref.current.style.transform = `translateX(${x}px)`;
        ref.current.style.display = x < -2 || x > trackW + 2 ? 'none' : '';
      }
    };
    place();
    return timeStore.subscribe(place);
  });
  return <div className="tl-playhead" ref={ref}><span className="tl-playhead-line" /></div>;
}

function scrubTo(comp: Composition, x: number, tm: TimeMap) {
  const t = Math.max(0, Math.min(comp.duration - frameDuration(comp.frameRate), snapToFrame(tm.t(x), comp.frameRate)));
  if (getTime(comp.id) !== t) {
    setTime(comp.id, t);
    if (getApp().prefs.audioScrub) scrubAt(getApp().project, comp, t);
  }
}

function Ruler({ comp, tm, trackW }: { comp: Composition; tm: TimeMap; trackW: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const cacheVersion = useApp((s) => s.cacheVersion);
  const settings = useApp((s) => s.project.settings);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const W = trackW, H = 34;
    c.width = W * dpr;
    c.height = H * dpr;
    c.style.width = `${W}px`;
    c.style.height = `${H}px`;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // ticks
    const fps = exactFps(comp.frameRate);
    const minPx = 70;
    const candidates = [1 / fps, 2 / fps, 5 / fps, 10 / fps, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    const step = candidates.find((s) => s * tm.pxPerSec >= minPx) ?? 600;
    const sub = step / 5;
    ctx.strokeStyle = '#3a4252';
    ctx.fillStyle = '#8a93a6';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textBaseline = 'top';
    const t0 = Math.floor(tm.scrollTime / sub) * sub;
    ctx.beginPath();
    for (let t = t0; tm.x(t) < W + 1; t += sub) {
      const x = Math.round(tm.x(t)) + 0.5;
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      ctx.moveTo(x, H);
      ctx.lineTo(x, H - (major ? 11 : 5));
      if (major && x >= -2) ctx.fillText(formatTime(t, comp.frameRate, comp.dropFrame, settings.timeDisplay).replace(/^00[:;]/, ''), x + 3, 13);
    }
    ctx.stroke();
    // work area
    const wa0 = tm.x(comp.workArea[0]), wa1 = tm.x(comp.workArea[1]);
    const g = ctx.createLinearGradient(0, 0, 0, 10);
    g.addColorStop(0, 'rgba(120,140,170,0.55)');
    g.addColorStop(1, 'rgba(90,105,130,0.45)');
    ctx.fillStyle = g;
    ctx.fillRect(wa0, 1, wa1 - wa0, 8);
    ctx.fillStyle = '#ffb565';
    ctx.fillRect(wa0 - 1, 0, 3, 10);
    ctx.fillRect(wa1 - 2, 0, 3, 10);
    // RAM cache (green)
    const vp = getViewParams();
    if (vp && vp.compId === comp.id) {
      const frames = cachedFrames(comp.id, cfgKey(vp));
      ctx.fillStyle = '#3ddc84';
      ctx.shadowColor = 'rgba(61,220,132,0.6)';
      ctx.shadowBlur = 4;
      const sorted = [...frames].sort((a, b) => a - b);
      let runStart = -1, prev = -2;
      const flush = (a: number, b: number) => {
        const x0 = tm.x(a / fps), x1 = tm.x((b + 1) / fps);
        if (x1 > 0 && x0 < W) ctx.fillRect(x0, 10, Math.max(1, x1 - x0), 2.5);
      };
      for (const f of sorted) {
        if (f !== prev + 1) {
          if (runStart >= 0) flush(runStart, prev);
          runStart = f;
        }
        prev = f;
      }
      if (runStart >= 0) flush(runStart, prev);
      ctx.shadowBlur = 0;
    }
    // comp markers
    for (const m of comp.markers) {
      const x = tm.x(m.time);
      ctx.fillStyle = LABEL_COLORS[m.label]?.hex ?? '#ffb565';
      ctx.beginPath();
      ctx.moveTo(x - 4, H - 10);
      ctx.lineTo(x + 4, H - 10);
      ctx.lineTo(x, H - 4);
      ctx.closePath();
      ctx.fill();
    }
  }, [comp, tm.pxPerSec, tm.scrollTime, trackW, cacheVersion, settings]);

  const onDown = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const wa0 = tm.x(comp.workArea[0]), wa1 = tm.x(comp.workArea[1]);
    if (y <= 10 && x >= wa0 - 5 && x <= wa1 + 5) {
      // work area drag
      const which = Math.abs(x - wa0) < 6 ? 'start' : Math.abs(x - wa1) < 6 ? 'end' : 'move';
      const s0 = comp.workArea[0], e0 = comp.workArea[1], x0 = e.clientX;
      beginTx();
      const move = (ev: PointerEvent) => {
        const dt = (ev.clientX - x0) / tm.pxPerSec;
        if (which === 'start') A.setWorkArea(comp.id, snapToFrame(s0 + dt, comp.frameRate));
        else if (which === 'end') A.setWorkArea(comp.id, undefined, snapToFrame(e0 + dt, comp.frameRate));
        else {
          const d = Math.max(-s0, Math.min(comp.duration - e0, snapToFrame(dt, comp.frameRate)));
          A.setWorkArea(comp.id, s0 + d, e0 + d);
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
    timeStore.setState({ scrubbing: true });
    scrubTo(comp, x, tm);
    const move = (ev: PointerEvent) => scrubTo(comp, ev.clientX - r.left, tm);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      timeStore.setState({ scrubbing: false });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <canvas
      ref={canvas}
      className="tl-ruler"
      onPointerDown={onDown}
      onDoubleClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        if (e.clientY - r.top <= 10) A.setWorkArea(comp.id, 0, comp.duration);
      }}
    />
  );
}

/** Tracking analysis strip: analysed frames coloured by confidence (or solve error), with a live head. */
function TrackStrip({ comp, tm, trackW }: { comp: Composition; tm: TimeMap; trackW: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const job = useTracking((s) => (s.job?.compId === comp.id ? s.job : null));
  const active = useTracking((s) => (s.active?.compId === comp.id ? s.active : null));
  const project = useApp((s) => s.project);
  const sel = useApp((s) => s.selLayers);
  const segs = useMemo(() => {
    const out: { t: number; c: number; kind: 'conf' | 'err' | 'roto' | 'user' }[] = [];
    const fps = exactFps(comp.frameRate);
    if (active) {
      const f = findTracker(project, comp.id, active.layerId, active.trackerId);
      if (f) {
        const byT = new Map<number, number>();
        for (const p of f.tracker.points) for (const k of p.confidence.keyframes) {
          const t = Math.round(toCompTime(f.layer, k.t) * fps);
          byT.set(t, Math.min(byT.get(t) ?? 100, k.v as number));
        }
        for (const [fr, c] of byT) out.push({ t: fr / fps, c, kind: 'conf' });
      }
    }
    for (const l of comp.layers) {
      if (!sel.includes(l.id)) continue;
      const ct = l.cameraTrack;
      if (ct?.solved) ct.frameError.forEach((e, i) => out.push({ t: toCompTime(l, ct.t0 + i * ct.dt), c: e < 0 ? 0 : Math.max(0, Math.min(100, 100 - (e - 0.4) * 60)), kind: 'err' }));
      const r = rotoEffectOf(l, project);
      if (r) {
        const user = new Set(r.info.prompts.map((p) => p.frame));
        for (const k of Object.keys(r.info.revs)) out.push({ t: toCompTime(l, Number(k) / r.info.fps), c: 100, kind: user.has(Number(k)) ? 'user' : 'roto' });
      }
    }
    if (job) for (const smp of job.samples) out.push({ t: smp.t, c: smp.c, kind: job.op === 'roto' ? 'roto' : 'conf' });
    return out;
  }, [comp, project, sel, active, job]);
  const visible = segs.length > 0 || !!job;
  useEffect(() => {
    const c = canvas.current;
    if (!c || !visible) return;
    const dpr = window.devicePixelRatio || 1;
    const W = trackW, H = 7;
    c.width = W * dpr;
    c.height = H * dpr;
    c.style.width = `${W}px`;
    c.style.height = `${H}px`;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.fillRect(0, 0, W, H);
    const fd = frameDuration(comp.frameRate);
    for (const sgm of segs) {
      const x0 = tm.x(sgm.t), x1 = tm.x(sgm.t + fd);
      if (x1 < 0 || x0 > W) continue;
      let col: string;
      if (sgm.kind === 'roto') col = 'rgba(255,79,163,0.75)';
      else if (sgm.kind === 'user') col = '#ff8fcb';
      else {
        const k = Math.max(0, Math.min(1, (sgm.c - 50) / 50));
        col = `rgb(${Math.round(255 - 175 * k)},${Math.round(80 + 150 * k)},${Math.round(90 + 20 * k)})`;
      }
      ctx.fillStyle = col;
      ctx.fillRect(x0, 1, Math.max(1, x1 - x0 - (x1 - x0 > 3 ? 0.5 : 0)), H - 2);
    }
    if (job && job.samples.length) {
      const last = job.samples[job.samples.length - 1];
      const x = tm.x(last.t + (job.direction > 0 ? fd : 0));
      ctx.shadowColor = 'rgba(255,255,255,0.9)';
      ctx.shadowBlur = 6;
      ctx.fillStyle = '#fff';
      ctx.fillRect(x - 1, 0, 2, H);
      ctx.shadowBlur = 0;
    }
  }, [segs, tm.pxPerSec, tm.scrollTime, trackW, comp.frameRate, job, visible, tm]);
  if (!visible) return null;
  return <canvas ref={canvas} className="tl-trackstrip" title="Tracking analysis — green = high confidence, red = low; pink = roto mattes" />;
}

function Navigator({ comp, tm, trackW }: { comp: Composition; tm: TimeMap; trackW: number }) {
  const W = trackW;
  const a = (tm.scrollTime / comp.duration) * W;
  const b = Math.min(W, ((tm.scrollTime + trackW / tm.pxPerSec) / comp.duration) * W);
  const drag = (e: React.PointerEvent, which: 'a' | 'b' | 'm') => {
    e.stopPropagation();
    const x0 = e.clientX;
    const st0 = tm.scrollTime, span0 = trackW / tm.pxPerSec;
    const move = (ev: PointerEvent) => {
      const dt = ((ev.clientX - x0) / W) * comp.duration;
      if (which === 'm') setTimeline(comp.id, { scrollTime: Math.max(0, Math.min(comp.duration - span0, st0 + dt)) });
      else if (which === 'a') {
        const ns = Math.max(0, Math.min(st0 + span0 - 0.05, st0 + dt));
        const span = st0 + span0 - ns;
        setTimeline(comp.id, { scrollTime: ns, pxPerSec: trackW / span });
      } else {
        const span = Math.max(0.05, Math.min(comp.duration - st0, span0 + dt));
        setTimeline(comp.id, { pxPerSec: trackW / span });
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className="tl-nav">
      <div className="tl-nav-range" style={{ left: a, width: Math.max(8, b - a) }} onPointerDown={(e) => drag(e, 'm')}>
        <span className="tl-nav-h l" onPointerDown={(e) => drag(e, 'a')} />
        <span className="tl-nav-h r" onPointerDown={(e) => drag(e, 'b')} />
      </div>
    </div>
  );
}

