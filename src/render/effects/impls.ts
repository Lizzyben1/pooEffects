// ─────────────────────────────────────────────────────────────────────────────
// GPU effect implementations. Every effect consumes a premultiplied texture
// covering `ctx.rect` (layer space) at `ctx.scale` pixels per layer unit and
// returns a texture of the same size (unless it declares `outRect`).
// ─────────────────────────────────────────────────────────────────────────────

import type { Tex } from '../gl/gl';
import { BLEND, BLEND_INDEX, COMMON, NOISE } from '../gl/shaders';
import { copyTex, curvesLut, EFFECT_HEADER, gaussianBlur, gradientLut, runPass, stdUniforms, toUv, type EffectImpl, type FxCtx, type Rect } from './kit';
import { PASSTHROUGH_EFFECTS } from '../../effects/catalog';
import { layerSourceSize } from '../../core/evaluate';
import { rgbaToCss } from '../../math/color';

const H = EFFECT_HEADER + COMMON;
const D2R = Math.PI / 180;
const blurSigma = (b: number) => Math.max(0, b) * 0.45;

function premulColor(c: number[]): number[] {
  const a = c[3] ?? 1;
  return [c[0] * a, c[1] * a, c[2] * a, a];
}

function sourceDims(ctx: FxCtx): { w: number; h: number } {
  return layerSourceSize(ctx.fe.project, ctx.fe.comp, ctx.layer);
}

// ── Blur & Sharpen ──────────────────────────────────────────────────────────

const gaussianBlurFx: EffectImpl = {
  pad: (p) => (p.repeatEdge ? 0 : blurSigma(p.blurriness) * 3),
  render(ctx, input) {
    const sigma = blurSigma(ctx.params.blurriness) * ctx.scale;
    if (sigma < 0.3) return input;
    return gaussianBlur(ctx.glc, input, sigma, ctx.format, ctx.params.dimensions ?? 'both');
  },
};

const FS_DIRBLUR = `${H}
uniform vec2 u_vec;
uniform int u_n;
void main() {
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 96; i++) {
    if (i >= u_n) break;
    float t = float(i) / float(u_n - 1) - 0.5;
    float w = 1.0 - abs(t) * 0.6;
    acc += sampleClamp(v_uv + u_vec * t) * w;
    wsum += w;
  }
  o = acc / wsum;
}`;

const directionalBlurFx: EffectImpl = {
  pad: (p) => Math.max(0, p.length),
  render(ctx, input) {
    const len = Math.max(0, ctx.params.length) * ctx.scale;
    if (len < 0.5) return input;
    const a = ctx.params.direction * D2R;
    const v = [(Math.sin(a) * len * 2) / input.w, (-Math.cos(a) * len * 2) / input.h];
    return runPass(ctx, 'fx_dirblur', FS_DIRBLUR, input, (p) => {
      p.set('u_vec', v);
      p.set('u_n', Math.max(8, Math.min(96, Math.ceil(len * 1.5))));
    });
  },
};

const FS_RADBLUR = `${H}
uniform vec2 u_center;
uniform float u_amount;
uniform int u_kind;
void main() {
  vec4 acc = vec4(0.0);
  const int N = 48;
  vec2 px = (v_uv - u_center) * u_texSize;
  for (int i = 0; i < N; i++) {
    float t = float(i) / float(N - 1) - 0.5;
    vec2 q;
    if (u_kind == 0) {
      float ang = t * u_amount * 0.0174533 * 2.0;
      float c = cos(ang), s = sin(ang);
      q = vec2(px.x * c - px.y * s, px.x * s + px.y * c);
    } else {
      q = px * (1.0 - t * u_amount * 0.01);
    }
    acc += sampleClamp(u_center + q / u_texSize);
  }
  o = acc / float(N);
}`;

const radialBlurFx: EffectImpl = {
  render(ctx, input) {
    if (ctx.params.amount <= 0.01) return input;
    return runPass(ctx, 'fx_radblur', FS_RADBLUR, input, (p) => {
      p.set('u_center', toUv(ctx, ctx.params.center));
      p.set('u_amount', ctx.params.amount);
      p.set('u_kind', ctx.params.kind === 'spin' ? 0 : 1);
    });
  },
};

const FS_SHARPEN = `${H}
uniform sampler2D u_blur;
uniform float u_amount;
void main() {
  vec4 c = texture(u_src, v_uv);
  vec4 b = texture(u_blur, v_uv);
  vec4 r = c + (c - b) * u_amount;
  r.a = c.a;
  o = vec4(clamp(r.rgb, vec3(0.0), vec3(r.a)), r.a);
}`;

const sharpenFx: EffectImpl = {
  render(ctx, input) {
    const amt = ctx.params.amount / 40;
    if (amt <= 0) return input;
    const b = gaussianBlur(ctx.glc, input, 1.2, ctx.format);
    const out = runPass(ctx, 'fx_sharpen', FS_SHARPEN, input, (p) => {
      p.tex('u_blur', b);
      p.set('u_amount', amt);
    });
    ctx.glc.release(b);
    return out;
  },
};

// ── Color Correction ────────────────────────────────────────────────────────

const FS_CURVES = `${H}
uniform sampler2D u_lut;
float lut(float x, int ch) {
  vec4 t = texture(u_lut, vec2(clamp(x, 0.0, 1.0) * 255.0 / 256.0 + 0.5 / 256.0, 0.5));
  return ch == 0 ? t.r : ch == 1 ? t.g : ch == 2 ? t.b : t.a;
}
void main() {
  vec4 c = unpremul(texture(u_src, v_uv));
  c = vec4(lut(c.r, 0), lut(c.g, 1), lut(c.b, 2), lut(c.a, 3));
  o = premul(c);
}`;

const curvesFx: EffectImpl = {
  render(ctx, input) {
    const lutTex = curvesLut(ctx.glc, ctx.params.curves);
    return runPass(ctx, 'fx_curves', FS_CURVES, input, (p) => p.tex('u_lut', lutTex));
  },
};

const FS_LEVELS = `${H}
uniform float u_inB, u_inW, u_gamma, u_outB, u_outW;
uniform int u_channel;
float lv(float x) {
  x = clamp((x - u_inB) / max(u_inW - u_inB, 1e-5), 0.0, 1.0);
  x = pow(x, 1.0 / max(u_gamma, 0.01));
  return mix(u_outB, u_outW, x);
}
void main() {
  vec4 c = unpremul(texture(u_src, v_uv));
  if (u_channel == 0) c.rgb = vec3(lv(c.r), lv(c.g), lv(c.b));
  else if (u_channel == 1) c.r = lv(c.r);
  else if (u_channel == 2) c.g = lv(c.g);
  else if (u_channel == 3) c.b = lv(c.b);
  else c.a = lv(c.a);
  o = premul(c);
}`;

const levelsFx: EffectImpl = {
  render(ctx, input) {
    const p0 = ctx.params;
    return runPass(ctx, 'fx_levels', FS_LEVELS, input, (p) => {
      p.set('u_inB', p0.inBlack / 255);
      p.set('u_inW', p0.inWhite / 255);
      p.set('u_gamma', p0.gamma);
      p.set('u_outB', p0.outBlack / 255);
      p.set('u_outW', p0.outWhite / 255);
      p.set('u_channel', ['rgb', 'r', 'g', 'b', 'a'].indexOf(p0.channel));
    });
  },
};

const FS_HUESAT = `${H}
uniform float u_hue, u_sat, u_light, u_cHue, u_cSat, u_cLight;
uniform int u_colorize;
void main() {
  vec4 c = unpremul(texture(u_src, v_uv));
  vec3 hsl = rgb2hsl(c.rgb);
  if (u_colorize == 1) {
    hsl.x = fract(u_cHue);
    hsl.y = u_cSat;
    hsl.z = u_cLight >= 0.0 ? hsl.z + (1.0 - hsl.z) * u_cLight : hsl.z * (1.0 + u_cLight);
  } else {
    hsl.x = fract(hsl.x + u_hue);
    hsl.y = clamp(hsl.y * (1.0 + u_sat), 0.0, 1.0);
    hsl.z = u_light >= 0.0 ? hsl.z + (1.0 - hsl.z) * u_light : hsl.z * (1.0 + u_light);
  }
  c.rgb = hsl2rgb(clamp(hsl, 0.0, 1.0));
  o = premul(c);
}`;

