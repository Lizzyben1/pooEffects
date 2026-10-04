// Factories producing fully-populated document nodes with After Effects-like defaults.

import { uid } from './ids';
import { prop } from './props';
import type {
  BezierPath, CameraData, Composition, EffectInstance, Footage, GradientStop, Layer, LayerType, LightData, LightKind,
  Mask, MaterialOptions, Project, RangeSelector, RGBA, ShapeEllipse, ShapeFill, ShapeGradientFill, ShapeGradientStroke,
  ShapeGroup, ShapeItem, ShapeItemType, ShapeMerge, ShapeOffset, ShapePath, ShapePolystar, ShapePuckerBloat, ShapeRect,
  ShapeRepeater, ShapeRoundCorners, ShapeStroke, ShapeTransform, ShapeTrim, ShapeTwist, ShapeWiggle, ShapeZigZag,
  TextAnimator, TextAnimatorPropKey, TextAnimatorProps, TextDocument, Transform, WigglySelector,
} from './types';
import { getEffectDef, resolveDefault, type LayerDims } from '../effects/catalog';
import { SHAPE_TYPE_NAMES } from './props';

// ── project & comps ─────────────────────────────────────────────────────────

export function createProject(name = 'Untitled Project'): Project {
  return {
    format: 'pooeffects',
    version: 1,
    name,
    comps: {},
    footage: {},
    folders: {},
    settings: { expressionsEnabled: true, timeDisplay: 'timecode', frameStart: 0 },
  };
}

export interface CompOptions {
  name?: string;
  width?: number;
  height?: number;
  frameRate?: number;
  duration?: number;
  bgColor?: RGBA;
  pixelAspect?: number;
}

export function createComp(o: CompOptions = {}): Composition {
  const duration = o.duration ?? 10;
  const frameRate = o.frameRate ?? 30;
  return {
    id: uid('c'),
    name: o.name ?? 'Comp 1',
    width: o.width ?? 1920,
    height: o.height ?? 1080,
    pixelAspect: o.pixelAspect ?? 1,
    frameRate,
    dropFrame: Math.abs(frameRate - 29.97) < 0.01 || Math.abs(frameRate - 59.94) < 0.01,
    duration,
    bgColor: o.bgColor ?? [0.04, 0.045, 0.055, 1],
    layers: [],
    workArea: [0, duration],
    motionBlur: true,
    shutterAngle: 180,
    shutterPhase: -90,
    motionBlurSamples: 16,
    bitDepth: 8,
    markers: [],
    hideShyLayers: false,
    folderId: null,
  };
}

// ── layers ──────────────────────────────────────────────────────────────────

export function createTransform(anchor: number[], position: number[]): Transform {
  return {
    anchor: prop([anchor[0], anchor[1], anchor[2] ?? 0]),
    position: prop([position[0], position[1], position[2] ?? 0]),
    scale: prop([100, 100, 100]),
    orientation: prop([0, 0, 0]),
    rotationX: prop(0),
    rotationY: prop(0),
    rotation: prop(0),
    opacity: prop(100),
  };
}

export function createMaterial(): MaterialOptions {
  return {
    acceptsLights: true,
    ambient: prop(100),
    diffuse: prop(50),
    specularIntensity: prop(50),
    specularShininess: prop(5),
    metal: prop(100),
  };
}

const LABEL_FOR: Record<LayerType, number> = {
  solid: 1, null: 2, shape: 8, text: 1, image: 4, video: 14, audio: 7, precomp: 15, camera: 3, light: 6,
};

export function createLayerBase(type: LayerType, name: string, comp: Composition, anchor: number[], position?: number[]): Layer {
  return {
    id: uid('l'),
    name,
    type,
    label: LABEL_FOR[type],
    comment: '',
    inPoint: 0,
    outPoint: comp.duration,
    startTime: 0,
    stretch: 100,
    timeRemapEnabled: false,
    timeRemap: prop(0),
    enabled: true,
    audioEnabled: true,
    solo: false,
    locked: false,
    shy: false,
    threeD: false,
    motionBlur: false,
    adjustment: false,
    collapse: false,
    quality: 'best',
    effectsEnabled: true,
    guide: false,
    autoOrient: 'off',
    blendMode: 'normal',
    preserveTransparency: false,
    parentId: null,
    trackMatte: null,
    transform: createTransform(anchor, position ?? [comp.width / 2, comp.height / 2, 0]),
    masks: [],
    effects: [],
    markers: [],
    material: createMaterial(),
  };
}

