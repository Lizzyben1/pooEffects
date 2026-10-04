// ─────────────────────────────────────────────────────────────────────────────
// Composition renderer (runs inside the render worker, or inline as fallback)
//
// Frame lifecycle for one composition at time t:
//   1. FrameEval resolves transforms, parenting, camera & lights at t.
//   2. Layers are visited bottom → top. Consecutive 3D layers form a "run",
//      sorted far → near by camera-space depth, sharing a depth buffer so
//      intersecting layers occlude each other correctly.
//   3. Per layer:  SOURCE (solid / footage / precomp / shape / text raster)
//                → MASKS (Canvas2D coverage, feather, expansion, modes)
//                → EFFECTS (ping-pong GPU passes, padding grows the rect)
//                → TRANSFORM into comp space (2D ortho or 3D camera projection,
//                  motion blur = N sub-frame samples accumulated, lights, DOF)
//                → TRACK MATTE (alpha/luma, inverted)
//                → BLEND into the accumulator (W3C blend modes, ping-pong).
//      Adjustment layers instead run their effects on the accumulator and
//      mix the result through their own (masked, transformed) footprint.
//   4. The accumulator is presented (flipped, optional background) to the
//      worker's OffscreenCanvas and transferred to the UI as an ImageBitmap.
// ─────────────────────────────────────────────────────────────────────────────

import type { Composition, Footage, Layer, Project, RGBA } from '../core/types';
import { FrameEval, isActiveAt, toLayerTime } from '../core/evaluate';
import { computeProjection, type Projection, type ViewKind, type ViewSpec } from './projection';
import * as M from '../math/mat4';
import { GLContext, type Tex, type TexFormat } from './gl/gl';
import {
  BLEND_INDEX, FS_COMPOSITE, FS_DEPTH, FS_LAYER, FS_MASK_APPLY, FS_MATTE, FS_MIX, FS_PRESENT, VS_LAYER,
} from './gl/shaders';
import { copyTex, gaussianBlur, type AudioAccess, type FxCtx, type Rect } from './effects/kit';
import { EFFECT_IMPLS } from './effects/impls';
import { PASSTHROUGH_EFFECTS } from '../effects/catalog';
import { evaluateShapeContents } from '../shapes/evaluate';
import { rasterizeDrawOps, type AnyCanvas, type CanvasProvider, type Ctx2D } from '../shapes/rasterize';
import { tracePath } from '../shapes/path';
import { evaluateText } from '../text/animate';
import { rasterizeText } from '../text/rasterize';
import type { Measure } from '../text/layout';
import { exactFps } from '../core/time';

export type { ViewKind, ViewSpec } from './projection';

export interface RenderOptions {
  compId: string;
  time: number;
  scale: number;
  view?: ViewSpec;
  draft?: boolean;
  guides?: boolean;
  motionBlur?: boolean;
}

export interface AssetHost {
  image(footageId: string): ImageBitmap | null;
  videoFrame(footageId: string, footageTime: number): { frame: TexImageSource; key: string; w: number; h: number } | null;
  audioSamples(footageId: string, t: number, dur: number): { data: Float32Array; sampleRate: number } | null;
  /** decoded roto matte revision (8-bit alpha) */
  matte?(matteId: string, rev: number): { data: Uint8Array; w: number; h: number; key: string } | null;
}

interface LayerImage {
  tex: Tex;
  rect: Rect;
  /** texture pixels per layer unit */
  scale: number;
  owned: boolean;
}


interface CompCtx {
  scale: number;
  depth: number;
  view: ViewSpec;
  opts: RenderOptions;
  frameCache: Map<string, Tex>;
  W: number;
  H: number;
  comp: Composition;
  fmt: TexFormat;
}

interface RasterEntry {
  key: number;
  tex: Tex;
  rect: Rect;
  scale: number;
  frame: number;
}

/** Map a layer's source time to footage time (interpretation: conform rate, looping). */
export function footageTime(f: Footage, sourceTime: number): number {
  let t = sourceTime;
  const conform = f.interpret.frameRate;
  if (f.kind === 'video' && conform && conform > 0 && f.frameRate > 0) {
    const idx = Math.floor(sourceTime * exactFps(conform) + 1e-6);
    t = idx / exactFps(f.frameRate);
  }
  if (f.duration > 0) {
    const loop = Math.max(1, Math.floor(f.interpret.loop || 1));
    if (loop > 1 && t >= f.duration && t < f.duration * loop) t = t % f.duration;
    const fd = f.frameRate > 0 ? 1 / f.frameRate : 0;
    t = Math.max(0, Math.min(f.duration - fd * 0.5, t));
  }
  return t;
}

/** Collect footage frames needed to render comp at time (recursing into precomps). */
export function collectVideoNeeds(project: Project, comp: Composition, time: number, out: Map<string, number[]>, depth = 0): void {
  if (depth > 12) return;
  const fe = new FrameEval(project, comp, time);
  for (const l of comp.layers) {
    if (!isActiveAt(l, time)) continue;
    if (l.type === 'video' && l.source?.footageId) {
      const f = project.footage[l.source.footageId];
      if (!f || !f.hasVideo) continue;
      const t = footageTime(f, fe.sourceTime(l));
      const arr = out.get(f.id) ?? [];
      arr.push(t);
      out.set(f.id, arr);
    } else if (l.type === 'precomp' && l.source?.compId) {
      const nested = project.comps[l.source.compId];
      if (nested) collectVideoNeeds(project, nested, fe.sourceTime(l), out, depth + 1);
    }
  }
}

const VISUAL_TYPES = new Set(['solid', 'shape', 'text', 'image', 'video', 'precomp']);