const hueSatFx: EffectImpl = {
  render(ctx, input) {
    const q = ctx.params;
    return runPass(ctx, 'fx_huesat', FS_HUESAT, input, (p) => {
      p.set('u_hue', q.hue / 360);
      p.set('u_sat', q.saturation / 100);
      p.set('u_light', q.lightness / 100);
      p.set('u_colorize', q.colorize ? 1 : 0);
      p.set('u_cHue', (((q.colorizeHue % 360) + 360) % 360) / 360);
      p.set('u_cSat', q.colorizeSaturation / 100);
      p.set('u_cLight', q.colorizeLightness / 100);
    });
  },
};

const FS_MIXER = `${H}
uniform vec4 u_r, u_g, u_b;
uniform int u_mono;
void main() {
  vec4 c = unpremul(texture(u_src, v_uv));
  float r = dot(c.rgb, u_r.xyz) + u_r.w;
  float g = dot(c.rgb, u_g.xyz) + u_g.w;
  float b = dot(c.rgb, u_b.xyz) + u_b.w;
  c.rgb = u_mono == 1 ? vec3(r) : vec3(r, g, b);
  o = premul(vec4(clamp(c.rgb, 0.0, 1.0), c.a));
}`;

const channelMixerFx: EffectImpl = {
  render(ctx, input) {
    const q = ctx.params;
    return runPass(ctx, 'fx_mixer', FS_MIXER, input, (p) => {
      p.set('u_r', [q.rr / 100, q.rg / 100, q.rb / 100, q.rc / 100]);
      p.set('u_g', [q.gr / 100, q.gg / 100, q.gb / 100, q.gc / 100]);
      p.set('u_b', [q.br / 100, q.bg / 100, q.bb / 100, q.bc / 100]);
      p.set('u_mono', q.monochrome ? 1 : 0);
    });
  },
};

const FS_COLORAMA = `${H}
uniform sampler2D u_pal;
uniform int u_input;
uniform float u_shift, u_cycles, u_blend;
void main() {
  vec4 c = unpremul(texture(u_src, v_uv));
  vec3 hsl = rgb2hsl(c.rgb);
  float ph = u_input == 0 ? lum709(c.rgb) : u_input == 1 ? c.r : u_input == 2 ? c.g : u_input == 3 ? c.b
    : u_input == 4 ? hsl.x : u_input == 5 ? hsl.z : u_input == 6 ? hsl.y : c.a;
  float x = fract(ph * u_cycles + u_shift);
  vec4 pc = texture(u_pal, vec2(x * 255.0 / 256.0 + 0.5 / 256.0, 0.5));
  vec3 rgb = mix(pc.rgb, c.rgb, u_blend);
  o = premul(vec4(rgb, c.a));
}`;

const coloramaFx: EffectImpl = {
  render(ctx, input) {
    const q = ctx.params;
    const pal = gradientLut(ctx.glc, q.palette);
    return runPass(ctx, 'fx_colorama', FS_COLORAMA, input, (p) => {
      p.tex('u_pal', pal);
      p.set('u_input', ['intensity', 'red', 'green', 'blue', 'hue', 'lightness', 'saturation', 'alpha'].indexOf(q.inputPhase));
      p.set('u_shift', q.phaseShift / 360);
      p.set('u_cycles', q.cycles);
      p.set('u_blend', q.blend / 100);
    });
  },
};

const FS_TINT = `${H}
uniform vec3 u_black, u_white;
uniform float u_amount;
void main() {
  vec4 c = unpremul(texture(u_src, v_uv));
  vec3 t = mix(u_black, u_white, lum709(c.rgb));
  o = premul(vec4(mix(c.rgb, t, u_amount), c.a));
}`;

const tintFx: EffectImpl = {
  render(ctx, input) {
    const q = ctx.params;
    return runPass(ctx, 'fx_tint', FS_TINT, input, (p) => {
      p.set('u_black', q.black.slice(0, 3));
      p.set('u_white', q.white.slice(0, 3));
      p.set('u_amount', q.amount / 100);
    });
  },
};

const FS_TRITONE = `${H}
uniform vec3 u_hi, u_mid, u_sh;
uniform float u_blend;
void main() {
  vec4 c = unpremul(texture(u_src, v_uv));
  float l = lum709(c.rgb);
  vec3 t = l < 0.5 ? mix(u_sh, u_mid, l * 2.0) : mix(u_mid, u_hi, (l - 0.5) * 2.0);
  o = premul(vec4(mix(t, c.rgb, u_blend), c.a));
}`;

const tritoneFx: EffectImpl = {
  render(ctx, input) {
    const q = ctx.params;
    return runPass(ctx, 'fx_tritone', FS_TRITONE, input, (p) => {
      p.set('u_hi', q.highlights.slice(0, 3));
      p.set('u_mid', q.midtones.slice(0, 3));
      p.set('u_sh', q.shadows.slice(0, 3));
      p.set('u_blend', q.blend / 100);
    });
  },
};

const FS_EXPOSURE = `${H}
uniform float u_exp, u_offset, u_gamma;
void main() {
  vec4 c = unpremul(texture(u_src, v_uv));
  vec3 r = max(c.rgb * exp2(u_exp) + u_offset, 0.0);
  r = pow(r, vec3(1.0 / max(u_gamma, 0.01)));
  o = premul(vec4(r, c.a));
}`;

const exposureFx: EffectImpl = {
  render(ctx, input) {
    const q = ctx.params;
    return runPass(ctx, 'fx_exposure', FS_EXPOSURE, input, (p) => {
      p.set('u_exp', q.exposure);
      p.set('u_offset', q.offset);
      p.set('u_gamma', q.gamma);
    });
  },
};

const FS_BC = `${H}
uniform float u_b, u_c;
void main() {
  vec4 c = unpremul(texture(u_src, v_uv));
  vec3 r = c.rgb + u_b;
  float k = u_c >= 0.0 ? 1.0 / max(1.0 - u_c * 0.99, 0.01) : 1.0 + u_c;
  r = (r - 0.5) * k + 0.5;
  o = premul(vec4(clamp(r, 0.0, 1.0), c.a));
}`;

const brightnessContrastFx: EffectImpl = {
  render(ctx, input) {
    const q = ctx.params;
    return runPass(ctx, 'fx_bc', FS_BC, input, (p) => {
      p.set('u_b', q.brightness / 255);
      p.set('u_c', q.contrast / 100);
    });
  },
};

const FS_INVERT = `${H}
uniform int u_ch;
uniform float u_blend;
void main() {
  vec4 c = unpremul(texture(u_src, v_uv));
  vec4 r = c;
  if (u_ch == 0) r.rgb = 1.0 - c.rgb;
  else if (u_ch == 1) r.r = 1.0 - c.r;
  else if (u_ch == 2) r.g = 1.0 - c.g;
  else if (u_ch == 3) r.b = 1.0 - c.b;
  else r.a = 1.0 - c.a;
  o = premul(mix(r, c, u_blend));
}`;

const invertFx: EffectImpl = {
  render(ctx, input) {
    const q = ctx.params;
    return runPass(ctx, 'fx_invert', FS_INVERT, input, (p) => {
      p.set('u_ch', ['rgb', 'r', 'g', 'b', 'a'].indexOf(q.channel));
      p.set('u_blend', q.blend / 100);
    });
  },
};

// ── Distort ─────────────────────────────────────────────────────────────────

