// GLSL sources for the core compositing pipeline.

export const HEADER = `#version 300 es
precision highp float;
precision highp int;
`;

export const COMMON = `
float lum709(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec4 unpremul(vec4 c) { return c.a > 1e-5 ? vec4(c.rgb / c.a, c.a) : vec4(0.0); }
vec4 premul(vec4 c) { return vec4(c.rgb * c.a, c.a); }
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
vec3 rgb2hsl(vec3 c) {
  float mx = max(max(c.r, c.g), c.b), mn = min(min(c.r, c.g), c.b);
  float l = (mx + mn) * 0.5;
  float d = mx - mn;
  float h = 0.0, s = 0.0;
  if (d > 1e-6) {
    s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
    if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    h /= 6.0;
  }
  return vec3(h, s, l);
}
float hue2rgb(float p, float q, float t) {
  t = fract(t);
  if (t < 1.0/6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5) return q;
  if (t < 2.0/3.0) return p + (q - p) * (2.0/3.0 - t) * 6.0;
  return p;
}
vec3 hsl2rgb(vec3 hsl) {
  if (hsl.y <= 1e-6) return vec3(hsl.z);
  float q = hsl.z < 0.5 ? hsl.z * (1.0 + hsl.y) : hsl.z + hsl.y - hsl.z * hsl.y;
  float p = 2.0 * hsl.z - q;
  return vec3(hue2rgb(p, q, hsl.x + 1.0/3.0), hue2rgb(p, q, hsl.x), hue2rgb(p, q, hsl.x - 1.0/3.0));
}
`;

// Ashima Arts / Stefan Gustavson 3D simplex noise (MIT)
export const NOISE = `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`;

export const BLEND = `
float lumB(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c) {
  float l = lumB(c);
  float n = min(min(c.r, c.g), c.b);
  float x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = l + (c - l) * l / max(l - n, 1e-6);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, 1e-6);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lumB(c))); }
float satB(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
vec3 setSat(vec3 c, float s) {
  float mx = max(max(c.r, c.g), c.b), mn = min(min(c.r, c.g), c.b);
  return mx > mn ? (c - mn) * s / (mx - mn) : vec3(0.0);
}
float dodge(float b, float s) { return b <= 0.0 ? 0.0 : (s >= 1.0 ? 1.0 : min(1.0, b / (1.0 - s))); }
float burn(float b, float s) { return b >= 1.0 ? 1.0 : (s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / s)); }
float softL(float b, float s) {
  if (s <= 0.5) return b - (1.0 - 2.0 * s) * b * (1.0 - b);
  float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
  return b + (2.0 * s - 1.0) * (d - b);
}
float hardL(float b, float s) { return s <= 0.5 ? b * 2.0 * s : b + (2.0 * s - 1.0) - b * (2.0 * s - 1.0); }
float vivid(float b, float s) { return s <= 0.5 ? burn(b, 2.0 * s) : dodge(b, 2.0 * (s - 0.5)); }
float pinL(float b, float s) { return s <= 0.5 ? min(b, 2.0 * s) : max(b, 2.0 * s - 1.0); }

vec3 blendColor(int m, vec3 b, vec3 s) {
  if (m == 2) return min(b, s);
  if (m == 3) return b * s;
  if (m == 4) return vec3(burn(b.r, s.r), burn(b.g, s.g), burn(b.b, s.b));
  if (m == 5) return max(b + s - 1.0, 0.0);
  if (m == 6) return lumB(s) < lumB(b) ? s : b;
  if (m == 7) return max(b, s);
  if (m == 8) return b + s - b * s;
  if (m == 9) return vec3(dodge(b.r, s.r), dodge(b.g, s.g), dodge(b.b, s.b));
  if (m == 10) return b + s;
  if (m == 11) return lumB(s) > lumB(b) ? s : b;
  if (m == 12) return vec3(hardL(s.r, b.r), hardL(s.g, b.g), hardL(s.b, b.b));
  if (m == 13) return vec3(softL(b.r, s.r), softL(b.g, s.g), softL(b.b, s.b));
  if (m == 14) return vec3(hardL(b.r, s.r), hardL(b.g, s.g), hardL(b.b, s.b));
  if (m == 15) return clamp(b + 2.0 * s - 1.0, 0.0, 1.0);
  if (m == 16) return vec3(vivid(b.r, s.r), vivid(b.g, s.g), vivid(b.b, s.b));
  if (m == 17) return vec3(pinL(b.r, s.r), pinL(b.g, s.g), pinL(b.b, s.b));
  if (m == 18) return step(1.0, b + s);
  if (m == 19) return abs(b - s);
  if (m == 20) return b + s - 2.0 * b * s;
  if (m == 21) return max(b - s, 0.0);
  if (m == 22) return vec3(s.r <= 0.0 ? 1.0 : min(b.r / s.r, 1.0), s.g <= 0.0 ? 1.0 : min(b.g / s.g, 1.0), s.b <= 0.0 ? 1.0 : min(b.b / s.b, 1.0));
  if (m == 23) return setLum(setSat(s, satB(b)), lumB(b));
  if (m == 24) return setLum(setSat(b, satB(s)), lumB(b));
  if (m == 25) return setLum(s, lumB(b));
  if (m == 26) return setLum(b, lumB(s));
  return s;
}

// Composite premultiplied source over premultiplied backdrop with blend mode m (W3C compositing model).
vec4 compositeMode(vec4 d, vec4 s, int m, float seed) {
  if (m == 27) return d * s.a;
  if (m == 28) return d * clamp(lum709(s.rgb), 0.0, 1.0);
  if (m == 29) return d * (1.0 - s.a);
  if (m == 30) return d * (1.0 - clamp(lum709(s.rgb), 0.0, 1.0));
  if (m == 31) return vec4(s.rgb + d.rgb * (1.0 - s.a), min(1.0, s.a + d.a));
  if (m == 32) return vec4(d.rgb + s.rgb, min(1.0, d.a + s.a - d.a * s.a));
  if (m == 1) {
    float r = hash12(gl_FragCoord.xy + vec2(seed * 17.13, seed * 3.7));
    s = r < s.a ? vec4(s.rgb / max(s.a, 1e-5), 1.0) : vec4(0.0);
    m = 0;
  }
  if (s.a <= 0.0) return d;
  if (m == 0) return s + d * (1.0 - s.a);
  vec3 cs = s.rgb / s.a;
  vec3 cb = d.a > 1e-5 ? d.rgb / d.a : vec3(0.0);
  vec3 B = blendColor(m, cb, cs);
  vec3 csp = (1.0 - d.a) * cs + d.a * B;
  return vec4(s.a * csp + (1.0 - s.a) * d.rgb, s.a + d.a * (1.0 - s.a));
}
`;

