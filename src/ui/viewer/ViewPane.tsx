// One viewport of the Composition viewer: renders frames from the worker (with cache), draws the
// interactive overlay and implements every viewer tool.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BezierPath, Composition, Layer, RGBA, Vec2 } from '../../core/types';
import type { ViewSpec } from '../../render/projection';
import {
  beginTx, endTx, getApp, setApp, setViewer, useApp, viewerOf, keyOf, openContextMenu, toast, cancelTx,
} from '../../state/store';
import { getTime, timeStore } from '../../state/time';
import { renderForView, setViewParams } from '../../state/engine';
import * as M from '../../math/mat4';
import {
  compPxRay, compToScreen, hitLayer, layerBounds, layerPointToScreen, layerQuad, makeViewCtx, rayPlane, screenToComp, viewForward, worldDeltaToParent,
  type PaneXform, type ViewCtx,
} from './geometry';
import { drawOverlay, hitHandle, type HandleHit, type OverlayState } from './overlay';
import {
  addLayer, addMask, addShapeItem, openComp, selectLayers, setKeyframeValue, setPropValue, setSourceText, setSpatialTangents, deselectAll,
} from '../../state/actions';
import { getProp } from '../../core/props';
import { keyframedValue } from '../../anim/interpolate';
import { FrameEval, toCompTime, toLayerTime } from '../../core/evaluate';
import { normalize } from '../../math/vec';
import { apply2d, invert2d, type Mat2d } from '../../shapes/path';
import {
  createCameraLayer, createEllipse, createFill, createGroup, createPathItem, createPolystar, createRect, createShapeLayer, createStroke, createTextLayer, ellipsePath, rectPath,
} from '../../core/factory';
import { polystarToPath } from '../../shapes/generators';
import { layerContextMenu } from '../menus/layerMenu';
import { customEye } from '../../render/projection';
import { camPointsInRect, drawTrackOverlay, featureCenterAt, hitTrack, screenToLayer, type TrackHit } from './trackOverlay';
import { createAtTrackPoints, editTrackPoint, findTracker, getTracking, isTrackable, setGroundPlane, setTracking, useTracking } from '../../state/tracking';
import { addRotoPoint, useRoto } from '../../state/roto';

interface Props {
  comp: Composition;
  index: number;
  view: ViewSpec;
  isActivePane: boolean;
}

const FILL_PALETTE: RGBA[] = [[1, 0.61, 0.25, 1], [0.31, 0.62, 1, 1], [0.24, 0.86, 0.52, 1], [1, 0.36, 0.42, 1], [0.71, 0.55, 1, 1], [1, 0.83, 0.3, 1]];
let paletteIdx = 0;

function checker(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const s = 10;
  ctx.fillStyle = '#2a2d34';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#3a3e47';
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  for (let yy = Math.floor(y / s) * s; yy < y + h; yy += s) {
    for (let xx = Math.floor(x / s) * s; xx < x + w; xx += s) {
      if (((xx / s + yy / s) & 1) === 0) ctx.fillRect(xx, yy, s, s);
    }
  }
  ctx.restore();
}

