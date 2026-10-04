// ─────────────────────────────────────────────────────────────────────────────
// Frame evaluation: resolves every animated value of a composition at a given
// time (keyframes + expressions), layer transforms, parenting chains,
// the active camera and lights. One FrameEval is created per (comp, time) and
// memoises results, so a full render pass evaluates each transform once.
//
// Transform order (column vectors, AE-compatible):
//   M_local = T(position) · Rx(or.x) · Ry(or.y) · Rz(or.z) · Rx(rx) · Ry(ry) · Rz(rz) · S(scale) · T(−anchor)
//   M_world = M_world(parent) · M_local
// Cameras:  C = T(position) · R_lookAt(position → POI) · R_orientation · R_rotation,  View = C⁻¹
// ─────────────────────────────────────────────────────────────────────────────

import type { AnimProp, Composition, Layer, Project, PropValue } from './types';
import { keyframedValue, velocityAt } from '../anim/interpolate';
import { evaluateExpression, wrapPropertyValue, type ExprHost } from '../anim/expressions';
import * as M from '../math/mat4';
import { getDescriptor, getProp } from './props';
import { hashString } from '../math/noise';
import { exactFps } from './time';
import { getEffectDef } from '../effects/catalog';
import { zoomForFocalLength } from './factory';

export const stretchFactor = (l: Layer): number => (l.stretch === 0 ? 1 : l.stretch / 100);
/** comp time → layer (keyframe) time */
export const toLayerTime = (l: Layer, compTime: number): number => (compTime - l.startTime) / stretchFactor(l);
/** layer (keyframe) time → comp time */
export const toCompTime = (l: Layer, layerTime: number): number => l.startTime + layerTime * stretchFactor(l);

export function layerSpan(l: Layer): [number, number] {
  return [Math.min(l.inPoint, l.outPoint), Math.max(l.inPoint, l.outPoint)];
}

export function isActiveAt(l: Layer, t: number): boolean {
  const [a, b] = layerSpan(l);
  return t >= a - 1e-7 && t < b - 1e-7;
}

export interface TransformValues {
  anchor: number[];
  position: number[];
  scale: number[];
  orientation: number[];
  rotationX: number;
  rotationY: number;
  rotation: number;
  opacity: number;
}

export interface CameraEval {
  layer: Layer | null;
  position: number[];
  camToWorld: M.Mat4;
  view: M.Mat4;
  zoom: number;
  depthOfField: boolean;
  focusDistance: number;
  aperture: number;
  blurLevel: number;
}

export interface LightEval {
  layer: Layer;
  kind: 'parallel' | 'spot' | 'point' | 'ambient';
  position: number[];
  direction: number[];
  color: [number, number, number];
  coneAngle: number;
  coneFeather: number;
  falloff: 'none' | 'smooth' | 'inverseSquare';
  radius: number;
  falloffDistance: number;
}

export function layerSourceSize(project: Project, comp: Composition, layer: Layer): { w: number; h: number } {
  switch (layer.type) {
    case 'solid':
    case 'null':
      return { w: layer.solid?.width ?? 100, h: layer.solid?.height ?? 100 };
    case 'image':
    case 'video': {
      const f = layer.source?.footageId ? project.footage[layer.source.footageId] : undefined;
      return { w: f?.width || comp.width, h: f?.height || comp.height };
    }
    case 'precomp': {
      const c = layer.source?.compId ? project.comps[layer.source.compId] : undefined;
      return { w: c?.width ?? comp.width, h: c?.height ?? comp.height };
    }
    default:
      return { w: comp.width, h: comp.height };
  }
}

export function defaultCameraZoom(comp: Composition): number {
  return zoomForFocalLength(comp.width, 50);
}

const SPATIAL_TRANSFORM = new Set(['transform.anchor', 'transform.position']);

export class FrameEval {
  readonly project: Project;
  readonly comp: Composition;
  readonly time: number;
  readonly depth: number;
  errors: Map<string, string> | null;
  private tvCache = new Map<string, TransformValues>();
  private worldCache = new Map<string, M.Mat4>();
  private byId: Map<string, Layer>;
  private camCache: CameraEval | undefined;
  private lightCache: LightEval[] | undefined;
  private children = new Map<number, FrameEval>();