export const BLEND_INDEX: Record<string, number> = {
  normal: 0, dissolve: 1, darken: 2, multiply: 3, colorBurn: 4, linearBurn: 5, darkerColor: 6, lighten: 7, screen: 8,
  colorDodge: 9, add: 10, lighterColor: 11, overlay: 12, softLight: 13, hardLight: 14, linearLight: 15, vividLight: 16,
  pinLight: 17, hardMix: 18, difference: 19, exclusion: 20, subtract: 21, divide: 22, hue: 23, saturation: 24, color: 25,
  luminosity: 26, stencilAlpha: 27, stencilLuma: 28, silhouetteAlpha: 29, silhouetteLuma: 30, alphaAdd: 31, luminescentPremul: 32,
};

// ── core passes ─────────────────────────────────────────────────────────────

export const FS_COPY = `${HEADER}
in vec2 v_uv; out vec4 o;
uniform sampler2D u_src;
uniform float u_opacity;
void main() { o = texture(u_src, v_uv) * u_opacity; }`;

export const FS_COMPOSITE = `${HEADER}${COMMON}${BLEND}
in vec2 v_uv; out vec4 o;
uniform sampler2D u_dst;
uniform sampler2D u_src;
uniform int u_mode;
uniform int u_preserve;
uniform float u_seed;
void main() {
  vec4 d = texture(u_dst, v_uv);
  vec4 s = texture(u_src, v_uv);
  if (u_preserve == 1) s *= d.a;
  o = compositeMode(d, s, u_mode, u_seed);
}`;

