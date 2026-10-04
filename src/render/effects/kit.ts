// Effect execution context and shared GPU helpers (blur pyramid, LUT textures, passes).

import type { GLContext, Program, Tex, TexFormat } from '../gl/gl';
import { FS_BLUR, FS_COPY, FS_DOWN, FS_UP, HEADER } from '../gl/shaders';
import type { FrameEval } from '../../core/evaluate';
import type { CurvesValue, GradientStop, Layer, Vec2 } from '../../core/types';
import type { CanvasProvider } from '../../shapes/rasterize';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AudioAccess {
  /** Mono samples (averaged channels) for an audio-capable layer starting at comp time t. */
  samples(layerId: string, compTime: number, duration: number): { data: Float32Array; sampleRate: number } | null;
}

export interface FxCtx {
  glc: GLContext;
  fe: FrameEval;
  layer: Layer;
  /** composition time */
  time: number;
  /** layer-space rectangle covered by the input texture */
  rect: Rect;
  /** texture pixels per layer unit */
  scale: number;
  params: Record<string, any>;
  format: TexFormat;
  canvas: CanvasProvider;
  audio: AudioAccess;
  /** frames per second of the comp */
  fps: number;
  /** roto matte revision as an RGBA texture (all channels = alpha); owned by the renderer, do not release */
  matte: (matteId: string, rev: number) => Tex | null;
}

export interface EffectImpl {
  /** padding in LAYER units the effect needs around the current rect */
  pad?(p: Record<string, any>, ctx: { scale: number; rect: Rect }): number;
  /** custom output rect (e.g. Corner Pin); when provided the effect must render into a texture of this rect */
  outRect?(p: Record<string, any>, rect: Rect): Rect;
  render(ctx: FxCtx, input: Tex): Tex;
}

export function prog(ctx: FxCtx | GLContext, name: string, fs: string): Program {
  const glc = 'glc' in ctx ? ctx.glc : ctx;
  return glc.program(name, fs);
}

/** Standard uniforms for effect shaders. */
export function stdUniforms(p: Program, ctx: FxCtx, t: Tex): void {
  p.set('u_texSize', [t.w, t.h]);
  p.set('u_texel', [1 / t.w, 1 / t.h]);
  p.set('u_rect', [ctx.rect.x, ctx.rect.y, ctx.rect.w, ctx.rect.h]);
  p.set('u_scale', ctx.scale);
  p.set('u_time', ctx.time);
}

/** Layer-space point → texture uv (row 0 at top, matching our texture convention). */
export function toUv(ctx: FxCtx, pt: number[] | Vec2): [number, number] {
  return [(pt[0] - ctx.rect.x) / ctx.rect.w, (pt[1] - ctx.rect.y) / ctx.rect.h];
}

export function runPass(ctx: FxCtx, name: string, fs: string, input: Tex | null, setup: (p: Program) => void, out?: Tex): Tex {
  const glc = ctx.glc;
  const ref = input ?? out!;
  const target = out ?? glc.acquire(ref.w, ref.h, ctx.format, false);
  const p = glc.program(name, fs);
  glc.pass(p, target, (pp) => {
    if (input) pp.tex('u_src', input);
    stdUniforms(pp, ctx, ref);
    setup(pp);
  });
  return target;
}

export function copyTex(glc: GLContext, src: Tex, dst: Tex, viewport?: [number, number, number, number], opacity = 1): void {
  const p = glc.program('copy', FS_COPY);
  glc.pass(p, dst, (pp) => {
    pp.tex('u_src', src);
    pp.set('u_opacity', opacity);
  }, { viewport });
}

/** Gaussian blur with automatic downsampling for large radii. Returns a new texture (same size). */
export function gaussianBlur(glc: GLContext, src: Tex, sigma: number, format: TexFormat, dims: 'both' | 'h' | 'v' = 'both'): Tex {
  const blurP = glc.program('blur', FS_BLUR);
  if (sigma < 0.3) {
    const out = glc.acquire(src.w, src.h, format, false);
    copyTex(glc, src, out);
    return out;
  }
  // downsample until sigma is manageable
  const chain: Tex[] = [];
  let cur = src;
  let s = sigma;
  while (s > 10 && cur.w > 16 && cur.h > 16) {
    const nw = Math.max(1, Math.ceil(cur.w / 2)), nh = Math.max(1, Math.ceil(cur.h / 2));
    const d = glc.acquire(nw, nh, format, false);
    const p = glc.program('down', FS_DOWN);
    const c = cur;
    glc.pass(p, d, (pp) => {
      pp.tex('u_src', c);
      pp.set('u_texel', [0.5 / c.w, 0.5 / c.h]);
    });
    chain.push(d);
    cur = d;
    s /= 2;
  }
  const tmp = glc.acquire(cur.w, cur.h, format, false);
  const res = glc.acquire(cur.w, cur.h, format, false);
  const src0 = cur;
  if (dims === 'v') {
    copyTex(glc, src0, tmp);
  } else {
    glc.pass(blurP, tmp, (pp) => {
      pp.tex('u_src', src0);
      pp.set('u_dir', [1 / src0.w, 0]);
      pp.set('u_sigma', s);
    });
  }
  if (dims === 'h') {
    copyTex(glc, tmp, res);
  } else {
    glc.pass(blurP, res, (pp) => {
      pp.tex('u_src', tmp);
      pp.set('u_dir', [0, 1 / tmp.h]);
      pp.set('u_sigma', s);
    });
  }
  glc.release(tmp);
  // upsample back through the chain
  let up = res;
  for (let k = chain.length - 1; k >= 0; k--) {
    const targetSize = k === 0 ? src : chain[k - 1];
    const u = glc.acquire(targetSize.w, targetSize.h, format, false);
    const p = glc.program('up', FS_UP);
    const from = up;
    glc.pass(p, u, (pp) => {
      pp.tex('u_src', from);
      pp.set('u_texel', [1 / from.w, 1 / from.h]);
    });
    glc.release(from);
    up = u;
  }
  for (const c of chain) glc.release(c);
  return up;
}