const FS_TURB = `${H}${NOISE}
uniform float u_amount, u_size, u_complexity, u_evo;
uniform vec2 u_offset;
uniform int u_mode, u_pin;
float fbm(vec2 q, float e) {
  float s = 0.0, a = 1.0, n = 0.0;
  for (int i = 0; i < 10; i++) {
    float fi = float(i);
    if (fi >= ceil(u_complexity)) break;
    float w = fi + 1.0 > u_complexity ? fract(u_complexity) : 1.0;
    s += snoise(vec3(q * exp2(fi), e + fi * 7.31)) * a * w;
    n += a * w;
    a *= 0.5;
  }
  return s / max(n, 1e-4);
}
void main() {
  vec2 p = layerPos(v_uv);
  vec2 q = (p - u_offset) / max(u_size, 1.0);
  float e = u_evo;
  float n1 = fbm(q, e);
  float n2 = fbm(q + vec2(31.7, 17.3), e);
  vec2 d;
  if (u_mode == 0) d = vec2(n1, n2);
  else if (u_mode == 1) { vec2 r = p - u_offset; d = normalize(r + 1e-4) * n1; }
  else if (u_mode == 2) d = vec2(-n2, n1) * 1.4;
  else if (u_mode == 3) d = vec2(n1, 0.0);
  else d = vec2(0.0, n1);
  d *= u_amount;
  if (u_pin == 1) {
    vec2 e1 = min(v_uv, 1.0 - v_uv) * u_rect.zw;
    d *= clamp(min(e1.x, e1.y) / max(u_size * 0.5, 1.0), 0.0, 1.0);
  }
  o = sampleClamp(layerToUv(p + d));
}`;

const turbulentDisplaceFx: EffectImpl = {
  pad: (p) => Math.abs(p.amount) * 0.6,
  render(ctx, input) {
    const q = ctx.params;
    return runPass(ctx, 'fx_turb', FS_TURB, input, (p) => {
      p.set('u_amount', q.amount);
      p.set('u_size', q.size);
      p.set('u_complexity', Math.max(1, q.complexity));
      p.set('u_evo', q.evolution / 360);
      p.set('u_offset', q.offset);
      p.set('u_mode', ['turbulent', 'bulge', 'twist', 'horizontal', 'vertical'].indexOf(q.displacement));
      p.set('u_pin', q.pinning === 'all' ? 1 : 0);
    });
  },
};

const FS_BULGE = `${H}
uniform vec2 u_center, u_radius;
uniform float u_height;
void main() {
  vec2 p = layerPos(v_uv);
  vec2 d = (p - u_center) / max(u_radius, vec2(1e-3));
  float r = length(d);
  vec2 q = p;
  if (r < 1.0 && r > 1e-5) {
    float k = u_height >= 0.0 ? 1.0 + u_height * 0.5 : 1.0 / (1.0 - u_height * 0.5);
    float nr = pow(r, k);
    float f = mix(nr / r, 1.0, smoothstep(0.85, 1.0, r));
    q = u_center + (p - u_center) * f;
  }
  o = sampleClamp(layerToUv(q));
}`;

const bulgeFx: EffectImpl = {
  render(ctx, input) {
    const q = ctx.params;
    return runPass(ctx, 'fx_bulge', FS_BULGE, input, (p) => {
      p.set('u_center', q.center);
      p.set('u_radius', [q.hRadius, q.vRadius]);
      p.set('u_height', q.height);
    });
  },
};

const FS_OPTICS = `${H}
uniform vec2 u_center;
uniform float u_k, u_halfDiag;
uniform int u_reverse;
void main() {
  vec2 p = layerPos(v_uv);
  vec2 d = (p - u_center) / u_halfDiag;
  float r = length(d);
  float rs = r;
  if (r > 1e-5 && u_k > 1e-4) {
    float a = atan(u_k);
    rs = u_reverse == 1 ? atan(r * u_k) / a : tan(r * a) / u_k;
  }
  vec2 q = u_center + (r > 1e-5 ? d / r * rs : d) * u_halfDiag;
  o = sampleClamp(layerToUv(q));
}`;

const opticsFx: EffectImpl = {
  render(ctx, input) {
    const q = ctx.params;
    if (q.fov < 0.01) return input;
    const dims = sourceDims(ctx);
    return runPass(ctx, 'fx_optics', FS_OPTICS, input, (p) => {
      p.set('u_center', q.center);
      p.set('u_k', Math.tan(Math.min(179, q.fov) * 0.5 * D2R));
      p.set('u_halfDiag', Math.hypot(dims.w, dims.h) / 2);
      p.set('u_reverse', q.reverse ? 1 : 0);
    });
  },
};

const FS_CORNERPIN = `${H}
uniform mat3 u_inv;
uniform vec2 u_srcSize;
uniform vec4 u_inRect;
void main() {
  vec2 p = layerPos(v_uv);
  vec3 uvw = u_inv * vec3(p, 1.0);
  vec2 uv = uvw.xy / uvw.z;
  if (uvw.z <= 0.0 || uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { o = vec4(0.0); return; }
  vec2 lp = uv * u_srcSize;
  vec2 tuv = (lp - u_inRect.xy) / u_inRect.zw;
  o = (tuv.x < 0.0 || tuv.y < 0.0 || tuv.x > 1.0 || tuv.y > 1.0) ? vec4(0.0) : texture(u_src, tuv);
}`;

function homography(p0: number[], p1: number[], p2: number[], p3: number[]): number[] {
  // unit square (0,0),(1,0),(1,1),(0,1) → p0 (UL), p1 (UR), p2 (LR), p3 (LL)
  const dx1 = p1[0] - p2[0], dx2 = p3[0] - p2[0], dx3 = p0[0] - p1[0] + p2[0] - p3[0];
  const dy1 = p1[1] - p2[1], dy2 = p3[1] - p2[1], dy3 = p0[1] - p1[1] + p2[1] - p3[1];
  let g = 0, h = 0;
  if (Math.abs(dx3) > 1e-9 || Math.abs(dy3) > 1e-9) {
    const det = dx1 * dy2 - dx2 * dy1 || 1e-9;
    g = (dx3 * dy2 - dx2 * dy3) / det;
    h = (dx1 * dy3 - dx3 * dy1) / det;
  }
  const a = p1[0] - p0[0] + g * p1[0], b = p3[0] - p0[0] + h * p3[0], c = p0[0];
  const d = p1[1] - p0[1] + g * p1[1], e = p3[1] - p0[1] + h * p3[1], f = p0[1];
  return [a, b, c, d, e, f, g, h, 1];
}

function invert3(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C || 1e-12;
  return [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ];
}

const cornerPinFx: EffectImpl = {
  outRect(q) {
    const pts = [q.ul, q.ur, q.lr, q.ll];
    const xs = pts.map((p: number[]) => p[0]), ys = pts.map((p: number[]) => p[1]);
    const x = Math.min(...xs) - 1, y = Math.min(...ys) - 1;
    return { x, y, w: Math.max(...xs) - x + 2, h: Math.max(...ys) - y + 2 };
  },
  render(ctx, input) {
    const q = ctx.params;
    const out = cornerPinFx.outRect!(q, ctx.rect) as Rect;
    const W = Math.max(1, Math.min(ctx.glc.maxTex, Math.ceil(out.w * ctx.scale)));
    const Hh = Math.max(1, Math.min(ctx.glc.maxTex, Math.ceil(out.h * ctx.scale)));
    const target = ctx.glc.acquire(W, Hh, ctx.format, false);
    const dims = sourceDims(ctx);
    const m = homography(q.ul, q.ur, q.lr, q.ll);
    const inv = invert3(m);
    const colMajor = [inv[0], inv[3], inv[6], inv[1], inv[4], inv[7], inv[2], inv[5], inv[8]];
    const p = ctx.glc.program('fx_cornerpin', FS_CORNERPIN);
    ctx.glc.pass(p, target, (pp) => {
      pp.tex('u_src', input);
      pp.set('u_rect', [out.x, out.y, W / ctx.scale, Hh / ctx.scale]);
      pp.set('u_inRect', [ctx.rect.x, ctx.rect.y, ctx.rect.w, ctx.rect.h]);
      pp.set('u_inv', colMajor);
      pp.set('u_srcSize', [dims.w, dims.h]);
    });
    return target;
  },
};