function hashNumbers(h: number, x: number): number {
  h ^= Math.floor(x * 1000) | 0;
  return Math.imul(h, 16777619) >>> 0;
}

function hashAny(h: number, v: unknown): number {
  if (typeof v === 'number') return hashNumbers(h, v);
  if (typeof v === 'string') {
    for (let i = 0; i < v.length; i++) h = Math.imul(h ^ v.charCodeAt(i), 16777619) >>> 0;
    return h;
  }
  if (typeof v === 'boolean') return hashNumbers(h, v ? 1 : 2);
  if (Array.isArray(v)) {
    h = hashNumbers(h, v.length + 0.5);
    for (const x of v) h = hashAny(h, x);
    return h;
  }
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v as object)) {
      h = hashAny(h, k);
      h = hashAny(h, (v as Record<string, unknown>)[k]);
    }
    return h;
  }
  return hashNumbers(h, 7);
}

class OffscreenCanvasProvider implements CanvasProvider {
  private main: { canvas: AnyCanvas; ctx: Ctx2D } | null = null;
  private scr: { canvas: AnyCanvas; ctx: Ctx2D } | null = null;
  private make(w: number, h: number): { canvas: AnyCanvas; ctx: Ctx2D } {
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = (canvas as OffscreenCanvas).getContext('2d', { willReadFrequently: false }) as Ctx2D;
    return { canvas, ctx };
  }
  private fit(slot: { canvas: AnyCanvas; ctx: Ctx2D } | null, w: number, h: number) {
    if (!slot) return this.make(w, h);
    if (slot.canvas.width !== w || slot.canvas.height !== h) {
      slot.canvas.width = w;
      slot.canvas.height = h;
    }
    return slot;
  }
  get(w: number, h: number) {
    this.main = this.fit(this.main, w, h);
    return this.main;
  }
  scratch(w: number, h: number) {
    this.scr = this.fit(this.scr, w, h);
    return this.scr;
  }
}

export class Renderer {
  readonly glc: GLContext;
  project: Project;
  assets: AssetHost;
  readonly canvases: CanvasProvider = new OffscreenCanvasProvider();
  readonly measure: Measure;
  private imageTex = new Map<string, { tex: Tex; bitmap: ImageBitmap }>();
  private videoTex = new Map<string, { tex: Tex; key: string }>();
  private raster = new Map<string, RasterEntry>();
  private maskUpload: Tex | null = null;
  private matteTex = new Map<string, Tex>();
  private frameNo = 0;
  errors = new Map<string, string>();
  lastStats = { layers: 0, ms: 0 };
  private layersDrawn = 0;

  constructor(canvas: OffscreenCanvas | HTMLCanvasElement, project: Project, assets: AssetHost) {
    this.glc = new GLContext(canvas);
    this.project = project;
    this.assets = assets;
    const mc = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(8, 8) : document.createElement('canvas');
    const mctx = (mc as OffscreenCanvas).getContext('2d') as Ctx2D;
    this.measure = (s, font) => {
      mctx.font = font;
      return mctx.measureText(s).width;
    };
  }

  setProject(p: Project): void {
    this.project = p;
  }

  /** Drop cached rasters (e.g. after fonts load). */
  invalidateRasters(): void {
    for (const r of this.raster.values()) this.glc.deleteTex(r.tex);
    this.raster.clear();
  }

  forgetImage(footageId: string): void {
    const e = this.imageTex.get(footageId);
    if (e) this.glc.deleteTex(e.tex);
    this.imageTex.delete(footageId);
    const v = this.videoTex.get(footageId);
    if (v) this.glc.deleteTex(v.tex);
    this.videoTex.delete(footageId);
  }

  // ── public entry ──────────────────────────────────────────────────────────

  /** Render a composition; returns a pooled texture valid until endFrame(). */
  render(opts: RenderOptions): { tex: Tex; comp: Composition } | null {
    const comp = this.project.comps[opts.compId];
    if (!comp) return null;
    const t0 = performance.now();
    this.frameNo++;
    this.layersDrawn = 0;
    this.glc.beginFrame();
    const frameCache = new Map<string, Tex>();
    const tex = this.renderComp(comp, opts.time, {
      scale: opts.scale, depth: 0, view: opts.view ?? { kind: 'active' }, opts, frameCache,
      W: 0, H: 0, comp, fmt: 'rgba8',
    });
    for (const t of frameCache.values()) if (t !== tex) this.glc.release(t);
    this.lastStats = { layers: this.layersDrawn, ms: performance.now() - t0 };
    this.evictRasters();
    return { tex, comp };
  }

  /** Present a comp texture to the canvas (flipped), optionally over a background color. */
  present(tex: Tex, bg: RGBA | null): void {
    const glc = this.glc;
    const c = glc.canvas;
    if (c.width !== tex.w || c.height !== tex.h) {
      c.width = tex.w;
      c.height = tex.h;
    }
    const p = glc.program('present', FS_PRESENT);
    glc.pass(p, null, (pp) => {
      pp.tex('u_src', tex);
      pp.set('u_bg', bg ? [bg[0] * bg[3], bg[1] * bg[3], bg[2] * bg[3], bg[3]] : [0, 0, 0, 0]);
      pp.set('u_useBg', bg ? 1 : 0);
      pp.set('u_flip', 1);
    });
  }