export function createSolidLayer(comp: Composition, color: RGBA, name = 'Solid', width = comp.width, height = comp.height): Layer {
  const l = createLayerBase('solid', name, comp, [width / 2, height / 2, 0]);
  l.solid = { color, width, height };
  return l;
}

export function createAdjustmentLayer(comp: Composition): Layer {
  const l = createSolidLayer(comp, [1, 1, 1, 1], 'Adjustment Layer');
  l.adjustment = true;
  l.label = 5;
  return l;
}

export function createNullLayer(comp: Composition, name = 'Null'): Layer {
  const l = createLayerBase('null', name, comp, [50, 50, 0]);
  l.solid = { color: [1, 1, 1, 1], width: 100, height: 100 };
  return l;
}

export function createShapeLayer(comp: Composition, contents: ShapeItem[] = [], name = 'Shape Layer'): Layer {
  const l = createLayerBase('shape', name, comp, [0, 0, 0]);
  l.shape = { contents };
  return l;
}

export function defaultTextDocument(o: Partial<TextDocument> = {}): TextDocument {
  return {
    font: 'Inter',
    weight: 700,
    italic: false,
    size: 120,
    fill: [1, 1, 1, 1],
    fillOn: true,
    stroke: [0, 0, 0, 1],
    strokeOn: false,
    strokeWidth: 4,
    strokeOverFill: false,
    tracking: 0,
    leading: 0,
    justify: 'center',
    allCaps: false,
    baselineShift: 0,
    boxWidth: null,
    ...o,
  };
}

export function createTextLayer(comp: Composition, text: string, doc: Partial<TextDocument> = {}): Layer {
  const l = createLayerBase('text', text.split('\n')[0].slice(0, 40) || 'Text', comp, [0, 0, 0]);
  l.text = {
    sourceText: prop(text),
    document: defaultTextDocument(doc),
    animators: [],
    grouping: 'character',
  };
  return l;
}

/** AE camera zoom for a focal length (mm) on a 36mm film back. */
export function zoomForFocalLength(compWidth: number, focalMm: number, filmMm = 36): number {
  return (focalMm / filmMm) * compWidth;
}

export function createCameraLayer(comp: Composition, focalMm = 50, name = 'Camera 1'): Layer {
  const zoom = zoomForFocalLength(comp.width, focalMm);
  const l = createLayerBase('camera', name, comp, [0, 0, 0], [comp.width / 2, comp.height / 2, -zoom]);
  l.threeD = true;
  const cam: CameraData = {
    kind: 'twoNode',
    pointOfInterest: prop([comp.width / 2, comp.height / 2, 0]),
    zoom: prop(zoom),
    depthOfField: false,
    focusDistance: prop(zoom),
    aperture: prop(25.3),
    blurLevel: prop(100),
  };
  l.camera = cam;
  return l;
}

export function createLightLayer(comp: Composition, kind: LightKind = 'point', name?: string): Layer {
  const pos = [comp.width / 2 - comp.width * 0.12, comp.height / 2 - comp.height * 0.18, -520];
  const l = createLayerBase('light', name ?? `${kind[0].toUpperCase()}${kind.slice(1)} Light`, comp, [0, 0, 0], pos);
  l.threeD = true;
  const light: LightData = {
    kind,
    pointOfInterest: prop([comp.width / 2, comp.height / 2, 0]),
    intensity: prop(100),
    color: prop<RGBA>([1, 1, 1, 1]),
    coneAngle: prop(90),
    coneFeather: prop(50),
    falloff: 'none',
    radius: prop(500),
    falloffDistance: prop(500),
  };
  l.light = light;
  return l;
}