const FS_TWIRL = `${H}
uniform vec2 u_center;
uniform float u_angle, u_radius;
void main() {
  vec2 p = layerPos(v_uv);
  vec2 d = p - u_center;
  float r = length(d);
  vec2 q = p;
  if (r < u_radius) {
    float f = 1.0 - r / u_radius;
    float a = -u_angle * f * f;
    float c = cos(a), s = sin(a);
    q = u_center + vec2(d.x * c - d.y * s, d.x * s + d.y * c);
  }
  o = sampleClamp(layerToUv(q));
}`;

const twirlFx: EffectImpl = {
  render(ctx, input) {
    const q = ctx.params;
    const dims = sourceDims(ctx);
    return runPass(ctx, 'fx_twirl', FS_TWIRL, input, (p) => {
      p.set('u_center', q.center);
      p.set('u_angle', q.angle * D2R);
      p.set('u_radius', Math.max(1, (q.radius / 100) * Math.max(dims.w, dims.h)));
    });
  },
};

const FS_WAVE = `${H}
uniform vec2 u_dir;
uniform float u_height, u_width, u_phase;
uniform int u_type;
float wave(float x) {
  float f = fract(x);
  if (u_type == 0) return sin(x * 6.2831853);
  if (u_type == 1) return f < 0.5 ? 1.0 : -1.0;
  if (u_type == 2) return 1.0 - 4.0 * abs(f - 0.5);
  return f * 2.0 - 1.0;
}
void main() {
  vec2 p = layerPos(v_uv);
  float along = dot(p, u_dir) / max(u_width, 1.0);
  vec2 perp = vec2(-u_dir.y, u_dir.x);
  vec2 q = p - perp * wave(along - u_phase) * u_height;
  o = sampleClamp(layerToUv(q));
}`;

const waveWarpFx: EffectImpl = {
  pad: (p) => Math.abs(p.height),
  render(ctx, input) {
    const q = ctx.params;
    const a = q.direction * D2R;
    return runPass(ctx, 'fx_wave', FS_WAVE, input, (p) => {
      p.set('u_dir', [Math.sin(a), -Math.cos(a)]);
      p.set('u_height', q.height);
      p.set('u_width', q.width);
      p.set('u_phase', q.phase / 360 + q.speed * ctx.time);
      p.set('u_type', ['sine', 'square', 'triangle', 'sawtooth'].indexOf(q.waveType));
    });
  },
};

const FS_MIRROR = `${H}
uniform vec2 u_center, u_n;
void main() {
  vec2 p = layerPos(v_uv);
  float d = dot(p - u_center, u_n);
  vec2 q = d > 0.0 ? p - 2.0 * d * u_n : p;
  o = sampleClamp(layerToUv(q));
}`;

const mirrorFx: EffectImpl = {
  render(ctx, input) {
    const q = ctx.params;
    const a = q.angle * D2R;
    return runPass(ctx, 'fx_mirror', FS_MIRROR, input, (p) => {
      p.set('u_center', q.center);
      p.set('u_n', [Math.cos(a), Math.sin(a)]);
    });
  },
};

// ── Generate ────────────────────────────────────────────────────────────────

const FS_FRACTAL = `${H}${NOISE}${BLEND}
uniform int u_type, u_invert, u_blend, u_cycle;
uniform float u_contrast, u_brightness, u_rot, u_complexity, u_subInf, u_subScale, u_subRot, u_evo, u_cycleLen, u_seed, u_opacity;
uniform vec2 u_scale2, u_offset;
float octaveNoise(vec2 q, float e) {
  return snoise(vec3(q + u_seed * 13.17, e));
}
float sampleEvo(vec2 q, float e) {
  if (u_cycle == 1) {
    float L = max(u_cycleLen, 1.0);
    float ee = mod(e, L);
    float f = ee / L;
    float a = octaveNoise(q, ee * 0.6);
    float b = octaveNoise(q, (ee - L) * 0.6);
    return (a * (1.0 - f) + b * f) / sqrt((1.0 - f) * (1.0 - f) + f * f);
  }
  return octaveNoise(q, e * 0.6);
}
void main() {
  vec2 p = layerPos(v_uv) - u_offset;
  float cr = cos(-u_rot), sr = sin(-u_rot);
  p = vec2(p.x * cr - p.y * sr, p.x * sr + p.y * cr);
  vec2 q = p / (u_scale2 * 1.2);
  float sum = 0.0, norm = 0.0, amp = 1.0, mx = -1.0;
  float freq = 1.0;
  float ang = 0.0;
  for (int i = 0; i < 20; i++) {
    float fi = float(i);
    if (fi >= ceil(u_complexity)) break;
    float w = fi + 1.0 > u_complexity ? fract(u_complexity) : 1.0;
    if (w == 0.0) w = 1.0;
    float c = cos(ang), s = sin(ang);
    vec2 qq = vec2(q.x * c - q.y * s, q.x * s + q.y * c) * freq + fi * 17.17;
    float n = sampleEvo(qq, u_evo + fi * 3.1);
    float v;
    if (u_type == 0) v = n * 0.5 + 0.5;
    else if (u_type == 1) v = abs(n);
    else if (u_type == 2) v = 1.0 - abs(n);
    else if (u_type == 3) v = 0.5 + 0.5 * sin(n * 4.0 + u_evo);
    else v = n * 0.5 + 0.5;
    if (u_type == 4) mx = max(mx, v * amp + (1.0 - amp) * 0.5);
    sum += v * amp * w;
    norm += amp * w;
    amp *= u_subInf;
    freq /= max(u_subScale, 0.1);
    ang += u_subRot;
  }
  float v = u_type == 4 ? mx : sum / max(norm, 1e-4);
  if (u_type == 2) v = pow(v, 2.2);
  v = (v - 0.5) * u_contrast + 0.5 + u_brightness;
  v = clamp(v, 0.0, 1.0);
  if (u_invert == 1) v = 1.0 - v;
  vec4 src = texture(u_src, v_uv);
  vec4 n4 = vec4(vec3(v), 1.0) * u_opacity;
  o = compositeMode(src, n4, u_blend, 0.0);
}`;

const fractalNoiseFx: EffectImpl = {
  render(ctx, input) {
    const q = ctx.params;
    return runPass(ctx, 'fx_fractal', FS_FRACTAL, input, (p) => {
      p.set('u_type', ['basic', 'turbulentSmooth', 'turbulentSharp', 'dynamic', 'max'].indexOf(q.fractalType));
      p.set('u_invert', q.invert ? 1 : 0);
      p.set('u_contrast', q.contrast / 100);
      p.set('u_brightness', q.brightness / 100);
      p.set('u_rot', q.rotation * D2R);
      p.set('u_scale2', [Math.max(1, (q.scale * q.scaleW) / 100), Math.max(1, (q.scale * q.scaleH) / 100)]);
      p.set('u_offset', q.offset);
      p.set('u_complexity', Math.max(1, q.complexity));
      p.set('u_subInf', q.subInfluence / 100);
      p.set('u_subScale', q.subScaling / 100);
      p.set('u_subRot', q.subRotation * D2R);
      p.set('u_evo', q.evolution / 360);
      p.set('u_cycle', q.cycle ? 1 : 0);
      p.set('u_cycleLen', Math.max(1, Math.round(q.cycleRevolutions)));
      p.set('u_seed', q.seed);
      p.set('u_opacity', q.opacity / 100);
      p.set('u_blend', BLEND_INDEX[q.blend] ?? 0);
    });
  },
};

const FS_RAMP = `${H}
uniform vec2 u_start, u_end;
uniform vec4 u_c0, u_c1;
uniform int u_radial;
uniform float u_scatter, u_blend;
void main() {
  vec2 p = layerPos(v_uv);
  vec2 se = u_end - u_start;
  float t = u_radial == 1 ? length(p - u_start) / max(length(se), 1e-3) : dot(p - u_start, se) / max(dot(se, se), 1e-3);
  t += (hash12(v_uv * u_texSize) - 0.5) * u_scatter / max(length(se), 1.0);
  vec4 g = mix(u_c0, u_c1, clamp(t, 0.0, 1.0));
  vec4 src = texture(u_src, v_uv);
  vec4 r = vec4(g.rgb * g.a, g.a) * src.a;
  o = mix(r, src, u_blend);
}`;