export const FS_MATTE = `${HEADER}${COMMON}
in vec2 v_uv; out vec4 o;
uniform sampler2D u_src;
uniform sampler2D u_matte;
uniform int u_mode;
void main() {
  vec4 m = texture(u_matte, v_uv);
  float f = u_mode == 0 ? m.a : u_mode == 1 ? 1.0 - m.a : u_mode == 2 ? clamp(lum709(m.rgb), 0.0, 1.0) : 1.0 - clamp(lum709(m.rgb), 0.0, 1.0);
  o = texture(u_src, v_uv) * f;
}`;

export const FS_MASK_APPLY = `${HEADER}
in vec2 v_uv; out vec4 o;
uniform sampler2D u_src;
uniform sampler2D u_mask;
void main() { o = texture(u_src, v_uv) * texture(u_mask, v_uv).a; }`;

export const FS_MIX = `${HEADER}
in vec2 v_uv; out vec4 o;
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform sampler2D u_mask;
uniform float u_amount;
uniform int u_useMask;
void main() {
  float m = u_amount * (u_useMask == 1 ? texture(u_mask, v_uv).a : 1.0);
  o = mix(texture(u_a, v_uv), texture(u_b, v_uv), clamp(m, 0.0, 1.0));
}`;

export const FS_PRESENT = `${HEADER}
in vec2 v_uv; out vec4 o;
uniform sampler2D u_src;
uniform vec4 u_bg;
uniform int u_useBg;
uniform int u_flip;
void main() {
  vec2 uv = u_flip == 1 ? vec2(v_uv.x, 1.0 - v_uv.y) : v_uv;
  vec4 c = texture(u_src, uv);
  if (u_useBg == 1) c = c + u_bg * (1.0 - c.a);
  o = clamp(c, 0.0, 1.0);
}`;

/** Separable Gaussian with linear-sampling tap pairs. */
export const FS_BLUR = `${HEADER}
in vec2 v_uv; out vec4 o;
uniform sampler2D u_src;
uniform vec2 u_dir;
uniform float u_sigma;
void main() {
  float s = max(u_sigma, 0.001);
  int R = int(min(ceil(s * 3.0), 47.0));
  float k = -0.5 / (s * s);
  vec4 acc = texture(u_src, v_uv);
  float wsum = 1.0;
  for (int i = 1; i <= 47; i += 2) {
    if (i > R) break;
    float fi = float(i);
    float w1 = exp(k * fi * fi);
    float w2 = exp(k * (fi + 1.0) * (fi + 1.0));
    float w = w1 + w2;
    float off = (fi * w1 + (fi + 1.0) * w2) / w;
    acc += (texture(u_src, v_uv + u_dir * off) + texture(u_src, v_uv - u_dir * off)) * w;
    wsum += 2.0 * w;
  }
  o = acc / wsum;
}`;

/** Dual-filter downsample (Kawase) – 5 taps. */
export const FS_DOWN = `${HEADER}
in vec2 v_uv; out vec4 o;
uniform sampler2D u_src;
uniform vec2 u_texel;
void main() {
  vec4 sum = texture(u_src, v_uv) * 4.0;
  sum += texture(u_src, v_uv - u_texel);
  sum += texture(u_src, v_uv + u_texel);
  sum += texture(u_src, v_uv + vec2(u_texel.x, -u_texel.y));
  sum += texture(u_src, v_uv - vec2(u_texel.x, -u_texel.y));
  o = sum / 8.0;
}`;

/** Dual-filter upsample (tent) – 8 taps. */
export const FS_UP = `${HEADER}
in vec2 v_uv; out vec4 o;
uniform sampler2D u_src;
uniform vec2 u_texel;
void main() {
  vec2 h = u_texel * 0.5;
  vec4 sum = texture(u_src, v_uv + vec2(-h.x * 2.0, 0.0));
  sum += texture(u_src, v_uv + vec2(-h.x, h.y)) * 2.0;
  sum += texture(u_src, v_uv + vec2(0.0, h.y * 2.0));
  sum += texture(u_src, v_uv + vec2(h.x, h.y)) * 2.0;
  sum += texture(u_src, v_uv + vec2(h.x * 2.0, 0.0));
  sum += texture(u_src, v_uv + vec2(h.x, -h.y)) * 2.0;
  sum += texture(u_src, v_uv + vec2(0.0, -h.y * 2.0));
  sum += texture(u_src, v_uv + vec2(-h.x, -h.y)) * 2.0;
  o = sum / 12.0;
}`;