  /** Read back a texture as RGBA8 (top row first). */
  readPixels(tex: Tex): Uint8Array {
    const gl = this.glc.gl;
    this.glc.bindTarget(tex);
    const out = new Uint8Array(tex.w * tex.h * 4);
    if (tex.format === 'rgba8') {
      gl.readPixels(0, 0, tex.w, tex.h, gl.RGBA, gl.UNSIGNED_BYTE, out);
      return out;
    }
    // float targets: convert through an 8-bit copy
    const tmp = this.glc.acquire(tex.w, tex.h, 'rgba8', false);
    copyTex(this.glc, tex, tmp);
    this.glc.bindTarget(tmp);
    gl.readPixels(0, 0, tex.w, tex.h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    this.glc.release(tmp);
    return out;
  }

  endFrame(): void {
    this.glc.endFrame();
  }

  // ── composition ───────────────────────────────────────────────────────────

  private renderComp(comp: Composition, time: number, parent: CompCtx): Tex {
    const glc = this.glc;
    const W = Math.max(1, Math.min(glc.maxTex, Math.round(comp.width * parent.scale)));
    const H = Math.max(1, Math.min(glc.maxTex, Math.round(comp.height * parent.scale)));
    const fmt = glc.format(comp.bitDepth);
    const cc: CompCtx = { ...parent, W, H, comp, fmt };
    const fe = new FrameEval(this.project, comp, time, 0, this.errors);
    const proj = this.projection(comp, fe, cc.view, cc.depth === 0 ? cc.view.kind : 'active');
    let accum = glc.acquire(W, H, fmt, true);
    const anySolo = comp.layers.some((l) => l.solo && VISUAL_TYPES.has(l.type));
    const items: Layer[] = [];
    for (let i = comp.layers.length - 1; i >= 0; i--) {
      const l = comp.layers[i];
      if (!this.shouldRender(l, fe, cc, anySolo, proj.active)) continue;
      items.push(l);
    }
    let i = 0;
    while (i < items.length) {
      const l = items[i];
      if (l.threeD && !l.adjustment) {
        let j = i;
        while (j < items.length && items[j].threeD && !items[j].adjustment) j++;
        const run = items.slice(i, j);
        const depthOf = (x: Layer) => {
          const w = M.transformPoint(fe.worldMatrix(x), fe.transformValues(x).anchor);
          return M.transformPoint(proj.view, w)[2];
        };
        const zs = new Map(run.map((x) => [x.id, depthOf(x)]));
        const order = run.map((x, k) => ({ x, k })).sort((a, b) => (zs.get(b.x.id)! - zs.get(a.x.id)!) || a.k - b.k).map((e) => e.x);
        const rb = glc.depthBuffer(W, H, cc.depth);
        const gl = glc.gl;
        // clear depth once for the run using a temporary attachment
        const tmp = glc.acquire(W, H, fmt, false);
        glc.attachDepth(tmp, rb);
        glc.bindTarget(tmp);
        gl.depthMask(true);
        gl.clearDepth(1);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        glc.attachDepth(tmp, null);
        glc.release(tmp);
        for (const x of order) accum = this.drawLayer(x, accum, fe, proj, cc, rb);
        i = j;
      } else {
        accum = this.drawLayer(l, accum, fe, proj, cc, null);
        i++;
      }
    }
    return accum;
  }

  private shouldRender(l: Layer, fe: FrameEval, cc: CompCtx, anySolo: boolean, activeView: boolean): boolean {
    if (!VISUAL_TYPES.has(l.type)) return false;
    if (!l.enabled) return false;
    if (!isActiveAt(l, fe.time)) return false;
    if (l.guide && (!cc.opts.guides || cc.depth > 0)) return false;
    if (anySolo && !l.solo) return false;
    if (!activeView && !l.threeD) return false;
    if (l.type === 'video') {
      const f = l.source?.footageId ? this.project.footage[l.source.footageId] : undefined;
      if (!f || !f.hasVideo) return false;
    }
    return true;
  }

  private projection(comp: Composition, fe: FrameEval, view: ViewSpec, kind: ViewKind): Projection {
    return computeProjection(comp, fe, { ...view, kind });
  }

  /** Output pixels per layer unit, estimated around the anchor point. */
  private screenScale(layer: Layer, fe: FrameEval, proj: Projection, cc: CompCtx, wm?: M.Mat4): number {
    const w = wm ?? fe.worldMatrix(layer);
    if (!layer.threeD) return Math.max(1e-3, M.maxScale(w)) * cc.scale;
    const a = fe.transformValues(layer).anchor;
    const toPx = (p: number[]) => {
      const c = M.transformVec4(proj.viewProj, [...M.transformPoint(w, p), 1]);
      if (c[3] <= 1e-3) return null;
      return [((c[0] / c[3] + 1) / 2) * cc.W, ((c[1] / c[3] + 1) / 2) * cc.H];
    };
    const p0 = toPx(a), p1 = toPx([a[0] + 100, a[1], a[2] ?? 0]), p2 = toPx([a[0], a[1] + 100, a[2] ?? 0]);
    if (!p0 || !p1 || !p2) return Math.max(1e-3, M.maxScale(w)) * cc.scale * 2;
    return Math.max(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), Math.hypot(p2[0] - p0[0], p2[1] - p0[1])) / 100;
  }

  // ── per-layer ─────────────────────────────────────────────────────────────

