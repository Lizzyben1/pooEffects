// Property construction, addressing and descriptor lookup.

import type {
  AnimProp, Layer, PropDescriptor, PropPath, PropValue, ShapeItem, ShapeItemType, TextAnimatorPropKey,
} from './types';
import { getParamDef } from '../effects/catalog';

export function prop<V extends PropValue>(value: V): AnimProp<V> {
  return { value, keyframes: [] };
}

export function isAnimProp(x: unknown): x is AnimProp {
  return !!x && typeof x === 'object' && 'value' in (x as object) && Array.isArray((x as AnimProp).keyframes);
}

// ── addressing ──────────────────────────────────────────────────────────────

/** Walk a dot path. Array segments are resolved by element `id`. Works on immer drafts too. */
export function getAt(root: unknown, path: PropPath): any {
  let cur: any = root;
  if (!path) return cur;
  for (const seg of path.split('.')) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) cur = cur.find((x: any) => x && x.id === seg);
    else cur = cur[seg];
  }
  return cur;
}

export function getProp(layer: Layer, path: PropPath): AnimProp | undefined {
  const p = getAt(layer, path);
  return isAnimProp(p) ? p : undefined;
}

export function parentPath(path: PropPath): PropPath {
  const i = path.lastIndexOf('.');
  return i < 0 ? '' : path.slice(0, i);
}

export function lastSeg(path: PropPath): string {
  const i = path.lastIndexOf('.');
  return i < 0 ? path : path.slice(i + 1);
}

// ── descriptors ─────────────────────────────────────────────────────────────

const pct = (name: string, extra: Partial<PropDescriptor> = {}): PropDescriptor =>
  ({ name, kind: 'percent', min: 0, max: 100, softMin: 0, softMax: 100, unit: '%', precision: 1, ...extra });
const num = (name: string, extra: Partial<PropDescriptor> = {}): PropDescriptor => ({ name, kind: 'number', precision: 1, ...extra });
const ang = (name: string): PropDescriptor => ({ name, kind: 'angle' });

export const TRANSFORM_DESCS: Record<string, PropDescriptor> = {
  anchor: { name: 'Anchor Point', kind: 'point3', spatial: true, dims: 3, precision: 1 },
  position: { name: 'Position', kind: 'point3', spatial: true, dims: 3, precision: 1 },
  scale: { name: 'Scale', kind: 'vec3', dims: 3, unit: '%', precision: 1 },
  orientation: { name: 'Orientation', kind: 'vec3', dims: 3, unit: '°', precision: 1 },
  rotationX: ang('X Rotation'),
  rotationY: ang('Y Rotation'),
  rotation: ang('Rotation'),
  opacity: pct('Opacity'),
};

export const MASK_DESCS: Record<string, PropDescriptor> = {
  path: { name: 'Mask Path', kind: 'path' },
  feather: { name: 'Mask Feather', kind: 'vec2', dims: 2, min: 0, unit: 'px', precision: 1 },
  opacity: pct('Mask Opacity'),
  expansion: num('Mask Expansion', { unit: 'px' }),
};

export const CAMERA_DESCS: Record<string, PropDescriptor> = {
  pointOfInterest: { name: 'Point of Interest', kind: 'point3', spatial: true, dims: 3, precision: 1 },
  zoom: num('Zoom', { min: 1, unit: 'px' }),
  focusDistance: num('Focus Distance', { min: 1, unit: 'px' }),
  aperture: num('Aperture', { min: 0, unit: 'px' }),
  blurLevel: pct('Blur Level', { max: 1000, softMax: 300 }),
};

export const LIGHT_DESCS: Record<string, PropDescriptor> = {
  pointOfInterest: { name: 'Point of Interest', kind: 'point3', spatial: true, dims: 3, precision: 1 },
  intensity: pct('Intensity', { max: 10000, softMax: 300 }),
  color: { name: 'Color', kind: 'color' },
  coneAngle: { name: 'Cone Angle', kind: 'angle', min: 0, max: 180 },
  coneFeather: pct('Cone Feather'),
  radius: num('Radius', { min: 0, unit: 'px' }),
  falloffDistance: num('Falloff Distance', { min: 0, unit: 'px' }),
};