const gradientRampFx: EffectImpl = {
  render(ctx, input) {
    const q = ctx.params;
    return runPass(ctx, 'fx_ramp', FS_RAMP, input, (p) => {
      p.set('u_start', q.start);
      p.set('u_end', q.end);
      p.set('u_c0', q.startColor);
      p.set('u_c1', q.endColor);
      p.set('u_radial', q.shape === 'radial' ? 1 : 0);
      p.set('u_scatter', q.scatter);
      p.set('u_blend', q.blend / 100);
    });
  },
};

const FS_4COLOR = `${H}
uniform vec2 u_p[4];
uniform vec4 u_c[4];
uniform float u_power, u_opacity;
void main() {
  vec2 p = layerPos(v_uv);
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 4; i++) {
    float d = max(length(p - u_p[i]), 0.5);
    float w = 1.0 / pow(d, u_power);
    acc += u_c[i] * w;
    wsum += w;
  }
  vec4 g = acc / wsum;
  vec4 src = texture(u_src, v_uv);
  vec4 r = vec4(g.rgb, 1.0) * src.a;
  o = mix(src, r, u_opacity);
}`;

const fourColorFx: EffectImpl = {
  render(ctx, input) {
    const q = ctx.params;
    return runPass(ctx, 'fx_4color', FS_4COLOR, input, (p) => {
      p.set('u_p', [...q.p1, ...q.p2, ...q.p3, ...q.p4]);
      p.set('u_c', [...q.c1, ...q.c2, ...q.c3, ...q.c4]);
      p.set('u_power', 0.6 + (q.blend / 100) * 1.4);
      p.set('u_opacity', q.opacity / 100);
    });
  },
};

const FS_GRID = `${H}${BLEND}
uniform vec2 u_anchor, u_cell;
uniform float u_border, u_feather, u_opacity;
uniform vec4 u_color;
uniform int u_invert, u_blend, u_none;
void main() {
  vec2 p = layerPos(v_uv) - u_anchor;
  vec2 f = abs(fract(p / u_cell + 0.5) - 0.5) * u_cell;
  float d = min(f.x, f.y);
  float hw = u_border * 0.5;
  float line = 1.0 - smoothstep(hw - u_feather - 0.5 / u_scale, hw + u_feather + 0.5 / u_scale, d);
  if (u_invert == 1) line = 1.0 - line;
  vec4 g = vec4(u_color.rgb, 1.0) * line * u_opacity * u_color.a;
  vec4 src = texture(u_src, v_uv);
  o = u_none == 1 ? g : compositeMode(src, g, u_blend, 0.0);
}`;

const gridFx: EffectImpl = {
  render(ctx, input) {
    const q = ctx.params;
    return runPass(ctx, 'fx_grid', FS_GRID, input, (p) => {
      p.set('u_anchor', q.anchor);
      p.set('u_cell', [Math.max(1, q.cellW), Math.max(1, q.cellH)]);
      p.set('u_border', q.border);
      p.set('u_feather', q.feather);
      p.set('u_opacity', q.opacity / 100);
      p.set('u_color', q.color);
      p.set('u_invert', q.invert ? 1 : 0);
      p.set('u_none', q.blend === 'none' ? 1 : 0);
      p.set('u_blend', BLEND_INDEX[q.blend] ?? 0);
    });
  },
};

const FS_FILLFX = `${H}
uniform vec4 u_color;
uniform int u_invert;
uniform float u_opacity;
void main() {
  vec4 src = texture(u_src, v_uv);
  float a = u_invert == 1 ? 1.0 - src.a : src.a;
  vec4 f = vec4(u_color.rgb * u_color.a, u_color.a) * a;
  o = mix(src, f, u_opacity);
}`;

const fillFx: EffectImpl = {
  render(ctx, input) {
    const q = ctx.params;
    return runPass(ctx, 'fx_fill', FS_FILLFX, input, (p) => {
      p.set('u_color', q.color);
      p.set('u_invert', q.invert ? 1 : 0);
      p.set('u_opacity', q.opacity / 100);
    });
  },
};

const FS_RAYS_THRESH = `${H}
uniform float u_threshold;
void main() {
  vec4 c = texture(u_src, v_uv);
  float l = c.a > 0.0 ? lum709(c.rgb / c.a) : 0.0;
  float k = smoothstep(u_threshold, min(1.0, u_threshold + 0.25), l);
  o = c * k;
}`;

const FS_RAYS = `${H}
uniform vec2 u_center;
uniform float u_length, u_intensity;
uniform vec3 u_color;
void main() {
  vec4 acc = vec4(0.0);
  const int N = 64;
  float decay = 1.0;
  float wsum = 0.0;
  for (int i = 0; i < N; i++) {
    float t = float(i) / float(N);
    vec2 uv = u_center + (v_uv - u_center) * (1.0 - t * u_length);
    acc += texture(u_src, uv) * decay;
    wsum += decay;
    decay *= 0.965;
  }
  vec4 r = acc / wsum * u_intensity * 2.2;
  // fade towards the (padded) layer bounds so streaks never end in a hard edge
  vec2 e = smoothstep(vec2(0.0), vec2(0.08), v_uv) * smoothstep(vec2(0.0), vec2(0.08), 1.0 - v_uv);
  o = vec4(r.rgb * u_color, r.a) * (e.x * e.y);
}`;

const FS_ADD = `${H}
uniform sampler2D u_add;
uniform int u_only;
void main() {
  vec4 c = texture(u_src, v_uv);
  vec4 a = texture(u_add, v_uv);
  o = u_only == 1 ? vec4(a.rgb, max(max(a.r, a.g), a.b)) : vec4(c.rgb + a.rgb, max(c.a, min(1.0, max(max(a.r, a.g), a.b))));
}`;

const lightRaysFx: EffectImpl = {
  // streaks reach outwards from the source point by length/(1-length) of each pixel's distance to it
  pad: (p, { rect }) => {
    const len = Math.min(0.99, Math.max(0, p.length / 100));
    if (len <= 0) return 0;
    const c = p.center as number[];
    const far = Math.max(
      Math.hypot(rect.x - c[0], rect.y - c[1]), Math.hypot(rect.x + rect.w - c[0], rect.y - c[1]),
      Math.hypot(rect.x - c[0], rect.y + rect.h - c[1]), Math.hypot(rect.x + rect.w - c[0], rect.y + rect.h - c[1]),
    );
    return Math.min(1500, far * (1 / (1 - len) - 1) * 0.6);
  },
  render(ctx, input) {
    const q = ctx.params;
    const glc = ctx.glc;
    const hw = Math.max(1, Math.ceil(input.w / 2)), hh = Math.max(1, Math.ceil(input.h / 2));
    const small = glc.acquire(hw, hh, ctx.format, false);
    const pt = glc.program('fx_rays_t', FS_RAYS_THRESH);
    glc.pass(pt, small, (p) => {
      p.tex('u_src', input);
      stdUniforms(p, ctx, input);
      p.set('u_threshold', q.threshold / 100);
    });
    const rays = glc.acquire(hw, hh, ctx.format, false);
    const pr = glc.program('fx_rays', FS_RAYS);
    glc.pass(pr, rays, (p) => {
      p.tex('u_src', small);
      stdUniforms(p, ctx, small);
      p.set('u_center', toUv(ctx, q.center));
      p.set('u_length', Math.min(0.99, q.length / 100));
      p.set('u_intensity', q.intensity);
      p.set('u_color', q.color.slice(0, 3));
    });
    glc.release(small);
    const out = runPass(ctx, 'fx_add', FS_ADD, input, (p) => {
      p.tex('u_add', rays);
      p.set('u_only', q.composite === 'only' ? 1 : 0);
    });
    glc.release(rays);
    return out;
  },
};

// ── Audio (CPU analysis + Canvas2D drawing) ─────────────────────────────────

function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k], ai = im[i + k];
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ar + br;
        im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br;
        im[i + k + len / 2] = ai - bi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

