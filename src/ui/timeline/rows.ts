// Timeline row model: flattens layers + their property trees into virtualizable rows, honoring
// twirl-down state and the reveal modes (U, UU, P/S/R/T/A).

import type { AnimProp, Composition, Layer, PropDescriptor, ShapeItem, TextAnimator, TextSelector } from '../../core/types';
import {
  CAMERA_DESCS, LIGHT_DESCS, MASK_DESCS, MATERIAL_DESCS, RANGE_SELECTOR_DESCS, SHAPE_DESCS, TEXT_ANIM_DESCS, TEXT_ANIM_ORDER,
  TRACK_POINT_DESCS, TRANSFORM_DESCS, WIGGLY_SELECTOR_DESCS, getDescriptor,
} from '../../core/props';
import { getEffectDef, resolveDefault } from '../../effects/catalog';
import type { RevealMode } from '../../state/uiTypes';
import { layerSourceSize } from '../../core/evaluate';
import type { Project } from '../../core/types';

export type FieldControl =
  | { type: 'select'; path: string; options: [string, string][] }
  | { type: 'check'; path: string }
  | { type: 'number'; path: string; min?: number; max?: number; step?: number };

export type Row =
  | { kind: 'layer'; key: string; layer: Layer; index: number; depth: 0; h: number }
  | { kind: 'group'; key: string; layer: Layer; label: string; depth: number; h: number; group: GroupKind; ref?: string; path?: string; summary: string[] }
  | { kind: 'prop'; key: string; layer: Layer; label: string; depth: number; h: number; path: string; prop: AnimProp; desc: PropDescriptor }
  | { kind: 'expr'; key: string; layer: Layer; depth: number; h: number; path: string; prop: AnimProp }
  | { kind: 'field'; key: string; layer: Layer; label: string; depth: number; h: number; control: FieldControl };

export type GroupKind =
  | 'transform' | 'masks' | 'mask' | 'effects' | 'effect' | 'effectGroup' | 'contents' | 'shapeGroup' | 'shapeItem' | 'text' | 'animator'
  | 'selector' | 'advanced' | 'camera' | 'light' | 'material' | 'audio' | 'repeaterTransform' | 'groupTransform' | 'dashes'
  | 'trackers' | 'tracker' | 'trackPoint';

export const ROW_H = 24;
export const EXPR_H = 58;

interface Ctx {
  rows: Row[];
  expanded: Record<string, boolean>;
  reveal: RevealMode;
  project: Project;
  comp: Composition;
  layer: Layer;
  /** when revealing, only matching props are emitted */
  filter: ((path: string, p: AnimProp) => boolean) | null;
}

const isModifiedTransform = (layer: Layer, key: string, p: AnimProp, project: Project, comp: Composition): boolean => {
  if (p.keyframes.length || p.expression) return true;
  const v = p.value as number | number[];
  switch (key) {
    case 'scale': return (v as number[]).some((x) => Math.abs(x - 100) > 1e-6);
    case 'rotation': case 'rotationX': case 'rotationY': return Math.abs(v as number) > 1e-6;
    case 'orientation': return (v as number[]).some((x) => Math.abs(x) > 1e-6);
    case 'opacity': return Math.abs((v as number) - 100) > 1e-6;
    case 'anchor': {
      const s = layerSourceSize(project, comp, layer);
      const def = layer.type === 'shape' || layer.type === 'text' ? [0, 0] : [s.w / 2, s.h / 2];
      return Math.abs((v as number[])[0] - def[0]) > 1e-6 || Math.abs((v as number[])[1] - def[1]) > 1e-6;
    }
    case 'position': return Math.abs((v as number[])[0] - comp.width / 2) > 1e-6 || Math.abs((v as number[])[1] - comp.height / 2) > 1e-6 || Math.abs((v as number[])[2] ?? 0) > 1e-6;
  }
  return false;
};