export const TRACK_POINT_DESCS: Record<string, PropDescriptor> = {
  featureCenter: { name: 'Feature Center', kind: 'point2', dims: 2, spatial: true, precision: 2 },
  confidence: pct('Confidence', { precision: 1 }),
  attachPoint: { name: 'Attach Point', kind: 'point2', dims: 2, spatial: true, precision: 2 },
};

export const MATERIAL_DESCS: Record<string, PropDescriptor> = {
  ambient: pct('Ambient'),
  diffuse: pct('Diffuse'),
  specularIntensity: pct('Specular Intensity'),
  specularShininess: pct('Specular Shininess'),
  metal: pct('Metal'),
};

export const SHAPE_TRANSFORM_DESCS: Record<string, PropDescriptor> = {
  anchor: { name: 'Anchor Point', kind: 'point2', dims: 2, spatial: true, precision: 1 },
  position: { name: 'Position', kind: 'point2', dims: 2, spatial: true, precision: 1 },
  scale: { name: 'Scale', kind: 'vec2', dims: 2, unit: '%', precision: 1 },
  rotation: ang('Rotation'),
  opacity: pct('Opacity'),
  skew: { name: 'Skew', kind: 'number', min: -85, max: 85, precision: 1 },
  skewAxis: ang('Skew Axis'),
};

const gradientDescs: Record<string, PropDescriptor> = {
  start: { name: 'Start Point', kind: 'point2', dims: 2, spatial: true, precision: 1 },
  end: { name: 'End Point', kind: 'point2', dims: 2, spatial: true, precision: 1 },
  colors: { name: 'Colors', kind: 'gradient' },
  opacity: pct('Opacity'),
};

const dashDescs: Record<string, PropDescriptor> = {
  'dashes.dash': num('Dash', { min: 0 }),
  'dashes.gap': num('Gap', { min: 0 }),
  'dashes.offset': num('Offset'),
};

export const SHAPE_DESCS: Record<ShapeItemType, Record<string, PropDescriptor>> = {
  group: Object.fromEntries(Object.entries(SHAPE_TRANSFORM_DESCS).map(([k, d]) => [`transform.${k}`, d])),
  rect: {
    size: { name: 'Size', kind: 'vec2', dims: 2, min: 0, precision: 1 },
    position: { name: 'Position', kind: 'point2', dims: 2, spatial: true, precision: 1 },
    roundness: num('Roundness', { min: 0 }),
  },
  ellipse: {
    size: { name: 'Size', kind: 'vec2', dims: 2, min: 0, precision: 1 },
    position: { name: 'Position', kind: 'point2', dims: 2, spatial: true, precision: 1 },
  },
  polystar: {
    points: num('Points', { min: 3, max: 100 }),
    position: { name: 'Position', kind: 'point2', dims: 2, spatial: true, precision: 1 },
    rotation: ang('Rotation'),
    innerRadius: num('Inner Radius', { min: 0 }),
    outerRadius: num('Outer Radius', { min: 0 }),
    innerRoundness: pct('Inner Roundness', { min: -100, softMin: -100 }),
    outerRoundness: pct('Outer Roundness', { min: -100, softMin: -100 }),
  },
  path: { path: { name: 'Path', kind: 'path' } },
  fill: { color: { name: 'Color', kind: 'color' }, opacity: pct('Opacity') },
  stroke: { color: { name: 'Color', kind: 'color' }, opacity: pct('Opacity'), width: num('Stroke Width', { min: 0 }), ...dashDescs },
  gfill: { ...gradientDescs },
  gstroke: { ...gradientDescs, width: num('Stroke Width', { min: 0 }), ...dashDescs },
  trim: { start: pct('Start'), end: pct('End'), offset: ang('Offset') },
  repeater: {
    copies: num('Copies', { min: 0, max: 1000 }),
    offset: num('Offset'),
    'transform.anchor': { name: 'Anchor Point', kind: 'point2', dims: 2, spatial: true, precision: 1 },
    'transform.position': { name: 'Position', kind: 'point2', dims: 2, spatial: true, precision: 1 },
    'transform.scale': { name: 'Scale', kind: 'vec2', dims: 2, unit: '%', precision: 1 },
    'transform.rotation': ang('Rotation'),
    'transform.startOpacity': pct('Start Opacity'),
    'transform.endOpacity': pct('End Opacity'),
  },
  merge: {},
  zigzag: { size: num('Size'), ridges: num('Ridges per segment', { min: 0, max: 100 }) },
  roundCorners: { radius: num('Radius', { min: 0 }) },
  offset: { amount: num('Amount') },
  puckerBloat: { amount: { name: 'Amount', kind: 'number', softMin: -100, softMax: 100, unit: '%', precision: 1 } },
  twist: { angle: ang('Angle'), center: { name: 'Center', kind: 'point2', dims: 2, spatial: true, precision: 1 } },
  wiggle: {
    size: num('Size', { min: 0 }),
    detail: num('Detail', { min: 0, max: 10 }),
    wigglesPerSecond: num('Wiggles/Second'),
    correlation: pct('Correlation'),
    temporalPhase: ang('Temporal Phase'),
    spatialPhase: ang('Spatial Phase'),
  },
};