function spectrumBands(data: Float32Array, sampleRate: number, bands: number, f0: number, f1: number): Float32Array {
  const N = 2048;
  const re = new Float32Array(N), im = new Float32Array(N);
  const off = Math.max(0, Math.floor(data.length / 2 - N / 2));
  for (let i = 0; i < N; i++) {
    const s = data[off + i] ?? 0;
    re[i] = s * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  }
  fft(re, im);
  const mags = new Float32Array(N / 2);
  for (let i = 0; i < N / 2; i++) mags[i] = Math.hypot(re[i], im[i]) / (N / 4);
  const out = new Float32Array(bands);
  const lo = Math.max(1, Math.min(f0, f1)), hi = Math.max(lo + 1, Math.max(f0, f1));
  for (let b = 0; b < bands; b++) {
    const fa = lo * Math.pow(hi / lo, b / bands), fb = lo * Math.pow(hi / lo, (b + 1) / bands);
    const ia = Math.max(0, Math.floor((fa / sampleRate) * N)), ib = Math.min(N / 2 - 1, Math.max(ia, Math.ceil((fb / sampleRate) * N)));
    let m = 0;
    for (let i = ia; i <= ib; i++) m = Math.max(m, mags[i]);
    out[b] = Math.min(1.5, Math.sqrt(m) * 1.6);
  }
  return out;
}

function audioTarget(ctx: FxCtx, input: Tex, draw: (c2d: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, toPx: (p: number[]) => [number, number]) => void): Tex {
  const { canvas, ctx: c2d } = ctx.canvas.scratch(input.w, input.h);
  c2d.setTransform(1, 0, 0, 1, 0, 0);
  c2d.globalCompositeOperation = 'source-over';
  c2d.globalAlpha = 1;
  c2d.filter = 'none';
  c2d.clearRect(0, 0, input.w, input.h);
  const toPx = (p: number[]): [number, number] => [(p[0] - ctx.rect.x) * (input.w / ctx.rect.w), (p[1] - ctx.rect.y) * (input.h / ctx.rect.h)];
  draw(c2d, toPx);
  const up = ctx.glc.createUploadTexture();
  ctx.glc.upload(up, canvas as TexImageSource, input.w, input.h);
  const out = runPass(ctx, 'fx_overlay', FS_OVERLAY, input, (p) => {
    p.tex('u_over', up);
    p.set('u_composite', ctx.params.composite ? 1 : 0);
  });
  ctx.glc.deleteTex(up);
  return out;
}

const FS_OVERLAY = `${H}
uniform sampler2D u_over;
uniform int u_composite;
void main() {
  vec4 c = texture(u_src, v_uv);
  vec4 a = texture(u_over, v_uv);
  o = u_composite == 1 ? a + c * (1.0 - a.a) : a;
}`;

const audioSpectrumFx: EffectImpl = {
  render(ctx, input) {
    const q = ctx.params;
    const dur = Math.max(0.01, q.duration / 1000);
    const s = q.audioLayer ? ctx.audio.samples(q.audioLayer, ctx.time - dur / 2, Math.max(dur, 2048 / 44100)) : null;
    const bands = Math.max(4, Math.min(256, Math.round(q.bands)));
    const vals = s ? spectrumBands(s.data, s.sampleRate, bands, q.startFreq, q.endFreq) : new Float32Array(bands);
    return audioTarget(ctx, input, (c2d, toPx) => {
      const a = toPx(q.start), b = toPx(q.end);
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy) || 1;
      const nx = dy / len, ny = -dx / len;
      const sc = input.w / ctx.rect.w;
      const maxH = q.maxHeight * sc;
      const th = Math.max(0.5, q.thickness * sc);
      c2d.lineCap = q.display === 'digital' ? 'butt' : 'round';
      const grad = (x0: number, y0: number, x1: number, y1: number) => {
        const g = c2d.createLinearGradient(x0, y0, x1, y1);
        g.addColorStop(0, rgbaToCss(q.inside));
        g.addColorStop(1, rgbaToCss(q.outside));
        return g;
      };
      c2d.shadowColor = rgbaToCss(q.outside);
      c2d.shadowBlur = (q.softness / 100) * th * 2;
      const pts: [number, number][] = [];
      for (let i = 0; i < bands; i++) {
        const t = (i + 0.5) / bands;
        const x = a[0] + dx * t, y = a[1] + dy * t;
        const h = vals[i] * maxH;
        const up = q.side === 'b' ? 0 : h, down = q.side === 'a' ? 0 : h;
        if (q.display === 'lines') {
          pts.push([x + nx * up, y + ny * up]);
          continue;
        }
        c2d.strokeStyle = grad(x, y, x + nx * up, y + ny * up);
        c2d.lineWidth = q.display === 'dots' ? th : Math.min(th, (len / bands) * 0.8);
        if (q.display === 'dots') {
          c2d.fillStyle = rgbaToCss(q.inside);
          c2d.beginPath();
          c2d.arc(x + nx * up, y + ny * up, th / 2, 0, Math.PI * 2);
          c2d.fill();
          if (down) {
            c2d.beginPath();
            c2d.arc(x - nx * down, y - ny * down, th / 2, 0, Math.PI * 2);
            c2d.fill();
          }
        } else {
          c2d.beginPath();
          c2d.moveTo(x - nx * down, y - ny * down);
          c2d.lineTo(x + nx * Math.max(up, 1), y + ny * Math.max(up, 1));
          c2d.stroke();
        }
      }
      if (q.display === 'lines' && pts.length) {
        c2d.strokeStyle = rgbaToCss(q.inside);
        c2d.lineWidth = th;
        c2d.beginPath();
        pts.forEach((p, i) => (i ? c2d.lineTo(p[0], p[1]) : c2d.moveTo(p[0], p[1])));
        c2d.stroke();
      }
    });
  },
};

const audioWaveformFx: EffectImpl = {
  render(ctx, input) {
    const q = ctx.params;
    const dur = Math.max(0.01, q.duration / 1000);
    const s = q.audioLayer ? ctx.audio.samples(q.audioLayer, ctx.time - dur / 2, dur) : null;
    const n = Math.max(8, Math.min(2048, Math.round(q.samples)));
    return audioTarget(ctx, input, (c2d, toPx) => {
      const a = toPx(q.start), b = toPx(q.end);
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy) || 1;
      const nx = dy / len, ny = -dx / len;
      const sc = input.w / ctx.rect.w;
      const maxH = q.maxHeight * sc;
      c2d.lineWidth = Math.max(0.5, q.thickness * sc);
      c2d.lineJoin = 'round';
      c2d.lineCap = 'round';
      c2d.shadowColor = rgbaToCss(q.outside);
      c2d.shadowBlur = (q.softness / 100) * c2d.lineWidth * 4;
      c2d.strokeStyle = rgbaToCss(q.inside);
      c2d.beginPath();
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const v = s ? s.data[Math.min(s.data.length - 1, Math.floor(t * (s.data.length - 1)))] : 0;
        const x = a[0] + dx * t + nx * v * maxH, y = a[1] + dy * t + ny * v * maxH;
        if (i === 0) c2d.moveTo(x, y); else c2d.lineTo(x, y);
      }
      c2d.stroke();
    });
  },
};

// ── Keying ──────────────────────────────────────────────────────────────────

const FS_KEY = `${H}
uniform vec3 u_key;
uniform float u_sim, u_smooth, u_spill;
uniform int u_ch;
vec2 chroma(vec3 c) {
  float y = lum709(c);
  return vec2((c.b - y) * 0.5389, (c.r - y) * 0.6350);
}
void main() {
  vec4 c = unpremul(texture(u_src, v_uv));
  float d = distance(chroma(c.rgb), chroma(u_key));
  float a = smoothstep(u_sim * 0.35, u_sim * 0.35 + u_smooth * 0.35 + 1e-3, d);
  vec3 rgb = c.rgb;
  if (u_ch == 1) rgb.g = mix(rgb.g, min(rgb.g, max(rgb.r, rgb.b)), u_spill);
  else if (u_ch == 2) rgb.b = mix(rgb.b, min(rgb.b, max(rgb.r, rgb.g)), u_spill);
  else if (u_ch == 0) rgb.r = mix(rgb.r, min(rgb.r, max(rgb.g, rgb.b)), u_spill);
  o = premul(vec4(rgb, c.a * a));
}`;