function pushProp(c: Ctx, path: string, p: AnimProp | undefined, depth: number, desc?: PropDescriptor, label?: string): boolean {
  if (!p) return false;
  if (c.filter && !c.filter(path, p)) return false;
  const d = desc ?? getDescriptor(c.layer, path);
  if (d.hidden) return false;
  c.rows.push({ kind: 'prop', key: `${c.layer.id}|${path}`, layer: c.layer, label: label ?? d.name, depth, h: ROW_H, path, prop: p, desc: d });
  if (p.expression !== undefined && c.expanded[`${c.layer.id}|expr|${path}`] !== false) {
    c.rows.push({ kind: 'expr', key: `${c.layer.id}|expr|${path}`, layer: c.layer, depth, h: EXPR_H, path, prop: p });
  }
  return true;
}

/** Push a group, emitting children only when expanded (or when revealing). Returns true if anything was emitted. */
function pushGroup(c: Ctx, key: string, label: string, depth: number, group: GroupKind, children: () => void, extra: { ref?: string; path?: string } = {}): boolean {
  const ek = `${c.layer.id}|${key}`;
  const idx = c.rows.length;
  const summary: string[] = [];
  c.rows.push({ kind: 'group', key: ek, layer: c.layer, label, depth, h: ROW_H, group, summary, ...extra });
  const open = c.filter ? true : !!c.expanded[ek];
  if (open) {
    const before = c.rows.length;
    children();
    if (c.filter && c.rows.length === before) {
      c.rows.splice(idx, 1);
      return false;
    }
  }
  return true;
}

function pushField(c: Ctx, label: string, depth: number, control: FieldControl): void {
  if (c.filter) return;
  c.rows.push({ kind: 'field', key: `${c.layer.id}|field|${control.path}`, layer: c.layer, label, depth, h: ROW_H, control });
}

function transformRows(c: Ctx, depth: number, flat: boolean) {
  const l = c.layer;
  const t = l.transform;
  const keys = l.type === 'camera' || l.type === 'light'
    ? (['position', 'orientation', 'rotationX', 'rotationY', 'rotation'] as const)
    : l.threeD
      ? (['anchor', 'position', 'scale', 'orientation', 'rotationX', 'rotationY', 'rotation', 'opacity'] as const)
      : (['anchor', 'position', 'scale', 'rotation', 'opacity'] as const);
  const emit = (d: number) => {
    for (const k of keys) pushProp(c, `transform.${k}`, t[k] as AnimProp, d, undefined, k === 'rotation' && l.threeD ? 'Z Rotation' : TRANSFORM_DESCS[k].name);
  };
  if (flat) emit(depth);
  else pushGroup(c, 'transform', 'Transform', depth, 'transform', () => emit(depth + 1));
}