  constructor(project: Project, comp: Composition, time: number, depth = 0, errors: Map<string, string> | null = null) {
    this.project = project;
    this.comp = comp;
    this.time = time;
    this.depth = depth;
    this.errors = errors;
    this.byId = new Map(comp.layers.map((l) => [l.id, l]));
  }

  layer(id: string | null | undefined): Layer | undefined {
    return id ? this.byId.get(id) : undefined;
  }

  /** Same comp at another time, one expression-recursion level deeper (memoised). */
  at(t: number): FrameEval {
    const key = Math.round(t * 1e6);
    let fe = this.children.get(key);
    if (!fe) {
      fe = new FrameEval(this.project, this.comp, t, this.depth + 1, this.errors);
      if (this.children.size > 64) this.children.clear();
      this.children.set(key, fe);
    }
    return fe;
  }

  /** Evaluate a property at this frame (keyframes, then expression). */
  prop<V extends PropValue>(layer: Layer, path: string, p?: AnimProp<V>, spatial?: boolean): V {
    const pr = (p ?? getProp(layer, path)) as AnimProp<V> | undefined;
    if (!pr) return undefined as unknown as V;
    const sp = spatial ?? (SPATIAL_TRANSFORM.has(path) || !!getDescriptor(layer, path).spatial);
    const lt = toLayerTime(layer, this.time);
    let v = pr.keyframes.length ? keyframedValue(pr, lt, sp) : pr.value;
    if (pr.expression && pr.expressionEnabled !== false && this.project.settings.expressionsEnabled) {
      v = this.runExpression(layer, path, pr, v, sp) as V;
    }
    return v;
  }

  private runExpression<V extends PropValue>(layer: Layer, path: string, p: AnimProp<V>, v: V, spatial: boolean): PropValue {
    if (this.depth > 6) return v;
    const sf = stretchFactor(layer);
    const host: ExprHost = {
      time: this.time,
      value: v,
      valueAtTime: (t) => (p.keyframes.length ? keyframedValue(p, toLayerTime(layer, t), spatial) : p.value),
      velocityAtTime: (t) => {
        const vel = velocityAt(p as AnimProp, toLayerTime(layer, t), spatial).map((x) => x / sf);
        return typeof v === 'number' ? vel[0] : vel;
      },
      numKeys: p.keyframes.length,
      key: (i) => {
        const k = p.keyframes[i - 1];
        return k ? { time: toCompTime(layer, k.t), value: k.v, index: i } : null;
      },
      frameDuration: 1 / exactFps(this.comp.frameRate),
      seed: hashString(`${layer.id}:${path}`),
      thisLayer: this.layerProxy(layer),
      thisComp: this.compProxy(),
      comp: (name) => {
        const c = Object.values(this.project.comps).find((x) => x.name === name);
        return c ? new FrameEval(this.project, c, this.time, this.depth + 1, this.errors).compProxy() : null;
      },
      inPoint: layer.inPoint,
      outPoint: layer.outPoint,
    };
    const r = evaluateExpression(p.expression!, host);
    if (this.errors) {
      const key = `${layer.id}|${path}`;
      if (r.error) this.errors.set(key, r.error);
      else this.errors.delete(key);
    }
    return r.value as PropValue;
  }

  // ── expression proxies ────────────────────────────────────────────────────