const colorKeyFx: EffectImpl = {
  render(ctx, input) {
    const q = ctx.params;
    const k = q.keyColor;
    const ch = k[1] >= k[0] && k[1] >= k[2] ? 1 : k[2] >= k[0] ? 2 : 0;
    return runPass(ctx, 'fx_key', FS_KEY, input, (p) => {
      p.set('u_key', k.slice(0, 3));
      p.set('u_sim', q.similarity / 100);
      p.set('u_smooth', q.smoothness / 100);
      p.set('u_spill', q.spill / 100);
      p.set('u_ch', ch);
    });
  },
};

// ── Noise & Grain ───────────────────────────────────────────────────────────

const FS_GRAIN = `${H}
uniform float u_amount, u_size, u_seed;
uniform int u_color;
void main() {
  vec4 c = texture(u_src, v_uv);
  vec2 g = floor(v_uv * u_texSize / max(u_size * u_scale, 0.5));
  float n = hash12(g + u_seed) - 0.5;
  vec3 nn = u_color == 1 ? vec3(hash12(g + u_seed + 11.1), hash12(g + u_seed + 23.7), hash12(g + u_seed + 41.3)) - 0.5 : vec3(n);
  o = vec4(clamp(c.rgb + nn * u_amount * c.a, vec3(0.0), vec3(c.a)), c.a);
}`;

const noiseFx: EffectImpl = {
  render(ctx, input) {
    const q = ctx.params;
    return runPass(ctx, 'fx_grain', FS_GRAIN, input, (p) => {
      p.set('u_amount', q.amount / 100);
      p.set('u_size', q.size);
      p.set('u_seed', q.animated ? Math.floor(ctx.time * ctx.fps) * 7.31 : 0);
      p.set('u_color', q.color ? 1 : 0);
    });
  },
};

// ── Perspective ─────────────────────────────────────────────────────────────

const FS_SHADOW = `${H}
uniform sampler2D u_blur;
uniform vec2 u_off;
uniform vec4 u_color;
uniform int u_only;
void main() {
  vec4 c = texture(u_src, v_uv);
  float a = 0.0;
  vec2 uv = v_uv - u_off;
  if (uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0) a = texture(u_blur, uv).a;
  vec4 sh = u_color * a;
  o = u_only == 1 ? sh : c + sh * (1.0 - c.a);
}`;

const dropShadowFx: EffectImpl = {
  pad: (p) => p.distance + blurSigma(p.softness) * 3,
  render(ctx, input) {
    const q = ctx.params;
    const b = gaussianBlur(ctx.glc, input, blurSigma(q.softness) * ctx.scale, ctx.format);
    const a = q.direction * D2R;
    const off = [(Math.sin(a) * q.distance * ctx.scale) / input.w, (-Math.cos(a) * q.distance * ctx.scale) / input.h];
    const col = premulColor([q.color[0], q.color[1], q.color[2], (q.opacity / 100) * (q.color[3] ?? 1)]);
    const out = runPass(ctx, 'fx_shadow', FS_SHADOW, input, (p) => {
      p.tex('u_blur', b);
      p.set('u_off', off);
      p.set('u_color', col);
      p.set('u_only', q.shadowOnly ? 1 : 0);
    });
    ctx.glc.release(b);
    return out;
  },
};

// ── Stylize ─────────────────────────────────────────────────────────────────

const FS_GLOW_THRESH = `${H}
uniform float u_threshold;
void main() {
  vec4 c = texture(u_src, v_uv);
  float l = c.a > 0.0 ? lum709(c.rgb / c.a) : 0.0;
  float k = smoothstep(u_threshold - 0.08, u_threshold + 0.12, l);
  o = c * k;
}`;

const FS_GLOW_COMBINE = `${H}
uniform sampler2D u_g0, u_g1, u_g2, u_g3, u_g4;
uniform float u_intensity, u_tintAmt, u_aberr;
uniform vec3 u_tint;
uniform int u_mode;
vec4 glowAt(vec2 uv) {
  return texture(u_g0, uv) * 0.9 + texture(u_g1, uv) * 0.8 + texture(u_g2, uv) * 0.7 + texture(u_g3, uv) * 0.6 + texture(u_g4, uv) * 0.5;
}
void main() {
  vec4 c = texture(u_src, v_uv);
  vec2 d = (v_uv - 0.5) * u_aberr;
  vec4 g;
  if (u_aberr > 0.0) {
    g.r = glowAt(v_uv + d).r;
    g.g = glowAt(v_uv).g;
    g.b = glowAt(v_uv - d).b;
    g.a = glowAt(v_uv).a;
  } else g = glowAt(v_uv);
  g *= u_intensity;
  vec3 tinted = vec3(lum709(g.rgb)) * u_tint * 1.6;
  g.rgb = mix(g.rgb, tinted, u_tintAmt);
  float ga = clamp(max(max(g.r, g.g), g.b), 0.0, 1.0);
  if (u_mode == 2) { o = vec4(g.rgb, ga); return; }
  if (u_mode == 1) { o = c + vec4(g.rgb, ga) * (1.0 - c.a); return; }
  o = vec4(c.rgb + g.rgb, max(c.a, ga));
}`;

const glowFx: EffectImpl = {
  pad: (p) => Math.max(0, p.radius) * 1.2,
  render(ctx, input) {
    const q = ctx.params;
    const glc = ctx.glc;
    const r = Math.max(0, q.radius) * ctx.scale;
    if (r < 0.5 || q.intensity <= 0) return input;
    const bright = runPass(ctx, 'fx_glow_t', FS_GLOW_THRESH, input, (p) => p.set('u_threshold', q.threshold / 100));
    const sig = [0.04, 0.1, 0.22, 0.45, 0.9].map((f) => Math.max(0.5, f * r * 0.5));
    const levels = sig.map((s) => gaussianBlur(glc, bright, s, ctx.format));
    glc.release(bright);
    const out = runPass(ctx, 'fx_glow_c', FS_GLOW_COMBINE, input, (p) => {
      ['u_g0', 'u_g1', 'u_g2', 'u_g3', 'u_g4'].forEach((n, k) => p.tex(n, levels[k]));
      p.set('u_intensity', q.intensity * Math.pow(2, q.exposure) * 0.55);
      p.set('u_tintAmt', q.tintAmount / 100);
      p.set('u_tint', q.tint.slice(0, 3));
      p.set('u_aberr', q.aberration / 400);
      p.set('u_mode', ['onTop', 'behind', 'glowOnly'].indexOf(q.composite));
    });
    for (const l of levels) glc.release(l);
    return out;
  },
};

const FS_EDGES = `${H}
uniform int u_invert;
uniform float u_blend;
void main() {
  vec2 t = u_texel;
  vec3 s[9];
  int k = 0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec4 c = texture(u_src, v_uv + vec2(float(x), float(y)) * t);
    s[k++] = c.rgb;
  }
  vec3 gx = -s[0] - 2.0 * s[3] - s[6] + s[2] + 2.0 * s[5] + s[8];
  vec3 gy = -s[0] - 2.0 * s[1] - s[2] + s[6] + 2.0 * s[7] + s[8];
  vec3 e = clamp(sqrt(gx * gx + gy * gy), 0.0, 1.0);
  vec4 c = texture(u_src, v_uv);
  vec3 r = u_invert == 1 ? e : 1.0 - e;
  o = mix(vec4(r * c.a, c.a), c, u_blend);
}`;

const findEdgesFx: EffectImpl = {
  render(ctx, input) {
    return runPass(ctx, 'fx_edges', FS_EDGES, input, (p) => {
      p.set('u_invert', ctx.params.invert ? 1 : 0);
      p.set('u_blend', ctx.params.blend / 100);
    });
  },
};

