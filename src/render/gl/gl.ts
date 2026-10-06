// ─────────────────────────────────────────────────────────────────────────────
// WebGL2 core: programs with reflection-driven uniform setters, pooled render
// targets (texture + framebuffer), full-screen pass helper and uploads.
//
// Texture convention: row 0 is the TOP of the image everywhere (uploads use
// UNPACK_FLIP_Y = false and render targets are addressed with a non-flipping
// projection). Only the final present pass flips for the canvas.
// All colour data is PREMULTIPLIED alpha.
// ─────────────────────────────────────────────────────────────────────────────

export type TexFormat = 'rgba8' | 'rgba16f' | 'rgba32f';

export interface Tex {
  id: number;
  tex: WebGLTexture;
  fbo: WebGLFramebuffer | null;
  w: number;
  h: number;
  format: TexFormat;
  pooled: boolean;
  inUse: boolean;
  lastUsed: number;
  mipmapped: boolean;
}

type UniformValue = number | boolean | number[] | Float32Array | Int32Array;

interface UniformInfo {
  loc: WebGLUniformLocation;
  type: number;
  size: number;
}

export class Program {
  readonly prog: WebGLProgram;
  private uniforms = new Map<string, UniformInfo>();
  private samplerUnits = new Map<string, number>();
  readonly gl: WebGL2RenderingContext;
  readonly name: string;

  constructor(gl: WebGL2RenderingContext, name: string, vs: string, fs: string) {
    this.gl = gl;
    this.name = name;
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh);
        const numbered = src.split('\n').map((l, i) => `${String(i + 1).padStart(4)}: ${l}`).join('\n');
        throw new Error(`[${name}] shader compile error:\n${log}\n${numbered}`);
      }
      return sh;
    };
    const p = gl.createProgram()!;
    const v = compile(gl.VERTEX_SHADER, vs);
    const f = compile(gl.FRAGMENT_SHADER, fs);
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.bindAttribLocation(p, 0, 'a_pos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`[${name}] link error: ${gl.getProgramInfoLog(p)}`);
    gl.deleteShader(v);
    gl.deleteShader(f);
    this.prog = p;
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
    let unit = 0;
    for (let k = 0; k < n; k++) {
      const info = gl.getActiveUniform(p, k);
      if (!info) continue;
      const base = info.name.replace(/\[0\]$/, '');
      const loc = gl.getUniformLocation(p, info.name);
      if (!loc) continue;
      this.uniforms.set(base, { loc, type: info.type, size: info.size });
      if (info.type === gl.SAMPLER_2D) this.samplerUnits.set(base, unit++);
    }
  }

  use(): void {
    this.gl.useProgram(this.prog);
  }

  has(name: string): boolean {
    return this.uniforms.has(name);
  }

  set(name: string, value: UniformValue): void {
    const u = this.uniforms.get(name);
    if (!u) return;
    const gl = this.gl;
    const arr = typeof value === 'number' || typeof value === 'boolean' ? null : value;
    const num = typeof value === 'boolean' ? (value ? 1 : 0) : (value as number);
    switch (u.type) {
      case gl.FLOAT: arr ? gl.uniform1fv(u.loc, arr as Float32List) : gl.uniform1f(u.loc, num); break;
      case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, arr as Float32List); break;
      case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, arr as Float32List); break;
      case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, arr as Float32List); break;
      case gl.INT:
      case gl.BOOL: arr ? gl.uniform1iv(u.loc, arr as Int32List) : gl.uniform1i(u.loc, Math.round(num)); break;
      case gl.INT_VEC2: gl.uniform2iv(u.loc, arr as Int32List); break;
      case gl.FLOAT_MAT3: gl.uniformMatrix3fv(u.loc, false, arr as Float32List); break;
      case gl.FLOAT_MAT4: gl.uniformMatrix4fv(u.loc, false, arr as Float32List); break;
      default: break;
    }
  }

  /** Bind a texture to the sampler uniform `name`. */
  tex(name: string, t: Tex | WebGLTexture | null, linear = true): void {
    const unit = this.samplerUnits.get(name);
    const u = this.uniforms.get(name);
    if (unit === undefined || !u) return;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    const glTex = t && 'tex' in (t as Tex) ? (t as Tex).tex : (t as WebGLTexture | null);
    gl.bindTexture(gl.TEXTURE_2D, glTex);
    if (glTex && t && 'tex' in (t as Tex)) {
      const tt = t as Tex;
      const filt = linear ? gl.LINEAR : gl.NEAREST;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, tt.mipmapped && linear ? gl.LINEAR_MIPMAP_LINEAR : filt);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filt);
    }
    gl.uniform1i(u.loc, unit);
  }
}