  layerProxy(layer: Layer): Record<string, unknown> {
    const fe = this;
    const index = this.comp.layers.indexOf(layer) + 1;
    const read = (path: string) => () => {
      const p = getProp(layer, path);
      if (!p) return undefined;
      const val = fe.at(fe.time).prop(layer, path, p);
      return wrapPropertyValue(
        val,
        (t) => fe.at(t).prop(layer, path, p),
        (t) => {
          const vel = velocityAt(p, toLayerTime(layer, t), SPATIAL_TRANSFORM.has(path));
          return typeof val === 'number' ? vel[0] : vel;
        },
      );
    };
    const transform: Record<string, unknown> = {};
    const tmap: [string, string][] = [
      ['anchorPoint', 'transform.anchor'], ['position', 'transform.position'], ['scale', 'transform.scale'],
      ['rotation', 'transform.rotation'], ['zRotation', 'transform.rotation'], ['xRotation', 'transform.rotationX'],
      ['yRotation', 'transform.rotationY'], ['orientation', 'transform.orientation'], ['opacity', 'transform.opacity'],
    ];
    for (const [k, path] of tmap) Object.defineProperty(transform, k, { get: read(path), enumerable: true });
    const size = layerSourceSize(this.project, this.comp, layer);
    const obj: Record<string, unknown> = {
      name: layer.name,
      index,
      inPoint: layer.inPoint,
      outPoint: layer.outPoint,
      startTime: layer.startTime,
      width: size.w,
      height: size.h,
      hasParent: !!layer.parentId,
      transform,
      effect: (n: string | number) => {
        const fx = typeof n === 'number' ? layer.effects[n - 1] : layer.effects.find((e) => e.name === n) ?? layer.effects.find((e) => getEffectDef(e.type)?.name === n);
        if (!fx) throw new Error(`Effect "${n}" not found on layer "${layer.name}"`);
        const def = getEffectDef(fx.type);
        return (pn: string | number) => {
          const pd = typeof pn === 'number' ? def?.params[pn - 1] : def?.params.find((q) => q.name === pn || q.id === pn);
          if (!pd) throw new Error(`Parameter "${pn}" not found in effect "${fx.name}"`);
          return read(`effects.${fx.id}.params.${pd.id}`)();
        };
      },
      toComp: (pt: number[]) => fe.toComp(layer, pt),
      toWorld: (pt: number[]) => M.transformPoint(fe.worldMatrix(layer), pt),
      fromComp: (pt: number[]) => {
        const inv = M.invert(fe.worldMatrix(layer));
        return inv ? M.transformPoint(inv, pt).slice(0, pt.length) : pt;
      },
      sourceRectAtTime: () => ({ left: 0, top: 0, width: size.w, height: size.h }),
    };
    for (const [k, path] of tmap) Object.defineProperty(obj, k, { get: read(path), enumerable: true });
    Object.defineProperty(obj, 'parent', {
      get: () => {
        const p = fe.layer(layer.parentId);
        return p ? fe.layerProxy(p) : null;
      },
      enumerable: true,
    });
    if (layer.text) {
      Object.defineProperty(obj, 'text', {
        get: () => ({ sourceText: fe.prop(layer, 'text.sourceText', layer.text!.sourceText) }),
        enumerable: true,
      });
    }
    if (layer.timeRemapEnabled) Object.defineProperty(obj, 'timeRemap', { get: read('timeRemap'), enumerable: true });
    return obj;
  }

  compProxy(): Record<string, unknown> {
    const fe = this;
    return {
      name: this.comp.name,
      width: this.comp.width,
      height: this.comp.height,
      duration: this.comp.duration,
      frameDuration: 1 / exactFps(this.comp.frameRate),
      numLayers: this.comp.layers.length,
      bgColor: this.comp.bgColor,
      layer: (x: string | number) => {
        const l = typeof x === 'number' ? fe.comp.layers[x - 1] : fe.comp.layers.find((q) => q.name === x);
        if (!l) throw new Error(`Layer "${x}" not found`);
        return fe.layerProxy(l);
      },
    };
  }

  // ── transforms ────────────────────────────────────────────────────────────