const FS_THRESH = `${H}
uniform float u_level;
void main() {
  vec4 c = unpremul(texture(u_src, v_uv));
  float v = lum709(c.rgb) >= u_level ? 1.0 : 0.0;
  o = vec4(vec3(v) * c.a, c.a);
}`;

const thresholdFx: EffectImpl = {
  render(ctx, input) {
    return runPass(ctx, 'fx_thresh', FS_THRESH, input, (p) => p.set('u_level', ctx.params.level / 255));
  },
};

const FS_POSTER = `${H}
uniform float u_level;
void main() {
  vec4 c = unpremul(texture(u_src, v_uv));
  float n = max(u_level, 2.0);
  c.rgb = floor(c.rgb * n) / (n - 1.0);
  o = premul(vec4(clamp(c.rgb, 0.0, 1.0), c.a));
}`;

const posterizeFx: EffectImpl = {
  render(ctx, input) {
    return runPass(ctx, 'fx_poster', FS_POSTER, input, (p) => p.set('u_level', ctx.params.level));
  },
};

const FS_MOSAIC = `${H}
uniform vec2 u_blocks;
void main() {
  vec2 b = max(u_blocks, vec2(1.0));
  vec2 uv = (floor(v_uv * b) + 0.5) / b;
  o = texture(u_src, uv);
}`;

const mosaicFx: EffectImpl = {
  render(ctx, input) {
    return runPass(ctx, 'fx_mosaic', FS_MOSAIC, input, (p) => p.set('u_blocks', [ctx.params.hBlocks, ctx.params.vBlocks]));
  },
};

const FS_RGBSPLIT = `${H}
uniform vec2 u_off;
uniform int u_radial;
void main() {
  vec2 off = u_radial == 1 ? (v_uv - 0.5) * 2.0 * u_off.x : u_off;
  vec4 r = texture(u_src, v_uv + off);
  vec4 g = texture(u_src, v_uv);
  vec4 b = texture(u_src, v_uv - off);
  o = vec4(r.r, g.g, b.b, max(max(r.a, g.a), b.a));
}`;

const rgbSplitFx: EffectImpl = {
  pad: (p) => Math.abs(p.amount) + 1,
  render(ctx, input) {
    const q = ctx.params;
    const a = q.angle * D2R;
    const px = q.amount * ctx.scale;
    return runPass(ctx, 'fx_rgbsplit', FS_RGBSPLIT, input, (p) => {
      p.set('u_off', q.radial ? [px / Math.max(input.w, input.h), 0] : [(Math.cos(a) * px) / input.w, (Math.sin(a) * px) / input.h]);
      p.set('u_radial', q.radial ? 1 : 0);
    });
  },
};

const FS_VIGNETTE = `${H}
uniform float u_amount, u_size, u_soft, u_round;
uniform vec3 u_color;
void main() {
  vec4 c = texture(u_src, v_uv);
  vec2 d = v_uv - 0.5;
  float aspect = u_texSize.x / u_texSize.y;
  d.x *= mix(1.0, aspect, clamp(u_round, 0.0, 1.0));
  d.y *= mix(1.0, 1.0 / aspect, clamp(-u_round, 0.0, 1.0));
  float r = length(d) * 1.414;
  float v = smoothstep(u_size, u_size + max(u_soft, 0.001), r) * u_amount;
  o = vec4(mix(c.rgb, u_color * c.a, v), c.a);
}`;

const vignetteFx: EffectImpl = {
  render(ctx, input) {
    const q = ctx.params;
    return runPass(ctx, 'fx_vignette', FS_VIGNETTE, input, (p) => {
      p.set('u_amount', q.amount / 100);
      p.set('u_size', (q.size / 100) * 0.9);
      p.set('u_soft', q.softness / 100);
      p.set('u_round', q.roundness / 100);
      p.set('u_color', q.color.slice(0, 3));
    });
  },
};

// ── Transition ──────────────────────────────────────────────────────────────

const FS_LINWIPE = `${H}
uniform vec2 u_dir, u_center;
uniform float u_extent, u_completion, u_feather;
void main() {
  vec4 c = texture(u_src, v_uv);
  float d = dot(layerPos(v_uv) - u_center, u_dir) / max(u_extent, 1.0) + 0.5;
  float edge = u_completion * (1.0 + u_feather * 2.0) - u_feather;
  float a = smoothstep(edge - u_feather, edge + u_feather + 1e-4, d);
  o = c * a;
}`;

const linearWipeFx: EffectImpl = {
  render(ctx, input) {
    const q = ctx.params;
    if (q.completion <= 0) return input;
    const dims = sourceDims(ctx);
    const a = q.angle * D2R;
    const dir = [Math.sin(a), -Math.cos(a)];
    const extent = Math.abs(dir[0]) * dims.w + Math.abs(dir[1]) * dims.h;
    return runPass(ctx, 'fx_linwipe', FS_LINWIPE, input, (p) => {
      p.set('u_dir', dir);
      p.set('u_center', [dims.w / 2, dims.h / 2]);
      p.set('u_extent', extent);
      p.set('u_completion', q.completion / 100);
      p.set('u_feather', q.feather / Math.max(1, extent));
    });
  },
};

const FS_RADWIPE = `${H}
uniform vec2 u_center;
uniform float u_start, u_completion, u_feather;
uniform int u_dir;
void main() {
  vec4 c = texture(u_src, v_uv);
  vec2 d = layerPos(v_uv) - u_center;
  float ang = atan(d.x, -d.y) - u_start;
  float t = fract(ang / 6.2831853);
  if (u_dir == 1) t = 1.0 - t;
  else if (u_dir == 2) t = min(t, 1.0 - t) * 2.0;
  float f = max(u_feather, 1e-4);
  float a = smoothstep(u_completion - f, u_completion + f, t);
  o = c * (u_completion >= 1.0 ? 0.0 : a);
}`;

const radialWipeFx: EffectImpl = {
  render(ctx, input) {
    const q = ctx.params;
    if (q.completion <= 0) return input;
    return runPass(ctx, 'fx_radwipe', FS_RADWIPE, input, (p) => {
      p.set('u_center', q.center);
      p.set('u_start', q.startAngle * D2R);
      p.set('u_completion', q.completion / 100);
      p.set('u_feather', q.feather / 360);
      p.set('u_dir', ['cw', 'ccw', 'both'].indexOf(q.direction));
    });
  },
};

const passthrough: EffectImpl = { render: (_ctx, input) => input };

export const EFFECT_IMPLS: Record<string, EffectImpl> = {
  gaussianBlur: gaussianBlurFx,
  directionalBlur: directionalBlurFx,
  radialBlur: radialBlurFx,
  sharpen: sharpenFx,
  curves: curvesFx,
  levels: levelsFx,
  hueSaturation: hueSatFx,
  channelMixer: channelMixerFx,
  colorama: coloramaFx,
  tint: tintFx,
  tritone: tritoneFx,
  exposure: exposureFx,
  brightnessContrast: brightnessContrastFx,
  invert: invertFx,
  turbulentDisplace: turbulentDisplaceFx,
  bulge: bulgeFx,
  opticsCompensation: opticsFx,
  cornerPin: cornerPinFx,
  twirl: twirlFx,
  waveWarp: waveWarpFx,
  mirror: mirrorFx,
  fractalNoise: fractalNoiseFx,
  gradientRamp: gradientRampFx,
  fourColorGradient: fourColorFx,
  grid: gridFx,
  fill: fillFx,
  lightRays: lightRaysFx,
  audioSpectrum: audioSpectrumFx,
  audioWaveform: audioWaveformFx,
  colorKey: colorKeyFx,
  noise: noiseFx,
  dropShadow: dropShadowFx,
  glow: glowFx,
  findEdges: findEdgesFx,
  threshold: thresholdFx,
  posterize: posterizeFx,
  mosaic: mosaicFx,
  chromaticAberration: rgbSplitFx,
  vignette: vignetteFx,
  linearWipe: linearWipeFx,
  radialWipe: radialWipeFx,
};

for (const t of PASSTHROUGH_EFFECTS) EFFECT_IMPLS[t] = passthrough;

export { copyTex };