function shapeItemRows(c: Ctx, items: ShapeItem[], base: string, depth: number) {
  for (const it of items) {
    const path = `${base}.${it.id}`;
    if (it.type === 'group') {
      pushGroup(c, path, it.name, depth, 'shapeGroup', () => {
        pushGroup(c, `${path}.contents`, 'Contents', depth + 1, 'contents', () => shapeItemRows(c, it.contents, `${path}.contents`, depth + 2), { path: `${path}.contents` });
        pushGroup(c, `${path}.transform`, `Transform: ${it.name}`, depth + 1, 'groupTransform', () => {
          for (const k of ['anchor', 'position', 'scale', 'skew', 'skewAxis', 'rotation', 'opacity'] as const) {
            pushProp(c, `${path}.transform.${k}`, it.transform[k], depth + 2, SHAPE_DESCS.group[`transform.${k}`]);
          }
        });
      }, { ref: it.id, path });
      continue;
    }
    pushGroup(c, path, it.name, depth, 'shapeItem', () => {
      const descs = SHAPE_DESCS[it.type];
      // enum fields
      switch (it.type) {
        case 'rect': case 'ellipse': case 'polystar': case 'path':
          if (it.type === 'polystar') pushField(c, 'Type', depth + 1, { type: 'select', path: `${path}.starType`, options: [['star', 'Star'], ['polygon', 'Polygon']] });
          pushField(c, 'Reverse Path Direction', depth + 1, { type: 'check', path: `${path}.reversed` });
          break;
        case 'fill': case 'gfill':
          pushField(c, 'Fill Rule', depth + 1, { type: 'select', path: `${path}.fillRule`, options: [['nonzero', 'Non-Zero Winding'], ['evenodd', 'Even-Odd']] });
          if (it.type === 'gfill') pushField(c, 'Type', depth + 1, { type: 'select', path: `${path}.gradientType`, options: [['linear', 'Linear'], ['radial', 'Radial']] });
          break;
        case 'stroke': case 'gstroke':
          pushField(c, 'Line Cap', depth + 1, { type: 'select', path: `${path}.lineCap`, options: [['butt', 'Butt Cap'], ['round', 'Round Cap'], ['square', 'Projecting Cap']] });
          pushField(c, 'Line Join', depth + 1, { type: 'select', path: `${path}.lineJoin`, options: [['miter', 'Miter Join'], ['round', 'Round Join'], ['bevel', 'Bevel Join']] });
          pushField(c, 'Dashes', depth + 1, { type: 'check', path: `${path}.dashes.enabled` });
          if (it.type === 'gstroke') pushField(c, 'Type', depth + 1, { type: 'select', path: `${path}.gradientType`, options: [['linear', 'Linear'], ['radial', 'Radial']] });
          break;
        case 'trim':
          pushField(c, 'Trim Multiple Shapes', depth + 1, { type: 'select', path: `${path}.mode`, options: [['simultaneous', 'Simultaneously'], ['individual', 'Individually']] });
          break;
        case 'merge':
          pushField(c, 'Mode', depth + 1, { type: 'select', path: `${path}.mode`, options: [['merge', 'Merge'], ['add', 'Add'], ['subtract', 'Subtract'], ['intersect', 'Intersect'], ['exclude', 'Exclude Intersections']] });
          break;
        case 'repeater':
          pushField(c, 'Composite', depth + 1, { type: 'select', path: `${path}.composite`, options: [['below', 'Below'], ['above', 'Above']] });
          break;
        case 'zigzag': case 'wiggle':
          pushField(c, 'Points', depth + 1, { type: 'select', path: `${path}.pointType`, options: [['corner', 'Corner'], ['smooth', 'Smooth']] });
          break;
      }
      for (const key of Object.keys(descs)) {
        if (key.startsWith('transform.') && it.type === 'repeater') continue;
        if (key.startsWith('dashes.') && !((it as { dashes?: { enabled: boolean } }).dashes?.enabled)) continue;
        const p = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], it) as AnimProp | undefined;
        pushProp(c, `${path}.${key}`, p, depth + 1, descs[key]);
      }
      if (it.type === 'repeater') {
        pushGroup(c, `${path}.transform`, `Transform: ${it.name}`, depth + 1, 'repeaterTransform', () => {
          for (const k of ['anchor', 'position', 'scale', 'rotation', 'startOpacity', 'endOpacity'] as const) {
            pushProp(c, `${path}.transform.${k}`, it.transform[k], depth + 2, descs[`transform.${k}`]);
          }
        });
      }
    }, { ref: it.id, path });
  }
}