export const FULLSCREEN_VS = `#version 300 es
layout(location = 0) in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos;
  gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
}`;

export interface PassOptions {
  blend?: 'none' | 'premult' | 'add' | 'max';
  clear?: boolean;
  viewport?: [number, number, number, number];
}

let texIds = 1;

export class GLContext {
  readonly gl: WebGL2RenderingContext;
  readonly canvas: OffscreenCanvas | HTMLCanvasElement;
  readonly floatRender: boolean;
  readonly floatLinear: boolean;
  readonly maxTex: number;
  private programs = new Map<string, Program>();
  private pool: Tex[] = [];
  private frameNo = 0;
  readonly quadVAO: WebGLVertexArrayObject;
  readonly quadVBO: WebGLBuffer;
  private dynVAO: WebGLVertexArrayObject;
  private dynVBO: WebGLBuffer;
  private depthBuffers = new Map<string, WebGLRenderbuffer>();
  lost = false;

  constructor(canvas: OffscreenCanvas | HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = (canvas as OffscreenCanvas).getContext('webgl2', {
      alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: true, powerPreference: 'high-performance',
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.floatRender = !!gl.getExtension('EXT_color_buffer_float');
    this.floatLinear = !!gl.getExtension('OES_texture_float_linear');
    gl.getExtension('EXT_color_buffer_half_float');
    this.maxTex = Math.min(8192, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    // fullscreen quad (0..1)
    this.quadVAO = gl.createVertexArray()!;
    this.quadVBO = gl.createBuffer()!;
    gl.bindVertexArray(this.quadVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    // dynamic quad for arbitrary geometry (layer quads)
    this.dynVAO = gl.createVertexArray()!;
    this.dynVBO = gl.createBuffer()!;
    gl.bindVertexArray(this.dynVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynVBO);
    gl.bufferData(gl.ARRAY_BUFFER, 8 * 4 * 64, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    if ('addEventListener' in canvas) {
      (canvas as OffscreenCanvas).addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        this.lost = true;
      });
    }
  }

  program(name: string, fs: string, vs = FULLSCREEN_VS): Program {
    let p = this.programs.get(name);
    if (!p) {
      p = new Program(this.gl, name, vs, fs);
      this.programs.set(name, p);
    }
    return p;
  }

  /** Pick a render format honoring capabilities. */
  format(bitDepth: number): TexFormat {
    if (bitDepth >= 16 && this.floatRender) return 'rgba16f';
    return 'rgba8';
  }

  private allocTex(w: number, h: number, format: TexFormat): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    const ifmt = format === 'rgba16f' ? gl.RGBA16F : format === 'rgba32f' ? gl.RGBA32F : gl.RGBA8;
    gl.texStorage2D(gl.TEXTURE_2D, 1, ifmt, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  /** Acquire a pooled render target. Contents are undefined unless `clear` is passed. */
  acquire(w: number, h: number, format: TexFormat = 'rgba8', clear = true): Tex {
    w = Math.max(1, Math.min(this.maxTex, Math.round(w)));
    h = Math.max(1, Math.min(this.maxTex, Math.round(h)));
    let t = this.pool.find((p) => !p.inUse && p.w === w && p.h === h && p.format === format);
    if (!t) {
      const gl = this.gl;
      const tex = this.allocTex(w, h, format);
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      t = { id: texIds++, tex, fbo, w, h, format, pooled: true, inUse: false, lastUsed: 0, mipmapped: false };
      this.pool.push(t);
    }
    t.inUse = true;
    t.lastUsed = this.frameNo;
    if (clear) this.clear(t);
    return t;
  }

  release(t: Tex | null | undefined): void {
    if (t && t.pooled) t.inUse = false;
  }

  /** A standalone (non-pooled) texture for uploaded sources. */
  createUploadTexture(): Tex {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return { id: texIds++, tex, fbo: null, w: 1, h: 1, format: 'rgba8', pooled: false, inUse: true, lastUsed: this.frameNo, mipmapped: false };
  }

  /** Upload an image-like source (premultiplying straight alpha). */
  upload(t: Tex, src: TexImageSource, w: number, h: number, opts: { premultiply?: boolean; mipmaps?: boolean } = {}): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, opts.premultiply !== false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    t.w = w;
    t.h = h;
    t.mipmapped = !!opts.mipmaps;
    if (opts.mipmaps) gl.generateMipmap(gl.TEXTURE_2D);
    t.lastUsed = this.frameNo;
  }

  uploadPixels(t: Tex, data: Uint8Array | Float32Array, w: number, h: number, float = false): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data as Float32Array);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data as Uint8Array);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    if (float && !this.floatLinear) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    }
    t.w = w;
    t.h = h;
  }

  deleteTex(t: Tex): void {
    const gl = this.gl;
    gl.deleteTexture(t.tex);
    if (t.fbo) gl.deleteFramebuffer(t.fbo);
    const i = this.pool.indexOf(t);
    if (i >= 0) this.pool.splice(i, 1);
  }

  bindTarget(t: Tex | null, w?: number, h?: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null);
    gl.viewport(0, 0, t ? t.w : w ?? this.canvas.width, t ? t.h : h ?? this.canvas.height);
  }

  clear(t: Tex | null, color: [number, number, number, number] = [0, 0, 0, 0]): void {
    const gl = this.gl;
    this.bindTarget(t);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(color[0], color[1], color[2], color[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  setBlend(mode: PassOptions['blend']): void {
    const gl = this.gl;
    if (!mode || mode === 'none') {
      gl.disable(gl.BLEND);
      return;
    }
    gl.enable(gl.BLEND);
    if (mode === 'premult') {
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    } else if (mode === 'add') {
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE);
    } else if (mode === 'max') {
      gl.blendEquation(gl.MAX);
      gl.blendFunc(gl.ONE, gl.ONE);
    }
  }

  /** Draw a full-screen quad with `prog` into `target`. Program uniforms must be set by the caller after use(). */
  pass(prog: Program, target: Tex | null, setup: (p: Program) => void, opts: PassOptions = {}): void {
    const gl = this.gl;
    this.bindTarget(target);
    if (opts.viewport) gl.viewport(...opts.viewport);
    if (opts.clear) {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    prog.use();
    setup(prog);
    this.setBlend(opts.blend);
    gl.bindVertexArray(this.quadVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }

  /** Draw arbitrary 2D vertex positions (triangle strip) using the dynamic buffer. */
  drawStrip(prog: Program, target: Tex | null, verts: Float32Array, setup: (p: Program) => void, opts: PassOptions = {}): void {
    const gl = this.gl;
    this.bindTarget(target);
    prog.use();
    setup(prog);
    this.setBlend(opts.blend);
    gl.bindVertexArray(this.dynVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynVBO);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, verts);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, verts.length / 2);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }

  /** Depth renderbuffer per size and nesting slot (nested comps must not clobber a parent's 3D run). */
  depthBuffer(w: number, h: number, slot = 0): WebGLRenderbuffer {
    const key = `${w}x${h}#${slot}`;
    let rb = this.depthBuffers.get(key);
    if (!rb) {
      const gl = this.gl;
      rb = gl.createRenderbuffer()!;
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
      if (this.depthBuffers.size > 12) {
        for (const [k, v] of this.depthBuffers) {
          gl.deleteRenderbuffer(v);
          this.depthBuffers.delete(k);
          break;
        }
      }
      this.depthBuffers.set(key, rb);
    }
    return rb;
  }

  attachDepth(t: Tex, rb: WebGLRenderbuffer | null): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
  }

  beginFrame(): void {
    this.frameNo++;
  }

  /** Release every pooled texture still marked in-use and trim stale pool entries. */
  endFrame(keep: Set<Tex> = new Set()): void {
    for (const t of this.pool) if (!keep.has(t)) t.inUse = false;
    const stale = this.pool.filter((t) => !t.inUse && this.frameNo - t.lastUsed > 90);
    for (const t of stale) this.deleteTex(t);
    // keep the pool bounded
    let bytes = this.pool.reduce((s, t) => s + t.w * t.h * (t.format === 'rgba8' ? 4 : t.format === 'rgba16f' ? 8 : 16), 0);
    const budget = 1024 * 1024 * 1024;
    if (bytes > budget) {
      const idle = this.pool.filter((t) => !t.inUse).sort((a, b) => a.lastUsed - b.lastUsed);
      for (const t of idle) {
        if (bytes <= budget * 0.7) break;
        bytes -= t.w * t.h * (t.format === 'rgba8' ? 4 : t.format === 'rgba16f' ? 8 : 16);
        this.deleteTex(t);
      }
    }
  }

  stats(): { pooled: number; inUse: number; mb: number } {
    const bytes = this.pool.reduce((s, t) => s + t.w * t.h * (t.format === 'rgba8' ? 4 : t.format === 'rgba16f' ? 8 : 16), 0);
    return { pooled: this.pool.length, inUse: this.pool.filter((t) => t.inUse).length, mb: bytes / 1048576 };
  }
}