export function createFootageLayer(comp: Composition, footage: Footage): Layer {
  const type: LayerType = footage.kind === 'image' ? 'image' : footage.kind === 'video' ? 'video' : 'audio';
  const l = createLayerBase(type, footage.name, comp, [footage.width / 2, footage.height / 2, 0]);
  l.source = { footageId: footage.id };
  if (footage.kind !== 'image' && footage.duration > 0) {
    l.outPoint = Math.min(comp.duration, footage.duration);
  }
  if (footage.hasAudio) l.audio = { levels: prop([0, 0]) };
  return l;
}

export function createPrecompLayer(comp: Composition, nested: Composition): Layer {
  const l = createLayerBase('precomp', nested.name, comp, [nested.width / 2, nested.height / 2, 0]);
  l.source = { compId: nested.id };
  l.outPoint = Math.min(comp.duration, nested.duration);
  return l;
}

// ── masks ───────────────────────────────────────────────────────────────────

export function rectPath(x: number, y: number, w: number, h: number): BezierPath {
  return {
    closed: true,
    v: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]],
    i: [[0, 0], [0, 0], [0, 0], [0, 0]],
    o: [[0, 0], [0, 0], [0, 0], [0, 0]],
  };
}

const KAPPA = 0.5522847498;

export function ellipsePath(cx: number, cy: number, rx: number, ry: number): BezierPath {
  const kx = rx * KAPPA, ky = ry * KAPPA;
  return {
    closed: true,
    v: [[cx, cy - ry], [cx + rx, cy], [cx, cy + ry], [cx - rx, cy]],
    i: [[-kx, 0], [0, -ky], [kx, 0], [0, ky]],
    o: [[kx, 0], [0, ky], [-kx, 0], [0, -ky]],
  };
}

const MASK_COLORS: RGBA[] = [
  [0.37, 0.55, 1, 1], [1, 0.82, 0.25, 1], [0.35, 0.9, 0.55, 1], [1, 0.42, 0.62, 1], [0.7, 0.5, 1, 1], [0.3, 0.9, 0.95, 1],
];

export function createMask(path: BezierPath, index = 0): Mask {
  return {
    id: uid('m'),
    name: `Mask ${index + 1}`,
    mode: 'add',
    inverted: false,
    locked: false,
    color: MASK_COLORS[index % MASK_COLORS.length],
    path: prop(path),
    feather: prop([0, 0]),
    opacity: prop(100),
    expansion: prop(0),
  };
}

// ── effects ─────────────────────────────────────────────────────────────────

export function createEffect(type: string, dims: LayerDims, existingNames: string[] = []): EffectInstance {
  const def = getEffectDef(type);
  if (!def) throw new Error(`Unknown effect type: ${type}`);
  const params: EffectInstance['params'] = {};
  for (const p of def.params) params[p.id] = prop(resolveDefault(p, dims));
  let name = def.name;
  let n = 2;
  while (existingNames.includes(name)) name = `${def.name} ${n++}`;
  return { id: uid('fx'), type, name, enabled: true, params };
}

// ── shapes ──────────────────────────────────────────────────────────────────

export function createShapeTransform(): ShapeTransform {
  return {
    anchor: prop([0, 0]),
    position: prop([0, 0]),
    scale: prop([100, 100]),
    rotation: prop(0),
    opacity: prop(100),
    skew: prop(0),
    skewAxis: prop(0),
  };
}

const base = (type: ShapeItemType, name?: string) => ({ id: uid('s'), name: name ?? SHAPE_TYPE_NAMES[type], enabled: true });

export function createGroup(contents: ShapeItem[] = [], name = 'Group 1'): ShapeGroup {
  return { ...base('group', name), type: 'group', contents, transform: createShapeTransform(), blendMode: 'normal' };
}

export function createRect(size: number[] = [200, 200], position: number[] = [0, 0], roundness = 0): ShapeRect {
  return { ...base('rect', 'Rectangle Path 1'), type: 'rect', size: prop(size), position: prop(position), roundness: prop(roundness), reversed: false };
}

export function createEllipse(size: number[] = [200, 200], position: number[] = [0, 0]): ShapeEllipse {
  return { ...base('ellipse', 'Ellipse Path 1'), type: 'ellipse', size: prop(size), position: prop(position), reversed: false };
}