function selectorRows(c: Ctx, a: TextAnimator, s: TextSelector, depth: number) {
  const base = `text.animators.${a.id}.selectors.${s.id}`;
  pushGroup(c, base, s.name, depth, 'selector', () => {
    if (s.type === 'range') {
      for (const k of ['start', 'end', 'offset'] as const) pushProp(c, `${base}.${k}`, s[k], depth + 1, RANGE_SELECTOR_DESCS[k]);
      pushGroup(c, `${base}.advanced`, 'Advanced', depth + 1, 'advanced', () => {
        pushField(c, 'Units', depth + 2, { type: 'select', path: `${base}.units`, options: [['percent', 'Percentage'], ['index', 'Index']] });
        pushField(c, 'Based On', depth + 2, { type: 'select', path: `${base}.basedOn`, options: [['characters', 'Characters'], ['charactersExcludingSpaces', 'Characters Excluding Spaces'], ['words', 'Words'], ['lines', 'Lines']] });
        pushField(c, 'Mode', depth + 2, { type: 'select', path: `${base}.mode`, options: [['add', 'Add'], ['subtract', 'Subtract'], ['intersect', 'Intersect'], ['min', 'Min'], ['max', 'Max'], ['difference', 'Difference']] });
        pushProp(c, `${base}.amount`, s.amount, depth + 2, RANGE_SELECTOR_DESCS.amount);
        pushField(c, 'Shape', depth + 2, { type: 'select', path: `${base}.shape`, options: [['square', 'Square'], ['rampUp', 'Ramp Up'], ['rampDown', 'Ramp Down'], ['triangle', 'Triangle'], ['round', 'Round'], ['smooth', 'Smooth']] });
        pushProp(c, `${base}.smoothness`, s.smoothness, depth + 2, RANGE_SELECTOR_DESCS.smoothness);
        pushProp(c, `${base}.easeHigh`, s.easeHigh, depth + 2, RANGE_SELECTOR_DESCS.easeHigh);
        pushProp(c, `${base}.easeLow`, s.easeLow, depth + 2, RANGE_SELECTOR_DESCS.easeLow);
        pushField(c, 'Randomize Order', depth + 2, { type: 'check', path: `${base}.randomize` });
        pushField(c, 'Random Seed', depth + 2, { type: 'number', path: `${base}.seed`, step: 1 });
      });
    } else {
      pushField(c, 'Mode', depth + 1, { type: 'select', path: `${base}.mode`, options: [['add', 'Add'], ['subtract', 'Subtract'], ['intersect', 'Intersect'], ['min', 'Min'], ['max', 'Max'], ['difference', 'Difference']] });
      for (const k of ['maxAmount', 'minAmount'] as const) pushProp(c, `${base}.${k}`, s[k], depth + 1, WIGGLY_SELECTOR_DESCS[k]);
      pushField(c, 'Based On', depth + 1, { type: 'select', path: `${base}.basedOn`, options: [['characters', 'Characters'], ['charactersExcludingSpaces', 'Characters Excluding Spaces'], ['words', 'Words'], ['lines', 'Lines']] });
      for (const k of ['wigglesPerSecond', 'correlation', 'temporalPhase', 'spatialPhase'] as const) pushProp(c, `${base}.${k}`, s[k], depth + 1, WIGGLY_SELECTOR_DESCS[k]);
      pushField(c, 'Lock Dimensions', depth + 1, { type: 'check', path: `${base}.lockDimensions` });
      pushField(c, 'Random Seed', depth + 1, { type: 'number', path: `${base}.seed`, step: 1 });
    }
  }, { ref: s.id, path: base });
}