export const SHAPE_TYPE_NAMES: Record<ShapeItemType, string> = {
  group: 'Group', rect: 'Rectangle', ellipse: 'Ellipse', polystar: 'Polystar', path: 'Path',
  fill: 'Fill', stroke: 'Stroke', gfill: 'Gradient Fill', gstroke: 'Gradient Stroke',
  trim: 'Trim Paths', repeater: 'Repeater', merge: 'Merge Paths', zigzag: 'Zig Zag',
  roundCorners: 'Round Corners', offset: 'Offset Paths', puckerBloat: 'Pucker & Bloat',
  twist: 'Twist', wiggle: 'Wiggle Paths',
};

export const TEXT_ANIM_DESCS: Record<TextAnimatorPropKey, PropDescriptor> = {
  anchor: { name: 'Anchor Point', kind: 'vec2', dims: 2, precision: 1 },
  position: { name: 'Position', kind: 'vec3', dims: 3, precision: 1 },
  scale: { name: 'Scale', kind: 'vec2', dims: 2, unit: '%', precision: 1 },
  skew: num('Skew'),
  rotation: ang('Rotation'),
  opacity: pct('Opacity'),
  fillColor: { name: 'Fill Color', kind: 'color' },
  strokeColor: { name: 'Stroke Color', kind: 'color' },
  strokeWidth: num('Stroke Width', { min: 0 }),
  tracking: num('Tracking Amount'),
  blur: { name: 'Blur', kind: 'vec2', dims: 2, min: 0, precision: 1 },
};

export const TEXT_ANIM_ORDER: TextAnimatorPropKey[] = [
  'anchor', 'position', 'scale', 'skew', 'rotation', 'opacity', 'fillColor', 'strokeColor', 'strokeWidth', 'tracking', 'blur',
];

export const RANGE_SELECTOR_DESCS: Record<string, PropDescriptor> = {
  start: pct('Start', { min: -100000, max: 100000 }),
  end: pct('End', { min: -100000, max: 100000 }),
  offset: pct('Offset', { min: -100000, max: 100000, softMin: -100 }),
  amount: pct('Amount', { min: -100, softMin: -100 }),
  smoothness: pct('Smoothness'),
  easeHigh: pct('Ease High', { min: -100, softMin: -100 }),
  easeLow: pct('Ease Low', { min: -100, softMin: -100 }),
};

export const WIGGLY_SELECTOR_DESCS: Record<string, PropDescriptor> = {
  maxAmount: pct('Max Amount', { min: -100, softMin: -100 }),
  minAmount: pct('Min Amount', { min: -100, softMin: -100 }),
  wigglesPerSecond: num('Wiggles/Second'),
  correlation: pct('Correlation'),
  temporalPhase: ang('Temporal Phase'),
  spatialPhase: ang('Spatial Phase'),
};

/** Find the shape item that owns `path` and the item-relative key. */
export function resolveShapePath(layer: Layer, path: PropPath): { item: ShapeItem; key: string } | null {
  if (!path.startsWith('shape.contents.')) return null;
  const segs = path.split('.');
  let cur: any = layer;
  let lastItem: ShapeItem | null = null;
  let lastItemIdx = -1;
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    if (cur == null) return null;
    cur = Array.isArray(cur) ? cur.find((x: any) => x && x.id === seg) : cur[seg];
    if (cur && typeof cur === 'object' && !Array.isArray(cur) && typeof cur.type === 'string' && 'enabled' in cur && 'id' in cur) {
      lastItem = cur as ShapeItem;
      lastItemIdx = k;
    }
  }
  if (!lastItem) return null;
  return { item: lastItem, key: segs.slice(lastItemIdx + 1).join('.') };
}