  transformValues(layer: Layer): TransformValues {
    const hit = this.tvCache.get(layer.id);
    if (hit) return hit;
    const t = layer.transform;
    const tv: TransformValues = {
      anchor: this.prop(layer, 'transform.anchor', t.anchor, true),
      position: this.prop(layer, 'transform.position', t.position, true),
      scale: this.prop(layer, 'transform.scale', t.scale, false),
      orientation: this.prop(layer, 'transform.orientation', t.orientation, false),
      rotationX: this.prop(layer, 'transform.rotationX', t.rotationX, false),
      rotationY: this.prop(layer, 'transform.rotationY', t.rotationY, false),
      rotation: this.prop(layer, 'transform.rotation', t.rotation, false),
      opacity: this.prop(layer, 'transform.opacity', t.opacity, false),
    };
    if (layer.autoOrient === 'path' && t.position.keyframes.length > 1) {
      const lt = toLayerTime(layer, this.time);
      const v = velocityAt(t.position, lt, true);
      if (Math.hypot(v[0], v[1]) > 1e-6) tv.rotation += (Math.atan2(v[1], v[0]) * 180) / Math.PI;
      else {
        // at rest: use direction toward/away from the nearest movement
        const a = keyframedValue(t.position, lt - 0.05, true);
        const b = keyframedValue(t.position, lt + 0.05, true);
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-6) tv.rotation += (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
      }
    }
    this.tvCache.set(layer.id, tv);
    return tv;
  }

  localMatrix(layer: Layer): M.Mat4 {
    const tv = this.transformValues(layer);
    if (layer.type === 'camera' || layer.type === 'light') return this.cameraLikeLocal(layer, tv);
    const s = tv.scale;
    if (!layer.threeD) {
      return M.mulAll(
        M.translation(tv.position[0], tv.position[1], 0),
        M.rotationZ(tv.rotation),
        M.scaling(s[0] / 100, s[1] / 100, 1),
        M.translation(-tv.anchor[0], -tv.anchor[1], 0),
      );
    }
    let orient = M.mulAll(M.rotationX(tv.orientation[0]), M.rotationY(tv.orientation[1]), M.rotationZ(tv.orientation[2]));
    if (layer.autoOrient === 'camera') {
      const cam = this.camera();
      const parentW = layer.parentId ? this.worldMatrixById(layer.parentId) : null;
      const worldPos = parentW ? M.transformPoint(parentW, tv.position) : tv.position;
      orient = M.multiply(M.lookAtRotation(cam.position, worldPos), orient);
    }
    return M.mulAll(
      M.translation(tv.position[0], tv.position[1], tv.position[2] ?? 0),
      orient,
      M.rotationX(tv.rotationX),
      M.rotationY(tv.rotationY),
      M.rotationZ(tv.rotation),
      M.scaling(s[0] / 100, s[1] / 100, (s[2] ?? 100) / 100),
      M.translation(-tv.anchor[0], -tv.anchor[1], -(tv.anchor[2] ?? 0)),
    );
  }

  private cameraLikeLocal(layer: Layer, tv: TransformValues): M.Mat4 {
    let look = M.identity();
    const twoNode = layer.type === 'camera' ? layer.camera?.kind !== 'oneNode' : layer.light?.kind !== 'point' && layer.light?.kind !== 'ambient';
    const poiProp = layer.camera?.pointOfInterest ?? layer.light?.pointOfInterest;
    if (twoNode && poiProp) {
      const poi = this.prop(layer, layer.type === 'camera' ? 'camera.pointOfInterest' : 'light.pointOfInterest', poiProp, true);
      look = M.lookAtRotation(tv.position, poi);
    }
    return M.mulAll(
      M.translation(tv.position[0], tv.position[1], tv.position[2] ?? 0),
      look,
      M.rotationX(tv.orientation[0]), M.rotationY(tv.orientation[1]), M.rotationZ(tv.orientation[2]),
      M.rotationX(tv.rotationX), M.rotationY(tv.rotationY), M.rotationZ(tv.rotation),
    );
  }

  worldMatrixById(id: string): M.Mat4 {
    const l = this.byId.get(id);
    return l ? this.worldMatrix(l) : M.identity();
  }

  worldMatrix(layer: Layer, guard = 0): M.Mat4 {
    const hit = this.worldCache.get(layer.id);
    if (hit) return hit;
    let m = this.localMatrix(layer);
    const parent = this.layer(layer.parentId);
    if (parent && guard < 32 && parent.id !== layer.id) m = M.multiply(this.worldMatrix(parent, guard + 1), m);
    this.worldCache.set(layer.id, m);
    return m;
  }