function layerTree(c: Ctx) {
  const l = c.layer;
  const d = 1;
  if (l.text) {
    pushGroup(c, 'text', 'Text', d, 'text', () => {
      pushProp(c, 'text.sourceText', l.text!.sourceText, d + 1);
      for (const a of l.text!.animators) {
        const base = `text.animators.${a.id}`;
        pushGroup(c, base, a.name, d + 1, 'animator', () => {
          for (const s of a.selectors) selectorRows(c, a, s, d + 2);
          for (const k of TEXT_ANIM_ORDER) {
            const p = a.props[k];
            if (p) pushProp(c, `${base}.props.${k}`, p as AnimProp, d + 2, TEXT_ANIM_DESCS[k]);
          }
        }, { ref: a.id, path: base });
      }
    });
  }
  if (l.shape) pushGroup(c, 'shape.contents', 'Contents', d, 'contents', () => shapeItemRows(c, l.shape!.contents, 'shape.contents', d + 1), { path: 'shape.contents' });
  if (l.masks.length) {
    pushGroup(c, 'masks', 'Masks', d, 'masks', () => {
      for (const m of l.masks) {
        pushGroup(c, `masks.${m.id}`, m.name, d + 1, 'mask', () => {
          for (const k of ['path', 'feather', 'opacity', 'expansion'] as const) pushProp(c, `masks.${m.id}.${k}`, m[k] as AnimProp, d + 2, MASK_DESCS[k]);
        }, { ref: m.id, path: `masks.${m.id}` });
      }
    });
  }
  if (l.effects.length) {
    pushGroup(c, 'effects', 'Effects', d, 'effects', () => {
      for (const fx of l.effects) {
        const def = getEffectDef(fx.type);
        pushGroup(c, `effects.${fx.id}`, fx.name, d + 1, 'effect', () => {
          if (!def) return;
          const groups = new Map<string, typeof def.params>();
          for (const pd of def.params) {
            if (pd.group) {
              if (!groups.has(pd.group)) groups.set(pd.group, []);
              groups.get(pd.group)!.push(pd);
            }
          }
          const emitted = new Set<string>();
          for (const pd of def.params) {
            if (pd.group) {
              if (emitted.has(pd.group)) continue;
              emitted.add(pd.group);
              const g = pd.group;
              pushGroup(c, `effects.${fx.id}.g.${g}`, g, d + 2, 'effectGroup', () => {
                for (const q of groups.get(g)!) pushProp(c, `effects.${fx.id}.params.${q.id}`, fx.params[q.id], d + 3, q);
              });
              continue;
            }
            pushProp(c, `effects.${fx.id}.params.${pd.id}`, fx.params[pd.id], d + 2, pd);
          }
        }, { ref: fx.id, path: `effects.${fx.id}` });
      }
    });
  }
  if (l.trackers?.length) {
    pushGroup(c, 'trackers', 'Motion Trackers', d, 'trackers', () => {
      for (const t of l.trackers!) {
        const tb = `trackers.${t.id}`;
        pushGroup(c, tb, t.name, d + 1, 'tracker', () => {
          for (const p of t.points) {
            const pb = `${tb}.points.${p.id}`;
            pushGroup(c, pb, p.name, d + 2, 'trackPoint', () => {
              for (const k of ['featureCenter', 'confidence', 'attachPoint'] as const) pushProp(c, `${pb}.${k}`, p[k] as AnimProp, d + 3, TRACK_POINT_DESCS[k]);
            }, { ref: p.id, path: pb });
          }
        }, { ref: t.id, path: tb });
      }
    });
  }
  transformRows(c, d, false);
  if (l.camera) {
    pushGroup(c, 'camera', 'Camera Options', d, 'camera', () => {
      pushField(c, 'Type', d + 1, { type: 'select', path: 'camera.kind', options: [['twoNode', 'Two-Node Camera'], ['oneNode', 'One-Node Camera']] });
      if (l.camera!.kind === 'twoNode') pushProp(c, 'camera.pointOfInterest', l.camera!.pointOfInterest, d + 1, CAMERA_DESCS.pointOfInterest);
      pushProp(c, 'camera.zoom', l.camera!.zoom, d + 1, CAMERA_DESCS.zoom);
      pushField(c, 'Depth of Field', d + 1, { type: 'check', path: 'camera.depthOfField' });
      for (const k of ['focusDistance', 'aperture', 'blurLevel'] as const) pushProp(c, `camera.${k}`, l.camera![k], d + 1, CAMERA_DESCS[k]);
    });
  }
  if (l.light) {
    pushGroup(c, 'light', 'Light Options', d, 'light', () => {
      pushField(c, 'Light Type', d + 1, { type: 'select', path: 'light.kind', options: [['parallel', 'Parallel'], ['spot', 'Spot'], ['point', 'Point'], ['ambient', 'Ambient']] });
      if (l.light!.kind === 'spot' || l.light!.kind === 'parallel') pushProp(c, 'light.pointOfInterest', l.light!.pointOfInterest, d + 1, LIGHT_DESCS.pointOfInterest);
      pushProp(c, 'light.intensity', l.light!.intensity, d + 1, LIGHT_DESCS.intensity);
      pushProp(c, 'light.color', l.light!.color as AnimProp, d + 1, LIGHT_DESCS.color);
      if (l.light!.kind === 'spot') {
        pushProp(c, 'light.coneAngle', l.light!.coneAngle, d + 1, LIGHT_DESCS.coneAngle);
        pushProp(c, 'light.coneFeather', l.light!.coneFeather, d + 1, LIGHT_DESCS.coneFeather);
      }
      if (l.light!.kind !== 'ambient' && l.light!.kind !== 'parallel') {
        pushField(c, 'Falloff', d + 1, { type: 'select', path: 'light.falloff', options: [['none', 'None'], ['smooth', 'Smooth'], ['inverseSquare', 'Inverse Square Clamped']] });
        if (l.light!.falloff !== 'none') {
          pushProp(c, 'light.radius', l.light!.radius, d + 1, LIGHT_DESCS.radius);
          if (l.light!.falloff === 'smooth') pushProp(c, 'light.falloffDistance', l.light!.falloffDistance, d + 1, LIGHT_DESCS.falloffDistance);
        }
      }
    });
  }
  if (l.threeD && l.type !== 'camera' && l.type !== 'light') {
    pushGroup(c, 'material', 'Material Options', d, 'material', () => {
      pushField(c, 'Accepts Lights', d + 1, { type: 'check', path: 'material.acceptsLights' });
      for (const k of ['ambient', 'diffuse', 'specularIntensity', 'specularShininess', 'metal'] as const) pushProp(c, `material.${k}`, l.material[k], d + 1, MATERIAL_DESCS[k]);
    });
  }
  if (l.timeRemapEnabled) pushProp(c, 'timeRemap', l.timeRemap, d);
  if (l.audio) pushGroup(c, 'audio', 'Audio', d, 'audio', () => pushProp(c, 'audio.levels', l.audio!.levels as AnimProp, d + 1));
}