  private drawLayer(layer: Layer, accum: Tex, fe: FrameEval, proj: Projection, cc: CompCtx, rb: WebGLRenderbuffer | null): Tex {
    const glc = this.glc;
    if (layer.adjustment) return this.applyAdjustment(layer, accum, fe, proj, cc);
    let lt = this.layerToComp(layer, fe, proj, cc, rb, false);
    if (!lt) {
      if (layer.blendMode === 'stencilAlpha' || layer.blendMode === 'stencilLuma') lt = glc.acquire(cc.W, cc.H, cc.fmt, true);
      else return accum;
    }
    if (layer.trackMatte) {
      const ml = fe.layer(layer.trackMatte.layerId);
      const mt = ml && ml.id !== layer.id ? this.layerToComp(ml, fe, proj, cc, null, false, true) : null;
      const matted = glc.acquire(cc.W, cc.H, cc.fmt, false);
      const mode = ['alpha', 'alphaInverted', 'luma', 'lumaInverted'].indexOf(layer.trackMatte.mode);
      const empty = mt ?? glc.acquire(cc.W, cc.H, cc.fmt, true);
      const p = glc.program('matte', FS_MATTE);
      const src = lt;
      glc.pass(p, matted, (pp) => {
        pp.tex('u_src', src);
        pp.tex('u_matte', empty);
        pp.set('u_mode', mode);
      });
      glc.release(empty);
      glc.release(lt);
      lt = matted;
    }
    const out = glc.acquire(cc.W, cc.H, cc.fmt, false);
    const p = glc.program('composite', FS_COMPOSITE);
    const src = lt;
    glc.pass(p, out, (pp) => {
      pp.tex('u_dst', accum);
      pp.tex('u_src', src);
      pp.set('u_mode', BLEND_INDEX[layer.blendMode] ?? 0);
      pp.set('u_preserve', layer.preserveTransparency ? 1 : 0);
      pp.set('u_seed', fe.time * 31.7);
    });
    glc.release(accum);
    glc.release(lt);
    this.layersDrawn++;
    return out;
  }

  private layerToComp(
    layer: Layer, fe: FrameEval, proj: Projection, cc: CompCtx, rb: WebGLRenderbuffer | null, footprintOnly: boolean, asMatte = false,
  ): Tex | null {
    if (asMatte && !isActiveAt(layer, fe.time)) return null;
    const src = this.layerSource(layer, fe, proj, cc, footprintOnly);
    if (!src) return null;
    const glc = this.glc;
    const gl = glc.gl;
    const comp = cc.comp;
    const mbOn = !!cc.opts.motionBlur && comp.motionBlur && layer.motionBlur && !cc.opts.draft && comp.shutterAngle > 0;
    const samples = mbOn ? Math.max(2, Math.min(64, Math.round(comp.motionBlurSamples))) : 1;
    const outFmt: TexFormat = samples > 1 && glc.floatRender ? 'rgba16f' : cc.fmt;
    const out = glc.acquire(cc.W, cc.H, outFmt, true);
    const prog = glc.program('layer', FS_LAYER, VS_LAYER);
    const fd = 1 / exactFps(comp.frameRate);
    const times: number[] = [];
    if (samples > 1) {
      const start = fe.time + (comp.shutterPhase / 360) * fd;
      const span = (comp.shutterAngle / 360) * fd;
      for (let k = 0; k < samples; k++) times.push(start + (span * k) / (samples - 1));
    } else times.push(fe.time);

    // lights
    const lights = layer.threeD && proj.active && layer.material.acceptsLights ? fe.lights() : [];
    const lit = lights.length > 0 && layer.threeD;
    const amb = [0, 0, 0];
    const lPos: number[] = [], lDir: number[] = [], lCol: number[] = [], lPar: number[] = [];
    let nLights = 0;
    for (const L of lights) {
      if (L.kind === 'ambient') {
        amb[0] += L.color[0]; amb[1] += L.color[1]; amb[2] += L.color[2];
        continue;
      }
      if (nLights >= 8) continue;
      const type = L.kind === 'parallel' ? 0 : L.kind === 'spot' ? 1 : 2;
      const half = (Math.min(179, Math.max(0.5, L.coneAngle)) / 2) * (Math.PI / 180);
      lPos.push(L.position[0], L.position[1], L.position[2], type);
      lDir.push(L.direction[0], L.direction[1], L.direction[2], Math.cos(half));
      lCol.push(L.color[0], L.color[1], L.color[2], 0);
      lPar.push(L.falloff === 'none' ? 0 : L.falloff === 'smooth' ? 1 : 2, L.radius, L.falloffDistance, Math.cos(half * (1 - Math.min(1, L.coneFeather))));
      nLights++;
    }
    while (lPos.length < 32) { lPos.push(0); lDir.push(0); lCol.push(0); lPar.push(0); }
    const mat = layer.material;
    const material = [
      fe.prop(layer, 'material.ambient', mat.ambient) / 100,
      fe.prop(layer, 'material.diffuse', mat.diffuse) / 100,
      fe.prop(layer, 'material.specularIntensity', mat.specularIntensity) / 100,
      fe.prop(layer, 'material.specularShininess', mat.specularShininess) / 100,
    ];
    const metal = fe.prop(layer, 'material.metal', mat.metal) / 100;

    // depth of field
    let blurTex: Tex | null = null;
    let src2 = src;
    let dof = false, cocScale = 0, cocMax = 0, focus = 0;
    const cam = proj.cam;
    if (layer.threeD && proj.active && cam && cam.depthOfField && cam.aperture > 0 && !cc.opts.draft) {
      const w = fe.worldMatrix(layer);
      const r = src.rect;
      const corners = [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]].map(
        (c) => M.transformPoint(cam.view, M.transformPoint(w, [c[0], c[1], 0]))[2],
      );
      focus = cam.focusDistance;
      cocScale = cam.aperture * (cam.blurLevel / 100) * cc.scale;
      cocMax = Math.max(...corners.map((z) => (Math.abs(Math.max(z, 1) - focus) / Math.max(z, 1)) * cocScale));
      if (cocMax > 0.4) {
        dof = true;
        const outPxPerUnit = this.screenScale(layer, fe, proj, cc, w);
        const texPerOut = src.scale / Math.max(1e-4, outPxPerUnit);
        const sigmaTex = Math.min(120, 0.5 * cocMax * texPerOut);
        src2 = this.padImage({ ...src, owned: false }, (sigmaTex * 3) / src.scale);
        blurTex = gaussianBlur(glc, src2.tex, sigmaTex, cc.fmt);
      }
    }