// ── layer draw (2D/3D, lights, depth of field) ──────────────────────────────

export const VS_LAYER = `#version 300 es
layout(location = 0) in vec2 a_pos;
uniform vec4 u_rect;
uniform mat4 u_model;
uniform mat4 u_viewProj;
uniform mat4 u_view;
out vec2 v_uv;
out vec3 v_world;
out float v_viewZ;
void main() {
  vec2 p = u_rect.xy + a_pos * u_rect.zw;
  vec4 w = u_model * vec4(p, 0.0, 1.0);
  v_world = w.xyz;
  v_uv = a_pos;
  v_viewZ = (u_view * w).z;
  gl_Position = u_viewProj * w;
}`;

export const FS_LAYER = `${HEADER}
in vec2 v_uv;
in vec3 v_world;
in float v_viewZ;
out vec4 o;
uniform sampler2D u_src;
uniform sampler2D u_srcBlur;
uniform float u_opacity;
uniform int u_dof;
uniform float u_focus;
uniform float u_cocScale;
uniform float u_cocMax;
uniform int u_lit;
uniform int u_numLights;
uniform vec4 u_lightPos[8];
uniform vec4 u_lightDir[8];
uniform vec4 u_lightColor[8];
uniform vec4 u_lightParams[8];
uniform vec3 u_ambient;
uniform vec3 u_normal;
uniform vec3 u_camPos;
uniform vec4 u_material;
uniform float u_metal;
uniform float u_alphaCut;
void main() {
  vec4 c = texture(u_src, v_uv);
  if (u_dof == 1) {
    float z = max(v_viewZ, 1.0);
    float coc = abs(z - u_focus) / z * u_cocScale;
    float f = clamp(coc / max(u_cocMax, 1e-4), 0.0, 1.0);
    c = mix(c, texture(u_srcBlur, v_uv), f);
  }
  if (u_lit == 1 && c.a > 0.0) {
    vec3 N = normalize(u_normal);
    vec3 V = normalize(u_camPos - v_world);
    if (dot(N, V) < 0.0) N = -N;
    vec3 diffuse = vec3(0.0);
    vec3 spec = vec3(0.0);
    for (int i = 0; i < 8; i++) {
      if (i >= u_numLights) break;
      int type = int(u_lightPos[i].w + 0.5);
      vec3 L;
      float atten = 1.0;
      if (type == 0) {
        L = -normalize(u_lightDir[i].xyz);
      } else {
        vec3 d = u_lightPos[i].xyz - v_world;
        float dist = length(d);
        L = d / max(dist, 1e-4);
        int fo = int(u_lightParams[i].x + 0.5);
        if (fo == 1) atten = 1.0 - smoothstep(u_lightParams[i].y, u_lightParams[i].y + max(u_lightParams[i].z, 1.0), dist);
        else if (fo == 2) { float r = max(u_lightParams[i].y, 1.0); atten = dist <= r ? 1.0 : (r * r) / (dist * dist); }
        if (type == 1) {
          float cd = dot(-L, normalize(u_lightDir[i].xyz));
          atten *= smoothstep(u_lightDir[i].w, u_lightParams[i].w, cd);
        }
      }
      float ndl = max(dot(N, L), 0.0);
      diffuse += u_lightColor[i].rgb * ndl * atten;
      vec3 R = reflect(-L, N);
      float shin = mix(2.0, 256.0, u_material.w);
      spec += u_lightColor[i].rgb * pow(max(dot(R, V), 0.0), shin) * u_material.z * atten * step(0.0, ndl);
    }
    vec3 straight = c.rgb / c.a;
    vec3 lit = straight * (u_ambient * u_material.x + diffuse * u_material.y * 2.0);
    lit += spec * mix(vec3(1.0), straight, u_metal);
    c.rgb = lit * c.a;
  }
  if (c.a < u_alphaCut) discard;
  o = c * u_opacity;
}`;

/** Depth-only pre-pass for 3D intersections (writes depth where the layer is opaque enough). */
export const FS_DEPTH = `${HEADER}
in vec2 v_uv;
in vec3 v_world;
in float v_viewZ;
out vec4 o;
uniform sampler2D u_src;
void main() {
  if (texture(u_src, v_uv).a < 0.5) discard;
  o = vec4(0.0);
}`;