export function createPolystar(starType: 'star' | 'polygon' = 'star', points = 5, outer = 100, inner = 50): ShapePolystar {
  return {
    ...base('polystar', 'Polystar Path 1'), type: 'polystar', starType,
    points: prop(points), position: prop([0, 0]), rotation: prop(0),
    innerRadius: prop(inner), outerRadius: prop(outer), innerRoundness: prop(0), outerRoundness: prop(0), reversed: false,
  };
}

export function createPathItem(path: BezierPath): ShapePath {
  return { ...base('path', 'Path 1'), type: 'path', path: prop(path), reversed: false };
}

export function createFill(color: RGBA = [1, 0.62, 0.22, 1]): ShapeFill {
  return { ...base('fill', 'Fill 1'), type: 'fill', color: prop(color), opacity: prop(100), fillRule: 'nonzero', blendMode: 'normal' };
}

export function createStroke(color: RGBA = [1, 1, 1, 1], width = 4): ShapeStroke {
  return {
    ...base('stroke', 'Stroke 1'), type: 'stroke', color: prop(color), opacity: prop(100), width: prop(width),
    lineCap: 'round', lineJoin: 'round', miterLimit: 4,
    dashes: { enabled: false, dash: prop(20), gap: prop(12), offset: prop(0) }, blendMode: 'normal',
  };
}

const DEFAULT_GRADIENT: GradientStop[] = [{ p: 0, c: [1, 0.85, 0.3, 1] }, { p: 1, c: [0.95, 0.25, 0.45, 1] }];

export function createGradientFill(stops: GradientStop[] = DEFAULT_GRADIENT): ShapeGradientFill {
  return {
    ...base('gfill', 'Gradient Fill 1'), type: 'gfill', gradientType: 'linear',
    start: prop([-100, 0]), end: prop([100, 0]), colors: prop(stops), opacity: prop(100), fillRule: 'nonzero', blendMode: 'normal',
  };
}

export function createGradientStroke(stops: GradientStop[] = DEFAULT_GRADIENT, width = 6): ShapeGradientStroke {
  return {
    ...base('gstroke', 'Gradient Stroke 1'), type: 'gstroke', gradientType: 'linear',
    start: prop([-100, 0]), end: prop([100, 0]), colors: prop(stops), opacity: prop(100), width: prop(width),
    lineCap: 'round', lineJoin: 'round', miterLimit: 4,
    dashes: { enabled: false, dash: prop(20), gap: prop(12), offset: prop(0) }, blendMode: 'normal',
  };
}

export function createTrim(): ShapeTrim {
  return { ...base('trim', 'Trim Paths 1'), type: 'trim', start: prop(0), end: prop(100), offset: prop(0), mode: 'simultaneous' };
}

export function createRepeater(copies = 3): ShapeRepeater {
  return {
    ...base('repeater', 'Repeater 1'), type: 'repeater', copies: prop(copies), offset: prop(0), composite: 'below',
    transform: {
      anchor: prop([0, 0]), position: prop([100, 0]), scale: prop([100, 100]), rotation: prop(0),
      startOpacity: prop(100), endOpacity: prop(100),
    },
  };
}

export function createMerge(): ShapeMerge {
  return { ...base('merge', 'Merge Paths 1'), type: 'merge', mode: 'add' };
}

export function createZigZag(): ShapeZigZag {
  return { ...base('zigzag', 'Zig Zag 1'), type: 'zigzag', size: prop(10), ridges: prop(5), pointType: 'corner' };
}

export function createRoundCorners(): ShapeRoundCorners {
  return { ...base('roundCorners', 'Round Corners 1'), type: 'roundCorners', radius: prop(10) };
}

export function createOffset(): ShapeOffset {
  return { ...base('offset', 'Offset Paths 1'), type: 'offset', amount: prop(10), lineJoin: 'miter', miterLimit: 4 };
}

export function createPuckerBloat(): ShapePuckerBloat {
  return { ...base('puckerBloat', 'Pucker & Bloat 1'), type: 'puckerBloat', amount: prop(0) };
}