export function buildRows(project: Project, comp: Composition, expanded: Record<string, boolean>, reveal: RevealMode, selLayers: string[], search: string): Row[] {
  const rows: Row[] = [];
  const q = search.trim().toLowerCase();
  comp.layers.forEach((layer, index) => {
    if (comp.hideShyLayers && layer.shy) return;
    if (q && !layer.name.toLowerCase().includes(q)) return;
    rows.push({ kind: 'layer', key: layer.id, layer, index, depth: 0, h: ROW_H });
    const revealHere = reveal.kind !== 'none' && (selLayers.length === 0 || selLayers.includes(layer.id));
    if (revealHere) {
      const before = rows.length;
      let filter: Ctx['filter'];
      if (reveal.kind === 'keyframes') filter = (_path, p) => p.keyframes.length > 0;
      else if (reveal.kind === 'modified') {
        filter = (path, p) => {
          if (p.keyframes.length || p.expression) return true;
          if (path.startsWith('transform.')) return isModifiedTransform(layer, path.slice(10), p, project, comp);
          if (path.startsWith('effects.')) {
            const [, fxId, , pid] = path.split('.');
            const fx = layer.effects.find((e) => e.id === fxId);
            const pd = fx ? getEffectDef(fx.type)?.params.find((x) => x.id === pid) : undefined;
            if (!pd) return false;
            const def = resolveDefault(pd, layerSourceSize(project, comp, layer));
            return JSON.stringify(def) !== JSON.stringify(p.value);
          }
          return false;
        };
      } else {
        const props = reveal.kind === 'props' ? reveal.props : [];
        const c: Ctx = { rows, expanded, reveal, project, comp, layer, filter: (path) => props.includes(path) };
        const t = layer.transform as unknown as Record<string, AnimProp>;
        for (const p of props) {
          const key = p.slice(10);
          if (!layer.threeD && (key === 'rotationX' || key === 'rotationY' || key === 'orientation')) continue;
          if ((layer.type === 'camera' || layer.type === 'light') && (key === 'anchor' || key === 'scale' || key === 'opacity')) continue;
          pushProp(c, p, t[key], 1, undefined, key === 'rotation' && layer.threeD ? 'Z Rotation' : undefined);
        }
        return;
      }
      layerTree({ rows, expanded, reveal, project, comp, layer, filter });
      if (rows.length === before) return;
      return;
    }
    if (!expanded[layer.id]) return;
    layerTree({ rows, expanded, reveal, project, comp, layer, filter: null });
  });
  return rows;
}