  opacity(layer: Layer): number {
    return Math.max(0, Math.min(100, this.transformValues(layer).opacity)) / 100;
  }

  /** True if this layer or any ancestor is 3D (it then lives in camera space). */
  is3D(layer: Layer): boolean {
    return layer.threeD;
  }

  toComp(layer: Layer, pt: number[]): number[] {
    const w = M.transformPoint(this.worldMatrix(layer), pt);
    if (!layer.threeD) return [w[0], w[1]];
    const cam = this.camera();
    const c = M.transformPoint(cam.view, w);
    const z = Math.max(1e-3, c[2]);
    return [this.comp.width / 2 + (cam.zoom * c[0]) / z, this.comp.height / 2 + (cam.zoom * c[1]) / z];
  }

  // ── camera & lights ───────────────────────────────────────────────────────

  activeCameraLayer(): Layer | null {
    for (const l of this.comp.layers) {
      if (l.type === 'camera' && l.enabled && isActiveAt(l, this.time)) return l;
    }
    return null;
  }

  camera(): CameraEval {
    if (this.camCache) return this.camCache;
    const layer = this.activeCameraLayer();
    let cam: CameraEval;
    if (!layer || !layer.camera) {
      const zoom = defaultCameraZoom(this.comp);
      const position = [this.comp.width / 2, this.comp.height / 2, -zoom];
      const camToWorld = M.translation(position[0], position[1], position[2]);
      cam = {
        layer: null, position, camToWorld, view: M.invert(camToWorld)!, zoom,
        depthOfField: false, focusDistance: zoom, aperture: 0, blurLevel: 100,
      };
    } else {
      const c = layer.camera;
      const camToWorld = this.worldMatrix(layer);
      const view = M.invert(camToWorld) ?? M.identity();
      cam = {
        layer,
        position: M.getTranslation(camToWorld),
        camToWorld,
        view,
        zoom: Math.max(1, this.prop(layer, 'camera.zoom', c.zoom, false)),
        depthOfField: c.depthOfField,
        focusDistance: Math.max(1, this.prop(layer, 'camera.focusDistance', c.focusDistance, false)),
        aperture: Math.max(0, this.prop(layer, 'camera.aperture', c.aperture, false)),
        blurLevel: Math.max(0, this.prop(layer, 'camera.blurLevel', c.blurLevel, false)),
      };
    }
    this.camCache = cam;
    return cam;
  }

  lights(): LightEval[] {
    if (this.lightCache) return this.lightCache;
    const out: LightEval[] = [];
    for (const l of this.comp.layers) {
      if (l.type !== 'light' || !l.light || !l.enabled || !isActiveAt(l, this.time)) continue;
      const d = l.light;
      const w = this.worldMatrix(l);
      const position = M.getTranslation(w);
      let direction = [0, 0, 1];
      if (d.kind === 'spot' || d.kind === 'parallel') direction = M.transformDir(w, [0, 0, 1]);
      const dl = Math.hypot(direction[0], direction[1], direction[2]) || 1;
      direction = direction.map((x) => x / dl);
      const color = this.prop(l, 'light.color', d.color, false);
      const intensity = this.prop(l, 'light.intensity', d.intensity, false) / 100;
      out.push({
        layer: l,
        kind: d.kind,
        position,
        direction,
        color: [color[0] * intensity, color[1] * intensity, color[2] * intensity],
        coneAngle: this.prop(l, 'light.coneAngle', d.coneAngle, false),
        coneFeather: this.prop(l, 'light.coneFeather', d.coneFeather, false) / 100,
        falloff: d.falloff,
        radius: this.prop(l, 'light.radius', d.radius, false),
        falloffDistance: this.prop(l, 'light.falloffDistance', d.falloffDistance, false),
      });
    }
    this.lightCache = out;
    return out;
  }

  /** Source time for footage/precomp layers (time stretch, reverse, time remap). */
  sourceTime(layer: Layer): number {
    if (layer.timeRemapEnabled) return this.prop(layer, 'timeRemap', layer.timeRemap, false);
    return toLayerTime(layer, this.time);
  }
}