    const viewProjFor = (feS: FrameEval): M.Mat4 => {
      if (!layer.threeD) return proj.ortho2D;
      if (!proj.active) return proj.viewProj;
      if (feS === fe) return proj.viewProj;
      const c = feS.camera();
      return M.multiply(M.perspectiveAE(comp.width, comp.height, c.zoom, 1, 200000), c.view);
    };

    const useDepth = !!rb && layer.threeD;
    if (useDepth) {
      glc.attachDepth(out, rb);
      gl.enable(gl.DEPTH_TEST);
      // LEQUAL: coplanar layers drawn later (higher in the stack) win, matching AE's ordering
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(false);
    }
    const weight = 1 / samples;
    for (const ts of times) {
      const feS = samples > 1 ? new FrameEval(this.project, comp, ts) : fe;
      const model = feS.worldMatrix(layer);
      const opacity = (footprintOnly ? 1 : feS.opacity(layer)) * weight;
      if (opacity <= 0) continue;
      const vp = viewProjFor(feS);
      const normal = M.transformDir(model, [0, 0, -1]);
      glc.pass(prog, out, (p) => {
        p.tex('u_src', src2.tex);
        p.tex('u_srcBlur', blurTex ?? src2.tex);
        p.set('u_rect', [src2.rect.x, src2.rect.y, src2.rect.w, src2.rect.h]);
        p.set('u_model', M.toFloat32(model));
        p.set('u_viewProj', M.toFloat32(vp));
        p.set('u_view', M.toFloat32(layer.threeD ? proj.view : M.identity()));
        p.set('u_opacity', opacity);
        p.set('u_dof', dof ? 1 : 0);
        p.set('u_focus', focus);
        p.set('u_cocScale', cocScale);
        p.set('u_cocMax', cocMax);
        p.set('u_lit', lit ? 1 : 0);
        p.set('u_numLights', nLights);
        p.set('u_lightPos', lPos);
        p.set('u_lightDir', lDir);
        p.set('u_lightColor', lCol);
        p.set('u_lightParams', lPar);
        p.set('u_ambient', amb);
        p.set('u_normal', normal);
        p.set('u_camPos', proj.camPos);
        p.set('u_material', material);
        p.set('u_metal', metal);
        p.set('u_alphaCut', 0);
      }, { blend: samples > 1 ? 'add' : 'none' });
    }
    if (useDepth) {
      // write this layer's depth for later (nearer) layers in the run
      gl.depthMask(true);
      gl.colorMask(false, false, false, false);
      const dp = glc.program('depth', FS_DEPTH, VS_LAYER);
      const model = fe.worldMatrix(layer);
      glc.pass(dp, out, (p) => {
        p.tex('u_src', src2.tex);
        p.set('u_rect', [src2.rect.x, src2.rect.y, src2.rect.w, src2.rect.h]);
        p.set('u_model', M.toFloat32(model));
        p.set('u_viewProj', M.toFloat32(proj.viewProj));
        p.set('u_view', M.toFloat32(proj.view));
      });
      gl.colorMask(true, true, true, true);
      gl.disable(gl.DEPTH_TEST);
      glc.attachDepth(out, null);
    }
    if (blurTex) glc.release(blurTex);
    if (src2 !== src && src2.owned) glc.release(src2.tex);
    if (src.owned) glc.release(src.tex);
    if (outFmt !== cc.fmt) {
      const conv = glc.acquire(cc.W, cc.H, cc.fmt, false);
      copyTex(glc, out, conv);
      glc.release(out);
      return conv;
    }
    return out;
  }

  // ── sources ───────────────────────────────────────────────────────────────

  private layerSource(layer: Layer, fe: FrameEval, proj: Projection, cc: CompCtx, skipEffects: boolean): LayerImage | null {
    const glc = this.glc;
    const ss = this.screenScale(layer, fe, proj, cc);
    let img: LayerImage | null = null;
    switch (layer.type) {
      case 'solid': {
        const sd = layer.solid ?? { color: [1, 1, 1, 1] as RGBA, width: 100, height: 100 };
        const s = Math.max(0.02, Math.min(4, ss));
        const w = Math.max(1, Math.min(glc.maxTex, Math.ceil(sd.width * s)));
        const h = Math.max(1, Math.min(glc.maxTex, Math.ceil(sd.height * s)));
        const tex = glc.acquire(w, h, cc.fmt, false);
        const c = sd.color;
        glc.clear(tex, skipEffects ? [1, 1, 1, 1] : [c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]]);
        img = { tex, rect: { x: 0, y: 0, w: sd.width, h: sd.height }, scale: w / sd.width, owned: true };
        break;
      }
      case 'image': {
        const fid = layer.source?.footageId;
        const f = fid ? this.project.footage[fid] : undefined;
        if (!f) return null;
        const tex = this.imageTexture(f);
        if (!tex) return null;
        img = { tex, rect: { x: 0, y: 0, w: f.width, h: f.height }, scale: tex.w / f.width, owned: false };
        break;
      }
      case 'video': {
        const fid = layer.source?.footageId;
        const f = fid ? this.project.footage[fid] : undefined;
        if (!f) return null;
        const tex = this.videoTexture(f, footageTime(f, fe.sourceTime(layer)));
        if (!tex) return null;
        img = { tex, rect: { x: 0, y: 0, w: f.width, h: f.height }, scale: tex.w / f.width, owned: false };
        break;
      }
      case 'precomp': {
        const nested = layer.source?.compId ? this.project.comps[layer.source.compId] : undefined;
        if (!nested || cc.depth > 10) return null;
        const st = fe.sourceTime(layer);
        const ns = Math.max(0.02, Math.min(layer.collapse ? 4 : Math.max(1, cc.scale), ss));
        const qs = Math.pow(2, Math.round(Math.log2(ns) * 6) / 6);
        const key = `${nested.id}@${st.toFixed(5)}@${qs.toFixed(4)}`;
        let tex = cc.frameCache.get(key);
        if (!tex) {
          tex = this.renderComp(nested, st, { ...cc, scale: qs, depth: cc.depth + 1, view: { kind: 'active' } });
          cc.frameCache.set(key, tex);
        }
        img = { tex, rect: { x: 0, y: 0, w: nested.width, h: nested.height }, scale: tex.w / nested.width, owned: false };
        break;
      }
      case 'shape':
        img = this.rasterShape(layer, fe, ss);
        break;
      case 'text':
        img = this.rasterText(layer, fe, ss);
        break;
      default:
        return null;
    }
    if (!img) return null;
    if (layer.masks.some((m) => m.mode !== 'none')) img = this.applyMasks(layer, fe, img, cc.fmt, ss);
    if (!skipEffects && layer.effectsEnabled && layer.effects.some((e) => e.enabled && !PASSTHROUGH_EFFECTS.has(e.type))) {
      img = this.applyEffects(layer, fe, img, cc, ss);
    }
    return img;
  }

  private imageTexture(f: Footage): Tex | null {
    const e = this.imageTex.get(f.id);
    const bmp = this.assets.image(f.id);
    if (!bmp) return null;
    if (e && e.bitmap === bmp) return e.tex;
    if (e) this.glc.deleteTex(e.tex);
    const tex = this.glc.createUploadTexture();
    this.glc.upload(tex, bmp, bmp.width, bmp.height, { premultiply: f.interpret.alpha !== 'premultiplied', mipmaps: true });
    this.imageTex.set(f.id, { tex, bitmap: bmp });
    return tex;
  }

  private videoTexture(f: Footage, t: number): Tex | null {
    const fr = this.assets.videoFrame(f.id, t);
    if (!fr) return this.videoTex.get(f.id)?.tex ?? null;
    let e = this.videoTex.get(f.id);
    if (e && e.key === fr.key) return e.tex;
    if (!e) {
      e = { tex: this.glc.createUploadTexture(), key: '' };
      this.videoTex.set(f.id, e);
    }
    try {
      this.glc.upload(e.tex, fr.frame, fr.w, fr.h, { premultiply: true, mipmaps: false });
      e.key = fr.key;
    } catch {
      return null;
    }
    return e.tex;
  }

  private quantScale(s: number): number {
    return Math.pow(2, Math.round(Math.log2(Math.max(0.02, Math.min(8, s))) * 8) / 8);
  }

  private uploadRaster(layerId: string, key: number, canvas: AnyCanvas, w: number, h: number, rect: Rect, scale: number): LayerImage {
    let e = this.raster.get(layerId);
    if (!e) {
      e = { key, tex: this.glc.createUploadTexture(), rect, scale, frame: this.frameNo };
      this.raster.set(layerId, e);
    }
    this.glc.upload(e.tex, canvas as TexImageSource, w, h, { premultiply: true });
    e.key = key;
    e.rect = rect;
    e.scale = scale;
    e.frame = this.frameNo;
    return { tex: e.tex, rect, scale, owned: false };
  }

  private rasterShape(layer: Layer, fe: FrameEval, ss: number): LayerImage | null {
    if (!layer.shape) return null;
    const lt = toLayerTime(layer, fe.time);
    const draws = evaluateShapeContents(layer.shape.contents, (p, path, spatial) => fe.prop(layer, path, p, spatial), lt);
    if (!draws.length) return null;
    const scale = this.quantScale(ss);
    let key = hashAny(2166136261, scale);
    for (const d of draws) {
      key = hashAny(key, [d.kind, d.color, d.opacity, d.width, d.lineCap, d.lineJoin, d.dash, d.dashOffset, d.blendMode, d.fillRule]);
      if (d.gradient) key = hashAny(key, d.gradient as unknown as object);
      for (const e of d.entries) {
        key = hashNumbers(key, e.hidden ? 1 : 0);
        for (const p of e.paths) key = hashAny(key, [p.v, p.i, p.o, p.closed]);
      }
    }
    const cached = this.raster.get(layer.id);
    if (cached && cached.key === key) {
      cached.frame = this.frameNo;
      return { tex: cached.tex, rect: cached.rect, scale: cached.scale, owned: false };
    }
    const r = rasterizeDrawOps(draws, scale, this.canvases, this.glc.maxTex);
    if (!r) return null;
    return this.uploadRaster(layer.id, key, r.canvas, r.width, r.height, r.bounds, r.scale);
  }

  private rasterText(layer: Layer, fe: FrameEval, ss: number): LayerImage | null {
    if (!layer.text) return null;
    const lt = toLayerTime(layer, fe.time);
    const res = evaluateText(layer.text, (p, path) => fe.prop(layer, path, p), lt, this.measure);
    if (!res.glyphs.length) return null;
    const scale = this.quantScale(ss);
    let key = hashAny(2166136261, scale);
    key = hashAny(key, layer.text.document as unknown as object);
    key = hashAny(key, res.text);
    for (const g of res.glyphs) {
      key = hashAny(key, [g.glyph.x, g.glyph.y, g.dx, g.dy, g.ax, g.ay, g.sx, g.sy, g.rot, g.skew, g.opacity, g.fill, g.stroke, g.strokeWidth, g.blur]);
    }
    const cached = this.raster.get(layer.id);
    if (cached && cached.key === key) {
      cached.frame = this.frameNo;
      return { tex: cached.tex, rect: cached.rect, scale: cached.scale, owned: false };
    }
    const r = rasterizeText(res, layer.text.document, scale, this.canvases, this.glc.maxTex);
    if (!r) return null;
    return this.uploadRaster(layer.id, key, r.canvas, r.width, r.height, r.bounds, r.scale);
  }

  private evictRasters(): void {
    for (const [id, e] of this.raster) {
      if (this.frameNo - e.frame > 600) {
        this.glc.deleteTex(e.tex);
        this.raster.delete(id);
      }
    }
  }

  // ── image helpers ─────────────────────────────────────────────────────────

  /** Copy an image into an owned pooled texture at the given scale. */
  private ownCopy(img: LayerImage, scale: number, format: TexFormat = img.tex.format): LayerImage {
    const glc = this.glc;
    const s = Math.max(0.01, scale);
    const w = Math.max(1, Math.min(glc.maxTex, Math.ceil(img.rect.w * s)));
    const h = Math.max(1, Math.min(glc.maxTex, Math.ceil(img.rect.h * s)));
    const tex = glc.acquire(w, h, format, false);
    copyTex(glc, img.tex, tex);
    if (img.owned) glc.release(img.tex);
    return { tex, rect: { ...img.rect }, scale: w / img.rect.w, owned: true };
  }

  private padImage(img: LayerImage, padUnits: number): LayerImage {
    const glc = this.glc;
    const pw = Math.ceil(padUnits * img.scale);
    if (pw <= 0) return img;
    const maxPad = Math.floor((glc.maxTex - Math.max(img.tex.w, img.tex.h)) / 2);
    const p = Math.max(0, Math.min(pw, maxPad));
    if (p <= 0) return img;
    const W = img.tex.w + p * 2, H = img.tex.h + p * 2;
    const out = glc.acquire(W, H, img.tex.format, true);
    copyTex(glc, img.tex, out, [p, p, img.tex.w, img.tex.h]);
    if (img.owned) glc.release(img.tex);
    const s = img.scale;
    return { tex: out, rect: { x: img.rect.x - p / s, y: img.rect.y - p / s, w: W / s, h: H / s }, scale: s, owned: true };
  }

  // ── masks ─────────────────────────────────────────────────────────────────

  private applyMasks(layer: Layer, fe: FrameEval, img0: LayerImage, fmt: TexFormat, ss: number): LayerImage {
    const glc = this.glc;
    const img = img0.owned ? img0 : this.ownCopy(img0, Math.min(img0.scale, Math.max(ss * 1.25, 0.05)), fmt);
    const W = img.tex.w, H = img.tex.h;
    const s = img.scale;
    const r = img.rect;
    const { canvas, ctx } = this.canvases.get(W, H);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    ctx.clearRect(0, 0, W, H);
    const masks = layer.masks.filter((m) => m.mode !== 'none');
    if (masks[0] && (masks[0].mode === 'subtract' || masks[0].mode === 'intersect' || masks[0].mode === 'darken')) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, W, H);
    }
    const OPS: Record<string, GlobalCompositeOperation> = {
      add: 'source-over', subtract: 'destination-out', intersect: 'destination-in', lighten: 'lighten', darken: 'darken', difference: 'xor',
    };
    for (const m of masks) {
      const path = fe.prop(layer, `masks.${m.id}.path`, m.path);
      const feather = fe.prop(layer, `masks.${m.id}.feather`, m.feather);
      const opacity = Math.max(0, Math.min(100, fe.prop(layer, `masks.${m.id}.opacity`, m.opacity))) / 100;
      const expansion = fe.prop(layer, `masks.${m.id}.expansion`, m.expansion);
      const sc = this.canvases.scratch(W, H);
      const sx = sc.ctx;
      sx.setTransform(1, 0, 0, 1, 0, 0);
      sx.globalCompositeOperation = 'source-over';
      sx.globalAlpha = 1;
      sx.filter = 'none';
      sx.clearRect(0, 0, W, H);
      sx.setTransform(s, 0, 0, s, -r.x * s, -r.y * s);
      sx.fillStyle = '#fff';
      sx.strokeStyle = '#fff';
      sx.lineJoin = 'round';
      sx.beginPath();
      if (path && path.v.length > 1) tracePath(sx, { ...path, closed: true });
      sx.fill();
      if (expansion > 0) {
        sx.lineWidth = expansion * 2;
        sx.stroke();
      } else if (expansion < 0) {
        sx.globalCompositeOperation = 'destination-out';
        sx.lineWidth = -expansion * 2;
        sx.stroke();
        sx.globalCompositeOperation = 'source-over';
      }
      if (m.inverted) {
        sx.setTransform(1, 0, 0, 1, 0, 0);
        sx.globalCompositeOperation = 'xor';
        sx.fillRect(0, 0, W, H);
        sx.globalCompositeOperation = 'source-over';
      }
      ctx.save();
      ctx.globalAlpha = opacity;
      ctx.globalCompositeOperation = OPS[m.mode] ?? 'source-over';
      const fpx = ((Math.abs(feather[0]) + Math.abs(feather[1])) / 2) * s;
      if (fpx > 0.3) ctx.filter = `blur(${(fpx / 2).toFixed(2)}px)`;
      ctx.drawImage(sc.canvas as CanvasImageSource, 0, 0);
      ctx.restore();
    }
    if (!this.maskUpload) this.maskUpload = glc.createUploadTexture();
    glc.upload(this.maskUpload, canvas as TexImageSource, W, H, { premultiply: true });
    const out = glc.acquire(W, H, img.tex.format, false);
    const p = glc.program('maskApply', FS_MASK_APPLY);
    const src = img.tex;
    const mt = this.maskUpload;
    glc.pass(p, out, (pp) => {
      pp.tex('u_src', src);
      pp.tex('u_mask', mt);
    });
    glc.release(img.tex);
    return { tex: out, rect: img.rect, scale: img.scale, owned: true };
  }

  // ── roto mattes ───────────────────────────────────────────────────────────

  /** Upload (and LRU-cache) a matte revision as an RGBA texture whose every channel is the alpha. */
  private matteTexture(id: string, rev: number): Tex | null {
    const m = this.assets.matte?.(id, rev);
    if (!m) return null;
    let t = this.matteTex.get(m.key);
    if (t) {
      this.matteTex.delete(m.key);
      this.matteTex.set(m.key, t);
      return t;
    }
    const rgba = new Uint8Array(m.w * m.h * 4);
    for (let i = 0, j = 0; i < m.data.length; i++, j += 4) rgba[j] = rgba[j + 1] = rgba[j + 2] = rgba[j + 3] = m.data[i];
    t = this.glc.createUploadTexture();
    this.glc.uploadPixels(t, rgba, m.w, m.h);
    this.matteTex.set(m.key, t);
    while (this.matteTex.size > 6) {
      const [k, old] = this.matteTex.entries().next().value as [string, Tex];
      this.glc.deleteTex(old);
      this.matteTex.delete(k);
    }
    return t;
  }

  // ── effects ───────────────────────────────────────────────────────────────

  private audioAccess(fe: FrameEval): AudioAccess {
    return {
      samples: (layerId, compTime, duration) => {
        const l = fe.layer(layerId);
        const fid = l?.source?.footageId;
        if (!l || !fid) return null;
        const f = this.project.footage[fid];
        if (!f || !f.hasAudio) return null;
        const st = (compTime - l.startTime) / (l.stretch / 100 || 1);
        return this.assets.audioSamples(fid, st, duration);
      },
    };
  }

  private applyEffects(layer: Layer, fe: FrameEval, img0: LayerImage, cc: CompCtx, ss: number): LayerImage {
    const glc = this.glc;
    let cur = img0;
    const desired = Math.max(0.02, Math.min(cur.scale, ss * 1.15));
    for (const fx of layer.effects) {
      if (!fx.enabled || PASSTHROUGH_EFFECTS.has(fx.type)) continue;
      const impl = EFFECT_IMPLS[fx.type];
      if (!impl) continue;
      const params: Record<string, unknown> = {};
      for (const [pid, p] of Object.entries(fx.params)) params[pid] = fe.prop(layer, `effects.${fx.id}.params.${pid}`, p);
      if (!cur.owned) cur = this.ownCopy(cur, desired, cc.fmt);
      const pad = impl.pad ? impl.pad(params, { scale: cur.scale, rect: cur.rect }) : 0;
      if (pad * cur.scale >= 1) cur = this.padImage(cur, pad);
      const ctx: FxCtx = {
        glc, fe, layer, time: fe.time, rect: cur.rect, scale: cur.scale, params, format: cur.tex.format,
        canvas: this.canvases, audio: this.audioAccess(fe), fps: exactFps(cc.comp.frameRate),
        matte: (id, rev) => this.matteTexture(id, rev),
      };
      let out: Tex;
      try {
        out = impl.render(ctx, cur.tex);
      } catch (e) {
        this.errors.set(`${layer.id}|effects.${fx.id}`, (e as Error).message);
        continue;
      }
      if (out !== cur.tex) {
        const rect = impl.outRect
          ? (() => {
            const nr = impl.outRect!(params, cur.rect);
            return { x: nr.x, y: nr.y, w: out.w / cur.scale, h: out.h / cur.scale };
          })()
          : cur.rect;
        glc.release(cur.tex);
        cur = { tex: out, rect, scale: cur.scale, owned: true };
      }
    }
    return cur;
  }

  // ── adjustment layers ─────────────────────────────────────────────────────

  private applyAdjustment(layer: Layer, accum: Tex, fe: FrameEval, proj: Projection, cc: CompCtx): Tex {
    const glc = this.glc;
    if (!layer.effectsEnabled || !layer.effects.some((e) => e.enabled && !PASSTHROUGH_EFFECTS.has(e.type))) return accum;
    const foot = this.layerToComp(layer, fe, proj, cc, null, true);
    if (!foot) return accum;
    const work = glc.acquire(cc.W, cc.H, cc.fmt, false);
    copyTex(glc, accum, work);
    const comp = cc.comp;
    let img: LayerImage = { tex: work, rect: { x: 0, y: 0, w: comp.width, h: comp.height }, scale: cc.W / comp.width, owned: true };
    img = this.applyEffects(layer, fe, img, cc, cc.scale);
    // crop back to comp rect
    let processed = img.tex;
    if (img.rect.x !== 0 || img.rect.y !== 0 || img.tex.w !== cc.W || img.tex.h !== cc.H) {
      const crop = glc.acquire(cc.W, cc.H, cc.fmt, true);
      copyTex(glc, img.tex, crop, [Math.round(img.rect.x * img.scale), Math.round(img.rect.y * img.scale), img.tex.w, img.tex.h]);
      glc.release(img.tex);
      processed = crop;
    }
    const out = glc.acquire(cc.W, cc.H, cc.fmt, false);
    const p = glc.program('mix', FS_MIX);
    const opacity = fe.opacity(layer);
    glc.pass(p, out, (pp) => {
      pp.tex('u_a', accum);
      pp.tex('u_b', processed);
      pp.tex('u_mask', foot);
      pp.set('u_amount', opacity);
      pp.set('u_useMask', 1);
    });
    glc.release(processed);
    glc.release(foot);
    glc.release(accum);
    this.layersDrawn++;
    return out;
  }
}