/** Descriptor for any property path in a layer. */
export function getDescriptor(layer: Layer, path: PropPath): PropDescriptor {
  const segs = path.split('.');
  const head = segs[0];
  const fallback: PropDescriptor = { name: lastSeg(path), kind: 'number', precision: 2 };
  switch (head) {
    case 'transform': {
      const d = TRANSFORM_DESCS[segs[1]];
      if (!d) return fallback;
      if (segs[1] === 'rotation' && layer.threeD) return { ...d, name: 'Z Rotation' };
      if ((segs[1] === 'position' || segs[1] === 'anchor' || segs[1] === 'scale') && !layer.threeD) {
        return { ...d, dims: 2, kind: segs[1] === 'scale' ? 'vec2' : 'point2' };
      }
      return d;
    }
    case 'timeRemap':
      return { name: 'Time Remap', kind: 'number', unit: 's', precision: 3 };
    case 'masks':
      return MASK_DESCS[segs[2]] ?? fallback;
    case 'effects': {
      const fx = layer.effects.find((e) => e.id === segs[1]);
      if (!fx) return fallback;
      const pd = getParamDef(fx.type, segs[3]);
      return pd ?? fallback;
    }
    case 'camera':
      return CAMERA_DESCS[segs[1]] ?? fallback;
    case 'light':
      return LIGHT_DESCS[segs[1]] ?? fallback;
    case 'material':
      return MATERIAL_DESCS[segs[1]] ?? fallback;
    case 'trackers':
      return TRACK_POINT_DESCS[segs[4]] ?? fallback;
    case 'audio':
      return { name: 'Audio Levels', kind: 'vec2', dims: 2, unit: 'dB', precision: 2 };
    case 'text': {
      if (segs[1] === 'sourceText') return { name: 'Source Text', kind: 'text' };
      if (segs[1] === 'animators') {
        if (segs[3] === 'props') return TEXT_ANIM_DESCS[segs[4] as TextAnimatorPropKey] ?? fallback;
        if (segs[3] === 'selectors') {
          const anim = layer.text?.animators.find((a) => a.id === segs[2]);
          const sel = anim?.selectors.find((s) => s.id === segs[4]);
          if (!sel) return fallback;
          return (sel.type === 'range' ? RANGE_SELECTOR_DESCS : WIGGLY_SELECTOR_DESCS)[segs[5]] ?? fallback;
        }
      }
      return fallback;
    }
    case 'shape': {
      const r = resolveShapePath(layer, path);
      if (!r) return fallback;
      return SHAPE_DESCS[r.item.type]?.[r.key] ?? fallback;
    }
  }
  return fallback;
}

/** Whether the property at `path` should be interpolated spatially. */
export function isSpatial(layer: Layer, path: PropPath): boolean {
  return !!getDescriptor(layer, path).spatial;
}

/** Enumerate every AnimProp inside an object (depth-first), yielding relative paths. */
export function forEachAnimProp(root: unknown, base: string, fn: (p: AnimProp, path: string) => void): void {
  const visit = (node: any, path: string) => {
    if (node == null || typeof node !== 'object') return;
    if (isAnimProp(node)) {
      fn(node, path);
      return;
    }
    if (Array.isArray(node)) {
      for (const el of node) if (el && typeof el === 'object' && typeof el.id === 'string') visit(el, path ? `${path}.${el.id}` : el.id);
      return;
    }
    for (const k of Object.keys(node)) {
      if (k === 'id' || k === 'name' || k === 'type') continue;
      visit(node[k], path ? `${path}.${k}` : k);
    }
  };
  visit(root, base);
}

/** All animated property paths in a layer. */
export function animatedPaths(layer: Layer): PropPath[] {
  const out: PropPath[] = [];
  forEachAnimProp(layer, '', (p, path) => {
    if (p.keyframes.length) out.push(path);
  });
  return out;
}