// ── LUTs ────────────────────────────────────────────────────────────────────

/** Monotone cubic (Fritsch–Carlson) interpolation of sorted control points, sampled to n values. */
export function sampleCurve(points: Vec2[] | [number, number][], n = 256): Float32Array {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  const out = new Float32Array(n);
  if (pts.length === 0) {
    for (let i = 0; i < n; i++) out[i] = i / (n - 1);
    return out;
  }
  if (pts.length === 1) {
    out.fill(pts[0][1]);
    return out;
  }
  const m = pts.length;
  const d: number[] = [], ms: number[] = new Array(m).fill(0);
  for (let k = 0; k < m - 1; k++) d.push((pts[k + 1][1] - pts[k][1]) / Math.max(1e-6, pts[k + 1][0] - pts[k][0]));
  ms[0] = d[0];
  ms[m - 1] = d[m - 2];
  for (let k = 1; k < m - 1; k++) ms[k] = d[k - 1] * d[k] <= 0 ? 0 : (d[k - 1] + d[k]) / 2;
  for (let k = 0; k < m - 1; k++) {
    if (Math.abs(d[k]) < 1e-9) { ms[k] = 0; ms[k + 1] = 0; continue; }
    const a = ms[k] / d[k], b = ms[k + 1] / d[k];
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      ms[k] = t * a * d[k];
      ms[k + 1] = t * b * d[k];
    }
  }
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    let k = 0;
    if (x <= pts[0][0]) { out[i] = pts[0][1]; continue; }
    if (x >= pts[m - 1][0]) { out[i] = pts[m - 1][1]; continue; }
    while (k < m - 2 && x > pts[k + 1][0]) k++;
    const x0 = pts[k][0], x1 = pts[k + 1][0];
    const h = x1 - x0;
    const t = (x - x0) / h;
    const t2 = t * t, t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
    out[i] = h00 * pts[k][1] + h10 * h * ms[k] + h01 * pts[k + 1][1] + h11 * h * ms[k + 1];
  }
  return out;
}

const lutCache = new Map<string, Tex>();

function lutTexture(glc: GLContext, key: string, build: () => Uint8Array): Tex {
  let t = lutCache.get(key);
  if (!t) {
    t = glc.createUploadTexture();
    glc.uploadPixels(t, build(), 256, 1);
    if (lutCache.size > 64) {
      const first = lutCache.keys().next().value as string;
      glc.deleteTex(lutCache.get(first)!);
      lutCache.delete(first);
    }
    lutCache.set(key, t);
  }
  return t;
}

/** RGBA LUT: R,G,B channels hold per-channel curves already composed with the master curve; A holds alpha curve. */
export function curvesLut(glc: GLContext, c: CurvesValue): Tex {
  return lutTexture(glc, 'curves:' + JSON.stringify(c), () => {
    const master = sampleCurve(c.rgb), r = sampleCurve(c.r), g = sampleCurve(c.g), b = sampleCurve(c.b), a = sampleCurve(c.a);
    const at = (lut: Float32Array, x: number) => lut[Math.max(0, Math.min(255, Math.round(x * 255)))];
    const data = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      data[i * 4] = Math.round(Math.max(0, Math.min(1, at(master, r[i]))) * 255);
      data[i * 4 + 1] = Math.round(Math.max(0, Math.min(1, at(master, g[i]))) * 255);
      data[i * 4 + 2] = Math.round(Math.max(0, Math.min(1, at(master, b[i]))) * 255);
      data[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, a[i])) * 255);
    }
    return data;
  });
}

/** Gradient palette LUT (straight colors, alpha in A). */
export function gradientLut(glc: GLContext, stops: GradientStop[]): Tex {
  return lutTexture(glc, 'grad:' + JSON.stringify(stops), () => {
    const s = [...stops].sort((a, b) => a.p - b.p);
    const data = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      const x = i / 255;
      let c = s[0]?.c ?? [0, 0, 0, 1];
      if (s.length > 1) {
        if (x <= s[0].p) c = s[0].c;
        else if (x >= s[s.length - 1].p) c = s[s.length - 1].c;
        else {
          let k = 0;
          while (k < s.length - 2 && x > s[k + 1].p) k++;
          const f = (x - s[k].p) / Math.max(1e-6, s[k + 1].p - s[k].p);
          c = [0, 1, 2, 3].map((j) => s[k].c[j] + (s[k + 1].c[j] - s[k].c[j]) * f) as typeof c;
        }
      }
      for (let j = 0; j < 4; j++) data[i * 4 + j] = Math.round(Math.max(0, Math.min(1, c[j] ?? 1)) * 255);
    }
    return data;
  });
}

export const EFFECT_HEADER = `${HEADER}
in vec2 v_uv; out vec4 o;
uniform sampler2D u_src;
uniform vec2 u_texSize;
uniform vec2 u_texel;
uniform vec4 u_rect;
uniform float u_scale;
uniform float u_time;
vec2 layerPos(vec2 uv) { return u_rect.xy + uv * u_rect.zw; }
vec2 layerToUv(vec2 p) { return (p - u_rect.xy) / u_rect.zw; }
vec4 sampleClamp(vec2 uv) {
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0);
  return texture(u_src, uv);
}
`;