export function ViewPane({ comp, index, view, isActivePane }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const imgCanvas = useRef<HTMLCanvasElement>(null);
  const ovCanvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const viewer = useApp((s) => viewerOf(s, comp.id));
  const project = useApp((s) => s.project);
  const tool = useApp((s) => s.tool);
  const img = useRef<{ bmp: ImageBitmap | null; cached: boolean; time: number }>({ bmp: null, cached: false, time: -1 });
  const seq = useRef(0);
  const drawnSeq = useRef(0);
  const ov = useRef<OverlayState>({ hover: null, marquee: null, shapeDraft: null, pen: null, selectedVertex: null });
  const trackHover = useRef<TrackHit | null>(null);
  const trackMarquee = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const loupe = useRef<{ sx: number; sy: number } | null>(null);
  const [textEdit, setTextEdit] = useState<{ layerId: string; x: number; y: number; w: number; h: number; size: number } | null>(null);
  const spaceHeld = useRef(false);
  const renderPending = useRef(false);
  const lastRequestKey = useRef('');

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const fitZoom = size.w && size.h ? Math.min((size.w - 40) / comp.width, (size.h - 40) / comp.height) : 0.5;
  const zoom = viewer.zoom ?? Math.max(0.02, fitZoom);
  const xf: PaneXform = { cx: size.w / 2 + viewer.panX, cy: size.h / 2 + viewer.panY, zoom, compW: comp.width, compH: comp.height };
  const xfRef = useRef(xf);
  xfRef.current = xf;
  const resFactor = { auto: 0, full: 1, half: 0.5, third: 1 / 3, quarter: 0.25 }[viewer.resolution];
  const scale = resFactor === 0 ? Math.min(1, Math.max(0.05, zoom * dpr)) : resFactor;
  const quantScale = Math.min(1, Math.pow(2, Math.ceil(Math.log2(scale) * 4) / 4));
  const params = { compId: comp.id, scale: quantScale, motionBlur: viewer.motionBlur, draft: viewer.draft3D };
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const viewRef = useRef(view);
  viewRef.current = view;
  // async render callbacks must see the latest size / comp, not the ones captured when they were scheduled
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const compRef = useRef(comp);
  compRef.current = comp;

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // ── image drawing ──
  const paintImage = () => {
    const c = imgCanvas.current;
    const sz = sizeRef.current;
    const cp = compRef.current;
    if (!c || !sz.w) return;
    const W = Math.round(sz.w * dpr), H = Math.round(sz.h * dpr);
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, sz.w, sz.h);
    const x = xfRef.current;
    const tl = compToScreen(x, [0, 0]);
    const w = cp.width * x.zoom, h = cp.height * x.zoom;
    if (getApp().viewers[cp.id]?.transparency) checker(ctx, tl[0], tl[1], w, h);
    else {
      const bg = cp.bgColor;
      ctx.fillStyle = `rgb(${bg[0] * 255},${bg[1] * 255},${bg[2] * 255})`;
      ctx.fillRect(tl[0], tl[1], w, h);
    }
    const b = img.current.bmp;
    if (b) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = x.zoom * dpr > b.width / cp.width ? 'medium' : 'high';
      try {
        ctx.drawImage(b, tl[0], tl[1], w, h);
      } catch {
        img.current.bmp = null;
      }
    }
  };

  const paintOverlay = () => {
    const c = ovCanvas.current;
    const sz = sizeRef.current;
    if (!c || !sz.w) return;
    const W = Math.round(sz.w * dpr), H = Math.round(sz.h * dpr);
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const app = getApp();
    const cp = app.project.comps[compRef.current.id] ?? compRef.current;
    const v = makeViewCtx(app.project, cp, getTime(cp.id), viewRef.current, xfRef.current);
    drawOverlay(ctx, v, app, ov.current, sz.w, sz.h, isActivePane);
    drawTrackOverlay(ctx, v, app, getTracking(), useRoto.getState(), trackHover.current);
    if (trackMarquee.current) {
      const m = trackMarquee.current;
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = '#ffd24a';
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.min(m.x0, m.x1), Math.min(m.y0, m.y1), Math.abs(m.x1 - m.x0), Math.abs(m.y1 - m.y0));
      ctx.setLineDash([]);
    }
    if (loupe.current) drawLoupe(ctx, loupe.current.sx, loupe.current.sy);
  };

  /** 4× magnifier of the rendered frame around the dragged feature (like AE's feature zoom). */
  const drawLoupe = (ctx: CanvasRenderingContext2D, sx: number, sy: number) => {
    const src = imgCanvas.current;
    if (!src) return;
    const R = 64, Z = 4;
    const ox = sx + 26 + R * 2 > sizeRef.current.w ? sx - 26 - R * 2 : sx + 26;
    const oy = Math.max(6, Math.min(sizeRef.current.h - R * 2 - 6, sy - R));
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(ox, oy, R * 2, R * 2, 10);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    const half = R / Z;
    try {
      ctx.drawImage(src, (sx - half) * dpr, (sy - half) * dpr, half * 2 * dpr, half * 2 * dpr, ox, oy, R * 2, R * 2);
    } catch {
      /* canvas not ready */
    }
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(ox, oy, R * 2, R * 2, 10);
    ctx.stroke();
    ctx.strokeStyle = '#ffd24a';
    ctx.beginPath();
    ctx.moveTo(ox + R - 8, oy + R); ctx.lineTo(ox + R + 8, oy + R);
    ctx.moveTo(ox + R, oy + R - 8); ctx.lineTo(ox + R, oy + R + 8);
    ctx.stroke();
  };

  // ── render requests ──
  const doRender = async () => {
    renderPending.current = false;
    const p = paramsRef.current;
    const t = getTime(comp.id);
    if (isActivePane && viewRef.current.kind === 'active') setViewParams(p);
    const id = ++seq.current;
    const r = await renderForView(`view:${comp.id}:${index}`, comp.id, t, p, viewRef.current);
    if (!r) return;
    if (id < drawnSeq.current) {
      if (!r.cached) r.bitmap.close();
      return;
    }
    drawnSeq.current = id;
    const prev = img.current;
    if (prev.bmp && !prev.cached && prev.bmp !== r.bitmap) prev.bmp.close();
    img.current = { bmp: r.bitmap, cached: r.cached, time: t };
    paintImage();
  };

  const requestRender = () => {
    if (renderPending.current) return;
    renderPending.current = true;
    requestAnimationFrame(() => void doRender());
  };

  // time changes
  useEffect(() => {
    let lastT = getTime(comp.id);
    return timeStore.subscribe((s) => {
      const t = s.times[comp.id] ?? 0;
      if (t === lastT) return;
      lastT = t;
      requestRender();
      paintOverlay();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comp.id, index, size.w, size.h, isActivePane]);

  // project / view parameter changes
  useEffect(() => {
    const key = `${quantScale}|${viewer.motionBlur}|${viewer.draft3D}|${JSON.stringify(view)}|${size.w}x${size.h}`;
    lastRequestKey.current = key;
    requestRender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, quantScale, viewer.motionBlur, viewer.draft3D, view, size.w, size.h, isActivePane]);

  useEffect(() => {
    paintImage();
    paintOverlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  useEffect(() => {
    return useApp.subscribe((s, prev) => {
      if (s.selLayers !== prev.selLayers || s.selKeys !== prev.selKeys || s.selEffect !== prev.selEffect || s.selShapeItem !== prev.selShapeItem || s.viewers !== prev.viewers) paintOverlay();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, size.h, isActivePane]);

  useEffect(() => {
    const a = useTracking.subscribe(() => paintOverlay());
    const b = useRoto.subscribe(() => paintOverlay());
    return () => {
      a();
      b();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, size.h, isActivePane]);

  useEffect(() => () => {
    const b = img.current.bmp;
    if (b && !img.current.cached) b.close();
  }, []);

  // space-bar temporary hand tool
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !(e.target as HTMLElement).closest('input,textarea')) spaceHeld.current = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceHeld.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // ── helpers ──
  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = wrap.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const vctx = (): ViewCtx => makeViewCtx(getApp().project, getApp().project.comps[comp.id] ?? comp, getTime(comp.id), viewRef.current, xfRef.current);
  const activateMe = () => {
    if (!isActivePane) setViewer(comp.id, { activeView: index });
  };

  const drag = (onMove: (e: PointerEvent) => void, onUp?: (e: PointerEvent) => void, tx = true) => {
    if (tx) beginTx();
    const move = (e: PointerEvent) => {
      onMove(e);
      paintOverlay();
    };
    const up = (e: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', esc);
      onUp?.(e);
      if (tx) endTx();
      paintOverlay();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('keydown', esc);
        if (tx) cancelTx();
        ov.current.marquee = null;
        ov.current.shapeDraft = null;
        paintOverlay();
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', esc);
  };

  /** cursor (screen) → world point on a plane, or comp point for 2D layers */
  const cursorWorld = (v: ViewCtx, sx: number, sy: number, layer: Layer, planePoint: number[], normal?: number[]): number[] | null => {
    const c = screenToComp(v.xf, sx, sy);
    if (!layer.threeD) return [c[0], c[1], 0];
    const ray = compPxRay(v, c[0], c[1]);
    if (!ray) return null;
    return rayPlane(ray, planePoint, normal ?? viewForward(v));
  };

  const baseValue = (layer: Layer, path: string): number[] => {
    const p = getProp(layer, path)!;
    const t = getTime(comp.id);
    const spatial = path.endsWith('position') || path.endsWith('anchor') || path.endsWith('pointOfInterest');
    const v = p.keyframes.length ? keyframedValue(p, toLayerTime(layer, t), spatial) : p.value;
    return (v as number[]).slice();
  };
  const baseScalar = (layer: Layer, path: string): number => {
    const p = getProp(layer, path);
    if (!p) return 0;
    const v = p.keyframes.length ? keyframedValue(p, toLayerTime(layer, getTime(comp.id))) : p.value;
    return typeof v === 'number' ? v : 0;
  };

  // ── pointer down ──
  const onPointerDown = (e: React.PointerEvent) => {
    activateMe();
    if (textEdit) return;
    const [sx, sy] = local(e);
    const app = getApp();
    const v = vctx();
    if (e.button === 1 || tool === 'hand' || spaceHeld.current) {
      e.preventDefault();
      const p0 = { x: e.clientX, y: e.clientY, px: viewer.panX, py: viewer.panY };
      drag((ev) => setViewer(comp.id, { panX: p0.px + ev.clientX - p0.x, panY: p0.py + ev.clientY - p0.y }), undefined, false);
      return;
    }
    if (e.button === 2) return;
    if (tool === 'zoom') {
      zoomAt(sx, sy, e.altKey ? 0.5 : 2);
      return;
    }
    if (tool === 'camera') return cameraDrag(e, v);
    if (tool === 'shape') return shapeDrag(e, sx, sy);
    if (tool === 'pen') return penDown(e, sx, sy);
    if (tool === 'text') return textClick(sx, sy, v);
    if (tool === 'roto') return rotoClick(sx, sy, v, e.altKey ? 0 : 1);
    const th = tool === 'select' ? hitTrack(v, app, getTracking(), sx, sy) : null;
    if (th) return trackDrag(e, th, v, sx, sy);
    if (tool === 'select' && trackPointMode(app)) return trackPointMarquee(e, sx, sy);
    const handle = hitHandle(v, app, sx, sy, ov.current.selectedVertex);
    if (handle && tool !== 'rotate') return handleDrag(e, handle, v, sx, sy);
    if (tool === 'panBehind') {
      const layer = app.selLayers.length ? v.comp.layers.find((l) => l.id === app.selLayers[0]) : hitLayer(v, sx, sy);
      if (layer && !layer.locked) {
        if (!app.selLayers.includes(layer.id)) selectLayers([layer.id]);
        return handleDrag(e, { kind: 'anchor', layerId: layer.id }, v, sx, sy);
      }
      return;
    }
    const hit = hitLayer(v, sx, sy);
    if (tool === 'rotate') {
      const target = hit ?? (app.selLayers.length ? v.comp.layers.find((l) => l.id === app.selLayers[0]) : null);
      if (target && !target.locked) {
        if (!app.selLayers.includes(target.id)) selectLayers([target.id]);
        return handleDrag(e, { kind: 'rotate', layerId: target.id }, v, sx, sy);
      }
      return;
    }
    if (hit) {
      if (e.shiftKey || e.metaKey || e.ctrlKey) selectLayers([hit.id], 'toggle');
      else if (!app.selLayers.includes(hit.id)) selectLayers([hit.id]);
      ov.current.selectedVertex = null;
      if (!hit.locked) moveDrag(e, v, sx, sy, e.shiftKey);
      return;
    }
    // marquee selection
    if (!e.shiftKey) deselectAll();
    ov.current.selectedVertex = null;
    const start = [sx, sy];
    ov.current.marquee = { x0: sx, y0: sy, x1: sx, y1: sy };
    drag((ev) => {
      const [x, y] = local(ev);
      ov.current.marquee = { x0: start[0], y0: start[1], x1: x, y1: y };
    }, () => {
      const m = ov.current.marquee;
      ov.current.marquee = null;
      if (!m || (Math.abs(m.x1 - m.x0) < 3 && Math.abs(m.y1 - m.y0) < 3)) return;
      const x0 = Math.min(m.x0, m.x1), x1 = Math.max(m.x0, m.x1), y0 = Math.min(m.y0, m.y1), y1 = Math.max(m.y0, m.y1);
      const vv = vctx();
      const ids: string[] = [];
      for (const l of vv.comp.layers) {
        if (l.locked) continue;
        const b = layerBounds(vv.project, vv.comp, l, vv.fe);
        const q = b ? layerQuad(vv, l, b) : null;
        if (q && q.some((p) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1)) ids.push(l.id);
      }
      if (ids.length) selectLayers(ids, e.shiftKey ? 'add' : 'set');
    }, false);
  };

  /** Roto Brush tool: click = foreground prompt, Alt/right-click = background prompt. */
  function rotoClick(sx: number, sy: number, v: ViewCtx, label: 0 | 1) {
    const app = getApp();
    const sel = v.comp.layers.find((l) => app.selLayers.includes(l.id) && isTrackable(l));
    const target = sel ?? (() => {
      const h = hitLayer(v, sx, sy, true);
      return h && isTrackable(h) ? h : null;
    })();
    if (!target) {
      toast('Click on a footage or precomp layer to roto it', 'info');
      return;
    }
    const p = screenToLayer(v, target, sx, sy);
    if (!p) return;
    if (!app.selLayers.includes(target.id)) selectLayers([target.id]);
    addRotoPoint(comp.id, target.id, p[0], p[1], label);
  }

  /** Camera-track point selection is active when a solved layer is selected in camera mode. */
  function trackPointMode(app: ReturnType<typeof getApp>): boolean {
    const tr = getTracking();
    if (!tr.showTrackPoints || tr.mode !== 'camera') return false;
    return app.project.comps[comp.id]?.layers.some((l) => l.cameraTrack?.solved && app.selLayers.includes(l.id)) ?? false;
  }

  function trackPointMarquee(e: React.PointerEvent, sx: number, sy: number) {
    const additive = e.shiftKey;
    trackMarquee.current = { x0: sx, y0: sy, x1: sx, y1: sy };
    drag((ev) => {
      const [x, y] = local(ev);
      trackMarquee.current = { x0: sx, y0: sy, x1: x, y1: y };
    }, () => {
      const m = trackMarquee.current;
      trackMarquee.current = null;
      if (!m) return;
      if (Math.abs(m.x1 - m.x0) < 3 && Math.abs(m.y1 - m.y0) < 3) {
        if (!additive) setTracking({ camSel: [] });
        return;
      }
      const ids = camPointsInRect(vctx(), getApp(), getTracking(), Math.min(m.x0, m.x1), Math.min(m.y0, m.y1), Math.max(m.x0, m.x1), Math.max(m.y0, m.y1));
      setTracking({ camSel: additive ? [...new Set([...getTracking().camSel, ...ids])] : ids });
    }, false);
  }

  function trackDrag(e: React.PointerEvent, h: TrackHit, v: ViewCtx, sx: number, sy: number) {
    if (h.kind === 'camPoint') {
      const cur = getTracking().camSel;
      setTracking({ camSel: e.shiftKey ? (cur.includes(h.id) ? cur.filter((x) => x !== h.id) : [...cur, h.id]) : cur.includes(h.id) ? cur : [h.id] });
      return;
    }
    const f = findTracker(v.project, comp.id, h.layerId, h.trackerId);
    if (!f) return;
    const { layer, tracker } = f;
    const p = tracker.points.find((x) => x.id === h.pointId);
    if (!p) return;
    setTracking({ activePoint: p.id });
    if (!getApp().selLayers.includes(layer.id)) selectLayers([layer.id]);
    const t = getTime(comp.id);
    const c0 = featureCenterAt(layer, tracker, p.id, t) ?? [0, 0];
    const attach0 = [c0[0] + p.attachOffset[0], c0[1] + p.attachOffset[1]];
    const start = screenToLayer(v, layer, sx, sy);
    if (!start) return;
    const fs0 = p.featureSize.slice(), ss0 = p.searchSize.slice(), so0 = p.searchOffset.slice();
    const showLoupe = h.kind === 'feature' || h.kind === 'featureEdge';
    if (showLoupe) loupe.current = { sx, sy };
    drag((ev) => {
      const [x, y] = local(ev);
      const vv = vctx();
      const L = vv.comp.layers.find((l) => l.id === layer.id);
      if (!L) return;
      const cur = screenToLayer(vv, L, x, y);
      if (!cur) return;
      const dx = cur[0] - start[0], dy = cur[1] - start[1];
      if (showLoupe) {
        const ctr = h.kind === 'feature' ? [c0[0] + dx, c0[1] + dy] : c0;
        const s = layerPointToScreen(vv, L, ctr);
        loupe.current = s ? { sx: s[0], sy: s[1] } : null;
      }
      switch (h.kind) {
        case 'feature':
          // Alt-drag moves the feature region alone (search region stays put)
          if (ev.altKey) editTrackPoint(comp.id, layer.id, tracker.id, p.id, { center: [c0[0] + dx, c0[1] + dy], searchOffset: [so0[0] - dx, so0[1] - dy] });
          else editTrackPoint(comp.id, layer.id, tracker.id, p.id, { center: [c0[0] + dx, c0[1] + dy] });
          break;
        case 'search':
          editTrackPoint(comp.id, layer.id, tracker.id, p.id, { searchOffset: [so0[0] + dx, so0[1] + dy] });
          break;
        case 'featureEdge':
          editTrackPoint(comp.id, layer.id, tracker.id, p.id, { featureSize: [h.ix ? fs0[0] + 2 * dx * h.ix : fs0[0], h.iy ? fs0[1] + 2 * dy * h.iy : fs0[1]] });
          break;
        case 'searchEdge':
          editTrackPoint(comp.id, layer.id, tracker.id, p.id, { searchSize: [h.ix ? ss0[0] + 2 * dx * h.ix : ss0[0], h.iy ? ss0[1] + 2 * dy * h.iy : ss0[1]] });
          break;
        case 'attach':
          editTrackPoint(comp.id, layer.id, tracker.id, p.id, { attach: [attach0[0] + dx, attach0[1] + dy] });
          break;
      }
    }, () => {
      loupe.current = null;
    });
  }

  function zoomAt(sx: number, sy: number, factor: number) {
    const x = xfRef.current;
    const cp = screenToComp(x, sx, sy);
    const nz = Math.max(0.02, Math.min(32, x.zoom * factor));
    const cx = sx - (cp[0] - comp.width / 2) * nz;
    const cy = sy - (cp[1] - comp.height / 2) * nz;
    setViewer(comp.id, { zoom: nz, panX: cx - size.w / 2, panY: cy - size.h / 2 });
  }

  function moveDrag(e: React.PointerEvent, v: ViewCtx, sx: number, sy: number, _shift: boolean) {
    const app = getApp();
    const layers = v.comp.layers.filter((l) => app.selLayers.includes(l.id) && !l.locked && l.type !== 'audio');
    if (!layers.length) return;
    const starts = layers.map((l) => {
      const wpos = M.transformPoint(v.fe.worldMatrix(l), v.fe.transformValues(l).anchor);
      return { l, pos: baseValue(l, 'transform.position'), wpos, hit0: cursorWorld(v, sx, sy, l, wpos) };
    });
    const sx0 = e.clientX, sy0 = e.clientY;
    let moved = false;
    drag((ev) => {
      if (!moved && Math.hypot(ev.clientX - sx0, ev.clientY - sy0) < 3) return;
      moved = true;
      const [x, y] = local(ev);
      const vv = vctx();
      for (const s of starts) {
        const cur = cursorWorld(vv, x, y, s.l, s.wpos);
        if (!cur || !s.hit0) continue;
        let d = [cur[0] - s.hit0[0], cur[1] - s.hit0[1], cur[2] - s.hit0[2]];
        if (ev.shiftKey && !s.l.threeD) d = Math.abs(d[0]) > Math.abs(d[1]) ? [d[0], 0, 0] : [0, d[1], 0];
        const dp = worldDeltaToParent(vv, s.l, d);
        setPropValue(comp.id, s.l.id, 'transform.position', [s.pos[0] + dp[0], s.pos[1] + dp[1], (s.pos[2] ?? 0) + (s.l.threeD ? dp[2] : 0)]);
      }
    });
  }

  function handleDrag(e: React.PointerEvent, h: HandleHit, v: ViewCtx, sx: number, sy: number) {
    const layer = v.comp.layers.find((l) => l.id === h.layerId);
    if (!layer) return;
    const tv = v.fe.transformValues(layer);
    const W = v.fe.worldMatrix(layer);
    const anchorWorld = M.transformPoint(W, tv.anchor);
    const layerNormal = (() => {
      const n = M.transformDir(W, [0, 0, 1]);
      const l = Math.hypot(n[0], n[1], n[2]) || 1;
      return [n[0] / l, n[1] / l, n[2] / l];
    })();
    switch (h.kind) {
      case 'scale': {
        const b = layerBounds(v.project, v.comp, layer, v.fe);
        if (!b) return;
        const hp = [b.x + (b.w * h.ix) / 2, b.y + (b.h * h.iy) / 2];
        const s0 = baseValue(layer, 'transform.scale');
        const sc = tv.scale.map((x) => (Math.abs(x) > 1e-6 ? x : 1e-6) / 100);
        const N = M.mulAll(W, M.translation(tv.anchor[0], tv.anchor[1], tv.anchor[2] ?? 0), M.scaling(1 / sc[0], 1 / sc[1], 1 / (sc[2] || 1)));
        const Ninv = M.invert(N);
        if (!Ninv) return;
        drag((ev) => {
          const [x, y] = local(ev);
          const vv = vctx();
          const cw = cursorWorld(vv, x, y, layer, anchorWorld, layerNormal);
          if (!cw) return;
          const q = M.transformPoint(Ninv, cw);
          let fx = h.ix !== 1 && Math.abs(hp[0] - tv.anchor[0]) > 1e-6 ? q[0] / (hp[0] - tv.anchor[0]) : sc[0];
          let fy = h.iy !== 1 && Math.abs(hp[1] - tv.anchor[1]) > 1e-6 ? q[1] / (hp[1] - tv.anchor[1]) : sc[1];
          if (ev.shiftKey) {
            const r = h.ix === 1 ? fy / sc[1] : h.iy === 1 ? fx / sc[0] : Math.max(fx / sc[0], fy / sc[1]);
            fx = sc[0] * r;
            fy = sc[1] * r;
          }
          setPropValue(comp.id, layer.id, 'transform.scale', [fx * 100, fy * 100, s0[2] ?? 100]);
        });
        return;
      }
      case 'rotate': {
        const ap = layerPointToScreen(v, layer, tv.anchor) ?? [sx, sy];
        const a0 = Math.atan2(sy - ap[1], sx - ap[0]);
        const rot0 = baseScalar(layer, 'transform.rotation');
        drag((ev) => {
          const [x, y] = local(ev);
          let d = ((Math.atan2(y - ap[1], x - ap[0]) - a0) * 180) / Math.PI;
          if (d > 180) d -= 360;
          if (d < -180) d += 360;
          let r = rot0 + d;
          if (ev.shiftKey) r = Math.round(r / 45) * 45;
          setPropValue(comp.id, layer.id, 'transform.rotation', r);
        });
        return;
      }
      case 'anchor': {
        const a0 = baseValue(layer, 'transform.anchor');
        const p0 = baseValue(layer, 'transform.position');
        const local0 = v.fe.localMatrix(layer);
        const Winv = M.invert(W);
        if (!Winv) return;
        drag((ev) => {
          const [x, y] = local(ev);
          const vv = vctx();
          const cw = cursorWorld(vv, x, y, layer, anchorWorld, layerNormal);
          if (!cw) return;
          const la = M.transformPoint(Winv, cw);
          const na = [la[0], la[1], a0[2] ?? 0];
          const da = [na[0] - a0[0], na[1] - a0[1], 0];
          const dp = M.transformDir(local0, da);
          setPropValue(comp.id, layer.id, 'transform.anchor', na);
          setPropValue(comp.id, layer.id, 'transform.position', [p0[0] + dp[0], p0[1] + dp[1], (p0[2] ?? 0) + (layer.threeD ? dp[2] : 0)]);
        });
        return;
      }
      case 'axis': {
        const axisDir = (() => {
          const d = M.transformDir(W, [[1, 0, 0], [0, 1, 0], [0, 0, 1]][h.axis]);
          const l = Math.hypot(d[0], d[1], d[2]) || 1;
          return [d[0] / l, d[1] / l, d[2] / l];
        })();
        const f = viewForward(v);
        const c1 = normalize([axisDir[1] * f[2] - axisDir[2] * f[1], axisDir[2] * f[0] - axisDir[0] * f[2], axisDir[0] * f[1] - axisDir[1] * f[0]]);
        const n = [axisDir[1] * c1[2] - axisDir[2] * c1[1], axisDir[2] * c1[0] - axisDir[0] * c1[2], axisDir[0] * c1[1] - axisDir[1] * c1[0]];
        const hit0 = cursorWorld(v, sx, sy, layer, anchorWorld, n);
        const p0 = baseValue(layer, 'transform.position');
        if (!hit0) return;
        drag((ev) => {
          const [x, y] = local(ev);
          const vv = vctx();
          const cur = cursorWorld(vv, x, y, layer, anchorWorld, n);
          if (!cur) return;
          const along = (cur[0] - hit0[0]) * axisDir[0] + (cur[1] - hit0[1]) * axisDir[1] + (cur[2] - hit0[2]) * axisDir[2];
          const dp = worldDeltaToParent(vv, layer, axisDir.map((c) => c * along));
          setPropValue(comp.id, layer.id, 'transform.position', [p0[0] + dp[0], p0[1] + dp[1], (p0[2] ?? 0) + dp[2]]);
        });
        return;
      }
      case 'motionKf':
      case 'tangent': {
        const p = layer.transform.position;
        const kf = p.keyframes.find((k) => k.id === h.kfId);
        if (!kf) return;
        const key = keyOf({ layerId: layer.id, path: 'transform.position', kfId: kf.id });
        setApp({ selKeys: [key] });
        const kt = toCompTime(layer, kf.t);
        const parent = layer.parentId ? v.comp.layers.find((l) => l.id === layer.parentId) : undefined;
        const fek = new FrameEval(v.project, v.comp, kt);
        const PW = parent ? fek.worldMatrix(parent) : M.identity();
        const PWinv = M.invert(PW) ?? M.identity();
        const kv = (kf.v as number[]).slice();
        const kWorld = M.transformPoint(PW, kv);
        drag((ev) => {
          const [x, y] = local(ev);
          const vv = vctx();
          const cw = cursorWorld(vv, x, y, layer, kWorld);
          if (!cw) return;
          const pp = M.transformPoint(PWinv, cw);
          if (h.kind === 'motionKf') {
            setKeyframeValue(comp.id, key, [pp[0], pp[1], layer.threeD ? pp[2] : kv[2] ?? 0]);
          } else {
            const t = [pp[0] - kv[0], pp[1] - kv[1], layer.threeD ? pp[2] - (kv[2] ?? 0) : 0];
            setSpatialTangents(comp.id, key, h.side === 'in' ? t : null, h.side === 'out' ? t : null, ev.altKey);
          }
        });
        return;
      }
      case 'pathVertex':
      case 'pathTangent': {
        const Winv = M.invert(W);
        const minv: Mat2d = invert2d(h.matrix) ?? [1, 0, 0, 1, 0, 0];
        if (!Winv) return;
        const prop = getProp(layer, h.path);
        if (!prop) return;
        const t = getTime(comp.id);
        const start = (prop.keyframes.length ? keyframedValue(prop, toLayerTime(layer, t)) : prop.value) as BezierPath;
        ov.current.selectedVertex = { path: h.path, vi: h.vi };
        const pullTangent = h.kind === 'pathVertex' && e.altKey;
        drag((ev) => {
          const [x, y] = local(ev);
          const vv = vctx();
          const cw = cursorWorld(vv, x, y, layer, anchorWorld, layerNormal);
          if (!cw) return;
          const lp = M.transformPoint(Winv, cw);
          const q = apply2d(minv, lp);
          const np: BezierPath = { closed: start.closed, v: start.v.map((p) => [p[0], p[1]] as Vec2), i: start.i.map((p) => [p[0], p[1]] as Vec2), o: start.o.map((p) => [p[0], p[1]] as Vec2) };
          const vi = h.vi;
          if (h.kind === 'pathVertex' && !pullTangent) {
            np.v[vi] = [q[0], q[1]];
          } else {
            const side = h.kind === 'pathTangent' ? h.side : 'out';
            const d: Vec2 = [q[0] - np.v[vi][0], q[1] - np.v[vi][1]];
            if (side === 'out') {
              np.o[vi] = d;
              if (!ev.altKey || pullTangent) np.i[vi] = [-d[0], -d[1]];
            } else {
              np.i[vi] = d;
              if (!ev.altKey) np.o[vi] = [-d[0], -d[1]];
            }
          }
          setPropValue(comp.id, layer.id, h.path, np);
        });
        return;
      }
      case 'effectPoint': {
        const path = `effects.${h.fxId}.params.${h.paramId}`;
        const Winv = M.invert(W);
        if (!Winv) return;
        drag((ev) => {
          const [x, y] = local(ev);
          const vv = vctx();
          const cw = cursorWorld(vv, x, y, layer, anchorWorld, layerNormal);
          if (!cw) return;
          const lp = M.transformPoint(Winv, cw);
          setPropValue(comp.id, layer.id, path, [lp[0], lp[1]]);
        });
        return;
      }
      case 'camera': {
        selectLayers([layer.id]);
        const path = h.part === 'poi' ? (layer.camera ? 'camera.pointOfInterest' : 'light.pointOfInterest') : 'transform.position';
        const p0 = baseValue(layer, path);
        const parent = layer.parentId ? v.comp.layers.find((l) => l.id === layer.parentId) : undefined;
        const PW = parent ? v.fe.worldMatrix(parent) : M.identity();
        const wp = M.transformPoint(PW, p0);
        const n = viewForward(v);
        const hit0 = (() => {
          const c = screenToComp(v.xf, sx, sy);
          const r = compPxRay(v, c[0], c[1]);
          return r ? rayPlane(r, wp, n) ?? rayPlane({ o: r.o, d: r.d.map((x) => -x) }, wp, n) : null;
        })();
        if (!hit0) return;
        drag((ev) => {
          const [x, y] = local(ev);
          const vv = vctx();
          const c = screenToComp(vv.xf, x, y);
          const r = compPxRay(vv, c[0], c[1]);
          const cur = r ? rayPlane(r, wp, n) ?? rayPlane({ o: r.o, d: r.d.map((q) => -q) }, wp, n) : null;
          if (!cur) return;
          const dp = worldDeltaToParent(vv, layer, [cur[0] - hit0[0], cur[1] - hit0[1], cur[2] - hit0[2]]);
          setPropValue(comp.id, layer.id, path, [p0[0] + dp[0], p0[1] + dp[1], (p0[2] ?? 0) + dp[2]]);
        });
        return;
      }
    }
  }

  function cameraDrag(e: React.PointerEvent, v: ViewCtx) {
    const mode = getApp().cameraTool;
    const x0 = e.clientX, y0 = e.clientY;
    const vs = viewRef.current;
    if (vs.kind !== 'active') {
      const views = [...(getApp().viewers[comp.id]?.views ?? viewer.views)];
      const base = { ...vs };
      const isOrtho = vs.kind !== 'custom';
      drag((ev) => {
        const dx = ev.clientX - x0, dy = ev.clientY - y0;
        const next = { ...base };
        if (!isOrtho && mode === 'orbit') {
          next.yaw = (base.yaw ?? 35) + dx * 0.4;
          next.pitch = Math.max(-89, Math.min(89, (base.pitch ?? -22) - dy * 0.4));
        } else if (mode === 'trackZ') {
          if (isOrtho) next.zoom = Math.max(0.01, (base.zoom ?? 0.5) * Math.pow(1.01, -dy));
          else next.distance = Math.max(50, (base.distance ?? 4800) * Math.pow(1.01, dy));
        } else {
          const c = base.center ?? [comp.width / 2, comp.height / 2, 0];
          const k = isOrtho ? 1 / ((base.zoom ?? 0.5) * xfRef.current.zoom) : (base.distance ?? 4800) / 2666 / xfRef.current.zoom;
          if (isOrtho) {
            const pv = makeViewCtx(getApp().project, comp, getTime(comp.id), { ...base }, xfRef.current);
            const inv = M.invert(pv.proj.view) ?? M.identity();
            const right = M.transformDir(inv, [1, 0, 0]), down = M.transformDir(inv, [0, 1, 0]);
            next.center = c.map((q, i) => q - (right[i] * dx + down[i] * dy) * k);
          } else {
            const { eye, center } = customEye(comp, base);
            const rot = M.lookAtRotation(eye, center);
            const right = M.transformDir(rot, [1, 0, 0]), down = M.transformDir(rot, [0, 1, 0]);
            next.center = c.map((q, i) => q - (right[i] * dx + down[i] * dy) * k);
          }
        }
        views[index] = next;
        setViewer(comp.id, { views: [...views] });
      }, undefined, false);
      return;
    }
    let cam = v.fe.activeCameraLayer();
    if (!cam) {
      const c = createCameraLayer(comp, 50);
      addLayer(comp.id, c, { index: 0, select: true });
      toast('Created Camera 1 for the camera tools', 'info');
      cam = c;
      return;
    }
    const camLayer = cam;
    const pos0 = baseValue(camLayer, 'transform.position');
    const poi0 = camLayer.camera?.kind === 'twoNode' ? baseValue(camLayer, 'camera.pointOfInterest') : null;
    const ry0 = baseScalar(camLayer, 'transform.rotationY');
    const rx0 = baseScalar(camLayer, 'transform.rotationX');
    const camW = v.fe.worldMatrix(camLayer);
    const right = M.transformDir(camW, [1, 0, 0]), down = M.transformDir(camW, [0, 1, 0]), fwd = M.transformDir(camW, [0, 0, 1]);
    const zoomPx = v.fe.camera().zoom;
    const dist = poi0 ? Math.hypot(pos0[0] - poi0[0], pos0[1] - poi0[1], pos0[2] - poi0[2]) : zoomPx;
    drag((ev) => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      if (mode === 'orbit') {
        if (poi0) {
          const r = [pos0[0] - poi0[0], pos0[1] - poi0[1], pos0[2] - poi0[2]];
          const rot = M.mulAll(M.rotationY(-dx * 0.3), rotAround(right, dy * 0.3));
          const rr = M.transformDir(rot, r);
          setPropValue(comp.id, camLayer.id, 'transform.position', [poi0[0] + rr[0], poi0[1] + rr[1], poi0[2] + rr[2]]);
        } else {
          setPropValue(comp.id, camLayer.id, 'transform.rotationY', ry0 + dx * 0.3);
          setPropValue(comp.id, camLayer.id, 'transform.rotationX', rx0 - dy * 0.3);
        }
      } else if (mode === 'trackXY') {
        const k = dist / zoomPx / xfRef.current.zoom;
        const d = [0, 1, 2].map((i) => -(right[i] * dx + down[i] * dy) * k);
        setPropValue(comp.id, camLayer.id, 'transform.position', pos0.map((q, i) => q + d[i]));
        if (poi0) setPropValue(comp.id, camLayer.id, 'camera.pointOfInterest', poi0.map((q, i) => q + d[i]));
      } else {
        const k = (dist / zoomPx / xfRef.current.zoom) * 2.5;
        const d = fwd.map((c) => -c * dy * k);
        setPropValue(comp.id, camLayer.id, 'transform.position', pos0.map((q, i) => q + d[i]));
        if (poi0) setPropValue(comp.id, camLayer.id, 'camera.pointOfInterest', poi0.map((q, i) => q + d[i]));
      }
    });
  }

  function shapeDrag(_e: React.PointerEvent, sx: number, sy: number) {
    ov.current.shapeDraft = { x0: sx, y0: sy, x1: sx, y1: sy };
    drag((ev) => {
      const [x, y] = local(ev);
      let x1 = x, y1 = y;
      if (ev.shiftKey) {
        const s = Math.max(Math.abs(x - sx), Math.abs(y - sy));
        x1 = sx + Math.sign(x - sx || 1) * s;
        y1 = sy + Math.sign(y - sy || 1) * s;
      }
      ov.current.shapeDraft = { x0: sx, y0: sy, x1, y1 };
    }, () => {
      const d = ov.current.shapeDraft;
      ov.current.shapeDraft = null;
      if (!d || Math.abs(d.x1 - d.x0) < 4 || Math.abs(d.y1 - d.y0) < 4) return;
      createShapeFromDraft(d);
    }, false);
  }

  function createShapeFromDraft(d: { x0: number; y0: number; x1: number; y1: number }) {
    const app = getApp();
    const v = vctx();
    const kind = app.shapeTool;
    const a = screenToComp(v.xf, Math.min(d.x0, d.x1), Math.min(d.y0, d.y1));
    const b = screenToComp(v.xf, Math.max(d.x0, d.x1), Math.max(d.y0, d.y1));
    const sel = v.comp.layers.find((l) => app.selLayers.includes(l.id) && !l.locked);
    const color = FILL_PALETTE[paletteIdx++ % FILL_PALETTE.length];
    const toLayer = (l: Layer, p: number[]) => {
      const inv = M.invert(v.fe.worldMatrix(l));
      return inv ? M.transformPoint(inv, [p[0], p[1], 0]) : p;
    };
    if (sel && sel.type !== 'shape' && sel.type !== 'camera' && sel.type !== 'light' && sel.type !== 'null' && sel.type !== 'audio') {
      // mask on the selected layer
      const p0 = toLayer(sel, a), p1 = toLayer(sel, b);
      const x = Math.min(p0[0], p1[0]), y = Math.min(p0[1], p1[1]), w = Math.abs(p1[0] - p0[0]), h = Math.abs(p1[1] - p0[1]);
      let path: BezierPath;
      if (kind === 'ellipse') path = ellipsePath(x + w / 2, y + h / 2, w / 2, h / 2);
      else if (kind === 'polygon' || kind === 'star') path = polystarToPath(kind === 'star' ? 'star' : 'polygon', 5, [x + w / 2, y + h / 2], 0, Math.min(w, h) / 4, Math.min(w, h) / 2, 0, 0, false);
      else path = rectPath(x, y, w, h);
      addMask(comp.id, sel.id, path);
      toast('Mask added', 'success', 1500);
      return;
    }
    const center = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const w = b[0] - a[0], h = b[1] - a[1];
    const gen = kind === 'ellipse' ? createEllipse([w, h]) : kind === 'polygon' ? createPolystar('polygon', 6, Math.min(w, h) / 2) : kind === 'star' ? createPolystar('star', 5, Math.min(w, h) / 2, Math.min(w, h) / 4) : createRect([w, h], [0, 0], kind === 'roundedRect' ? Math.min(w, h) * 0.15 : 0);
    const stroke = createStroke([1, 1, 1, 1], 4);
    stroke.enabled = false;
    if (sel && sel.type === 'shape') {
      const lc = toLayer(sel, center);
      const g = createGroup([gen, stroke, createFill(color)], kind === 'ellipse' ? 'Ellipse 1' : kind === 'rect' || kind === 'roundedRect' ? 'Rectangle 1' : 'Polystar 1');
      g.transform.position.value = [lc[0], lc[1]];
      addShapeItem(comp.id, sel.id, g);
      return;
    }
    const g = createGroup([gen, stroke, createFill(color)], kind === 'ellipse' ? 'Ellipse 1' : kind === 'rect' || kind === 'roundedRect' ? 'Rectangle 1' : 'Polystar 1');
    const layer = createShapeLayer(v.comp, [g], 'Shape Layer 1');
    layer.transform.position.value = [center[0], center[1], 0];
    addLayer(comp.id, layer, { index: 0 });
  }

  function penDown(e: React.PointerEvent, sx: number, sy: number) {
    const pen = ov.current.pen ?? { pts: [], cursor: null };
    ov.current.pen = pen;
    if (pen.pts.length >= 2 && Math.hypot(pen.pts[0].p[0] - sx, pen.pts[0].p[1] - sy) < 8) {
      finishPen(true);
      return;
    }
    const pt = { p: [sx, sy] as [number, number], i: [0, 0] as [number, number], o: [0, 0] as [number, number] };
    pen.pts.push(pt);
    const x0 = e.clientX, y0 = e.clientY;
    drag((ev) => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      if (Math.hypot(dx, dy) < 3) return;
      pt.o = [dx, dy];
      pt.i = [-dx, -dy];
    }, undefined, false);
    paintOverlay();
  }

  function finishPen(closed: boolean) {
    const pen = ov.current.pen;
    ov.current.pen = null;
    paintOverlay();
    if (!pen || pen.pts.length < 2) return;
    const app = getApp();
    const v = vctx();
    const sel = v.comp.layers.find((l) => app.selLayers.includes(l.id) && !l.locked);
    const toComp = (p: [number, number]) => screenToComp(v.xf, p[0], p[1]);
    const build = (map: (c: number[]) => number[]): BezierPath => ({
      closed,
      v: pen.pts.map((q) => {
        const c = map(toComp(q.p));
        return [c[0], c[1]] as Vec2;
      }),
      i: pen.pts.map((q) => {
        const a = map(toComp(q.p)), b = map(toComp([q.p[0] + q.i[0], q.p[1] + q.i[1]]));
        return [b[0] - a[0], b[1] - a[1]] as Vec2;
      }),
      o: pen.pts.map((q) => {
        const a = map(toComp(q.p)), b = map(toComp([q.p[0] + q.o[0], q.p[1] + q.o[1]]));
        return [b[0] - a[0], b[1] - a[1]] as Vec2;
      }),
    });
    const toLayer = (l: Layer) => {
      const inv = M.invert(v.fe.worldMatrix(l));
      return (c: number[]) => (inv ? M.transformPoint(inv, [c[0], c[1], 0]) : c);
    };
    if (sel && sel.type !== 'shape' && sel.type !== 'camera' && sel.type !== 'light' && sel.type !== 'null' && sel.type !== 'audio') {
      addMask(comp.id, sel.id, build(toLayer(sel)));
      return;
    }
    const stroke = createStroke([1, 1, 1, 1], 4);
    const items = closed ? [createPathItem(build(() => [0, 0])), stroke, createFill(FILL_PALETTE[paletteIdx++ % FILL_PALETTE.length])] : [createPathItem(build(() => [0, 0])), stroke];
    if (sel && sel.type === 'shape') {
      (items[0] as ReturnType<typeof createPathItem>).path.value = build(toLayer(sel));
      addShapeItem(comp.id, sel.id, createGroup(items, 'Shape 1'));
      return;
    }
    const layer = createShapeLayer(v.comp, [createGroup(items, 'Shape 1')], 'Shape Layer 1');
    layer.transform.position.value = [comp.width / 2, comp.height / 2, 0];
    (items[0] as ReturnType<typeof createPathItem>).path.value = build((c) => [c[0] - comp.width / 2, c[1] - comp.height / 2]);
    addLayer(comp.id, layer, { index: 0 });
  }

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!ov.current.pen) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        finishPen(false);
      } else if (e.key === 'Escape') {
        ov.current.pen = null;
        paintOverlay();
      }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  });

  function textClick(sx: number, sy: number, v: ViewCtx) {
    const hit = hitLayer(v, sx, sy);
    if (hit && hit.type === 'text') {
      selectLayers([hit.id]);
      beginTextEdit(hit);
      return;
    }
    const c = screenToComp(v.xf, sx, sy);
    const layer = createTextLayer(v.comp, 'Text', { size: 96, justify: 'left' });
    layer.transform.position.value = [c[0], c[1], 0];
    addLayer(comp.id, layer, { index: 0 });
    setTimeout(() => {
      const l = getApp().project.comps[comp.id]?.layers.find((x) => x.id === layer.id);
      if (l) beginTextEdit(l, true);
    }, 30);
  }

  function beginTextEdit(layer: Layer, selectAll = false) {
    const v = vctx();
    const b = layerBounds(v.project, v.comp, layer, v.fe);
    const q = b ? layerQuad(v, layer, b) : null;
    const tv = v.fe.transformValues(layer);
    const size = (layer.text?.document.size ?? 72) * (tv.scale[1] / 100) * v.xf.zoom;
    if (!q) return;
    const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
    setTextEdit({ layerId: layer.id, x: Math.min(...xs), y: Math.min(...ys), w: Math.max(80, Math.max(...xs) - Math.min(...xs)), h: Math.max(30, Math.max(...ys) - Math.min(...ys)), size });
    textSelectAll.current = selectAll;
  }
  const textSelectAll = useRef(false);

  const onDoubleClick = (e: React.MouseEvent) => {
    const [sx, sy] = local(e);
    const v = vctx();
    const hit = hitLayer(v, sx, sy);
    if (!hit) return;
    if (hit.type === 'text') {
      selectLayers([hit.id]);
      beginTextEdit(hit);
    } else if (hit.type === 'precomp' && hit.source?.compId) {
      openComp(hit.source.compId);
    } else if (hit.type === 'shape' && hit.shape) {
      const findPath = (items: typeof hit.shape.contents): string | null => {
        for (const it of items) {
          if (it.type === 'path') return it.id;
          if (it.type === 'group') {
            const r = findPath(it.contents);
            if (r) return it.id;
          }
        }
        return null;
      };
      const id = findPath(hit.shape.contents);
      if (id) {
        selectLayers([hit.id]);
        setApp({ selShapeItem: id });
      }
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const [sx, sy] = local(e);
    const app = getApp();
    // info panel sampling (throttled by rAF)
    infoSample(sx, sy);
    if (ov.current.pen) {
      ov.current.pen.cursor = [sx, sy];
      paintOverlay();
      return;
    }
    if (e.buttons) return;
    const v = vctx();
    const th = tool === 'select' ? hitTrack(v, app, getTracking(), sx, sy) : null;
    if (JSON.stringify(th) !== JSON.stringify(trackHover.current)) {
      trackHover.current = th;
      const camHover = th?.kind === 'camPoint' ? th.id : null;
      if (getTracking().camHover !== camHover) setTracking({ camHover });
      paintOverlay();
    }
    if (th) {
      wrap.current!.style.cursor = th.kind === 'featureEdge' || th.kind === 'searchEdge'
        ? (th.ix === 0 ? 'ns-resize' : th.iy === 0 ? 'ew-resize' : th.ix === th.iy ? 'nwse-resize' : 'nesw-resize')
        : th.kind === 'camPoint' ? 'pointer' : th.kind === 'attach' ? 'crosshair' : 'move';
      return;
    }
    if (tool === 'roto') {
      wrap.current!.style.cursor = 'crosshair';
      return;
    }
    const h = tool === 'select' || tool === 'panBehind' ? hitHandle(v, app, sx, sy, ov.current.selectedVertex) : null;
    const prev = ov.current.hover;
    if (JSON.stringify(prev) !== JSON.stringify(h)) {
      ov.current.hover = h;
      paintOverlay();
    }
    const el = wrap.current!;
    el.style.cursor = cursorFor(tool, h, spaceHeld.current, getApp().cameraTool);
  };

  const infoPending = useRef(false);
  const infoSample = (sx: number, sy: number) => {
    if (infoPending.current) return;
    infoPending.current = true;
    requestAnimationFrame(() => {
      infoPending.current = false;
      const c = imgCanvas.current;
      if (!c) return;
      const cp = screenToComp(xfRef.current, sx, sy);
      let rgba: number[] | undefined;
      if (cp[0] >= 0 && cp[1] >= 0 && cp[0] < comp.width && cp[1] < comp.height) {
        try {
          const d = c.getContext('2d')!.getImageData(Math.round(sx * dpr), Math.round(sy * dpr), 1, 1).data;
          rgba = [d[0], d[1], d[2], d[3]];
        } catch {
          rgba = undefined;
        }
      }
      setApp({ info: { x: cp[0], y: cp[1], rgba } });
    });
  };

  const onWheel = (e: React.WheelEvent) => {
    const [sx, sy] = local(e);
    if (viewRef.current.kind !== 'active' && viewRef.current.kind !== 'custom' && e.altKey) return;
    if (e.shiftKey && !e.ctrlKey) {
      setViewer(comp.id, { panX: viewer.panX - e.deltaY });
      return;
    }
    const f = Math.pow(1.0018, -e.deltaY * (e.ctrlKey ? 3 : 1));
    zoomAt(sx, sy, f);
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const [sx, sy] = local(e);
    const v = vctx();
    if (tool === 'roto') {
      rotoClick(sx, sy, v, 0);
      return;
    }
    const app0 = getApp();
    const camLayer = v.comp.layers.find((l) => l.cameraTrack?.solved && app0.selLayers.includes(l.id));
    if (camLayer && getTracking().showTrackPoints) {
      const h = hitTrack(v, app0, getTracking(), sx, sy);
      if (h?.kind === 'camPoint' && !getTracking().camSel.includes(h.id)) setTracking({ camSel: [h.id] });
      const n = getTracking().camSel.length;
      if (n) {
        openContextMenu(e.clientX, e.clientY, [
          { label: `Set Ground Plane and Origin${n < 3 ? ' (needs 3 points)' : ''}`, action: () => setGroundPlane(comp.id, camLayer.id), disabled: n < 3 },
          { label: '', separator: true },
          { label: 'Create Null and Camera', action: () => createAtTrackPoints(comp.id, camLayer.id, 'null') },
          { label: 'Create Solid and Camera', action: () => createAtTrackPoints(comp.id, camLayer.id, 'solid') },
          { label: 'Create Text and Camera', action: () => createAtTrackPoints(comp.id, camLayer.id, 'text') },
          { label: `Create ${n} Nulls and Camera`, action: () => createAtTrackPoints(comp.id, camLayer.id, 'null', true), disabled: n < 2 },
          { label: 'Create Shadow Catcher and Camera', action: () => createAtTrackPoints(comp.id, camLayer.id, 'shadowCatcher'), disabled: n < 3 },
          { label: '', separator: true },
          { label: 'Deselect Track Points', action: () => setTracking({ camSel: [] }) },
        ]);
        return;
      }
    }
    const hit = hitLayer(v, sx, sy);
    if (hit && !getApp().selLayers.includes(hit.id)) selectLayers([hit.id]);
    const ids = hit ? getApp().selLayers : [];
    openContextMenu(e.clientX, e.clientY, layerContextMenu(comp.id, ids));
  };

  const editingLayer = textEdit ? comp.layers.find((l) => l.id === textEdit.layerId) : null;

  return (
    <div
      ref={wrap}
      className={`view-pane${isActivePane ? ' active' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onDoubleClick={onDoubleClick}
      onWheel={onWheel}
      onContextMenu={onContextMenu}
    >
      <canvas ref={imgCanvas} className="view-canvas" style={{ width: size.w, height: size.h }} />
      <canvas ref={ovCanvas} className="view-overlay" style={{ width: size.w, height: size.h }} />
      {view.kind !== 'active' && <div className="view-label">{VIEW_LABELS[view.kind]}</div>}
      {textEdit && editingLayer?.text && (
        <textarea
          className="text-edit"
          autoFocus
          style={{
            left: textEdit.x, top: textEdit.y, width: textEdit.w + 40, minHeight: textEdit.h,
            fontSize: Math.max(10, Math.min(200, textEdit.size)), fontFamily: `"${editingLayer.text.document.font}", Inter, sans-serif`,
            fontWeight: editingLayer.text.document.weight, textAlign: editingLayer.text.document.justify,
          }}
          defaultValue={String(editingLayer.text.sourceText.value)}
          onFocus={(e) => {
            if (textSelectAll.current) e.currentTarget.select();
          }}
          onChange={(e) => setSourceText(comp.id, editingLayer.id, e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) setTextEdit(null);
          }}
          onBlur={() => setTextEdit(null)}
          onPointerDown={(e) => e.stopPropagation()}
        />
      )}
    </div>
  );
}

const VIEW_LABELS: Record<string, string> = {
  front: 'Front', back: 'Back', left: 'Left', right: 'Right', top: 'Top', bottom: 'Bottom', custom: 'Custom View',
};

function cursorFor(tool: string, h: HandleHit | null, space: boolean, cam: string): string {
  if (space || tool === 'hand') return 'grab';
  if (tool === 'zoom') return 'zoom-in';
  if (tool === 'pen') return 'crosshair';
  if (tool === 'text') return 'text';
  if (tool === 'shape') return 'crosshair';
  if (tool === 'camera') return cam === 'orbit' ? 'grab' : 'move';
  if (tool === 'rotate') return 'alias';
  if (!h) return 'default';
  switch (h.kind) {
    case 'scale': return h.ix === 1 ? 'ns-resize' : h.iy === 1 ? 'ew-resize' : (h.ix === h.iy ? 'nwse-resize' : 'nesw-resize');
    case 'rotate': return 'alias';
    case 'anchor': return 'move';
    default: return 'pointer';
  }
}

function rotAround(axis: number[], deg: number): M.Mat4 {
  const l = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const [x, y, z] = [axis[0] / l, axis[1] / l, axis[2] / l];
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r), t = 1 - c;
  const m = M.identity();
  m[0] = t * x * x + c; m[1] = t * x * y + s * z; m[2] = t * x * z - s * y;
  m[4] = t * x * y - s * z; m[5] = t * y * y + c; m[6] = t * y * z + s * x;
  m[8] = t * x * z + s * y; m[9] = t * y * z - s * x; m[10] = t * z * z + c;
  return m;
}