export function createTwist(): ShapeTwist {
  return { ...base('twist', 'Twist 1'), type: 'twist', angle: prop(0), center: prop([0, 0]) };
}

export function createWiggle(): ShapeWiggle {
  return {
    ...base('wiggle', 'Wiggle Paths 1'), type: 'wiggle', size: prop(10), detail: prop(3), wigglesPerSecond: prop(2),
    correlation: prop(50), temporalPhase: prop(0), spatialPhase: prop(0), seed: Math.floor(Math.random() * 10000), pointType: 'smooth',
  };
}

export function createShapeItem(type: ShapeItemType): ShapeItem {
  switch (type) {
    case 'group': return createGroup();
    case 'rect': return createRect();
    case 'ellipse': return createEllipse();
    case 'polystar': return createPolystar();
    case 'path': return createPathItem(rectPath(-50, -50, 100, 100));
    case 'fill': return createFill();
    case 'stroke': return createStroke();
    case 'gfill': return createGradientFill();
    case 'gstroke': return createGradientStroke();
    case 'trim': return createTrim();
    case 'repeater': return createRepeater();
    case 'merge': return createMerge();
    case 'zigzag': return createZigZag();
    case 'roundCorners': return createRoundCorners();
    case 'offset': return createOffset();
    case 'puckerBloat': return createPuckerBloat();
    case 'twist': return createTwist();
    case 'wiggle': return createWiggle();
  }
}

// ── text animators ──────────────────────────────────────────────────────────

const ANIM_DEFAULTS: Required<{ [K in TextAnimatorPropKey]: () => NonNullable<TextAnimatorProps[K]> }> = {
  anchor: () => prop([0, 0]),
  position: () => prop([0, 0, 0]),
  scale: () => prop([100, 100]),
  skew: () => prop(0),
  rotation: () => prop(0),
  opacity: () => prop(100),
  fillColor: () => prop<RGBA>([1, 0, 0, 1]),
  strokeColor: () => prop<RGBA>([1, 0, 0, 1]),
  strokeWidth: () => prop(0),
  tracking: () => prop(0),
  blur: () => prop([0, 0]),
};

export function createAnimatorProp<K extends TextAnimatorPropKey>(key: K): NonNullable<TextAnimatorProps[K]> {
  return ANIM_DEFAULTS[key]() as NonNullable<TextAnimatorProps[K]>;
}

export function createRangeSelector(): RangeSelector {
  return {
    id: uid('sel'), type: 'range', name: 'Range Selector 1', enabled: true,
    start: prop(0), end: prop(100), offset: prop(0), units: 'percent', basedOn: 'characters', mode: 'add',
    amount: prop(100), shape: 'square', smoothness: prop(100), easeHigh: prop(0), easeLow: prop(0),
    randomize: false, seed: 0,
  };
}

export function createWigglySelector(): WigglySelector {
  return {
    id: uid('sel'), type: 'wiggly', name: 'Wiggly Selector 1', enabled: true, mode: 'intersect',
    maxAmount: prop(100), minAmount: prop(-100), basedOn: 'characters', wigglesPerSecond: prop(2),
    correlation: prop(50), temporalPhase: prop(0), spatialPhase: prop(0), lockDimensions: false, seed: 0,
  };
}

export function createTextAnimator(keys: TextAnimatorPropKey[] = ['opacity'], index = 1): TextAnimator {
  const props: TextAnimatorProps = {};
  for (const k of keys) (props as Record<string, unknown>)[k] = createAnimatorProp(k);
  return { id: uid('ta'), name: `Animator ${index}`, enabled: true, props, selectors: [createRangeSelector()] };
}

// ── footage ─────────────────────────────────────────────────────────────────

export function createFootage(o: Partial<Footage> & Pick<Footage, 'name' | 'kind'>): Footage {
  return {
    id: uid('f'),
    mime: '',
    width: 0,
    height: 0,
    duration: 0,
    frameRate: 30,
    hasVideo: o.kind !== 'audio',
    hasAudio: o.kind === 'audio',
    bytes: 0,
    folderId: null,
    interpret: { frameRate: null, alpha: 'straight', invertAlpha: false, loop: 1 },
    ...o,
  };
}
