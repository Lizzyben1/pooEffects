// ─────────────────────────────────────────────────────────────────────────────
// pooEffects document model
//
// The project document is a plain, JSON-serialisable tree. It is treated as an
// immutable value (edits go through immer), which gives us cheap undo/redo,
// structural sharing for cache invalidation, and trivial transfer to the
// render worker via structured clone.
//
// Time is stored in SECONDS. Keyframe times are stored in LAYER time
// (relative to layer.startTime, divided by the layer's stretch factor), so
// moving or stretching a layer carries its animation with it — exactly like
// After Effects.
// ─────────────────────────────────────────────────────────────────────────────

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
/** Straight (non-premultiplied) RGBA, components in [0,1]. */
export type RGBA = [number, number, number, number];

// ── Bézier paths (shapes, masks) ────────────────────────────────────────────

/** Lottie/AE style path: vertices with tangents RELATIVE to their vertex. */
export interface BezierPath {
  closed: boolean;
  v: Vec2[];
  i: Vec2[];
  o: Vec2[];
}

export interface GradientStop {
  /** position 0..1 */
  p: number;
  c: RGBA;
}

export interface CurvesValue {
  /** Control points per channel in [0,1]x[0,1], sorted by x. */
  rgb: Vec2[];
  r: Vec2[];
  g: Vec2[];
  b: Vec2[];
  a: Vec2[];
}

export type PropValue = number | number[] | string | boolean | BezierPath | GradientStop[] | CurvesValue | null;

// ── Keyframes ───────────────────────────────────────────────────────────────

export type TemporalInterp = 'linear' | 'bezier' | 'continuous' | 'auto' | 'hold';
export type SpatialInterp = 'linear' | 'bezier' | 'continuous' | 'auto';

/**
 * After Effects temporal ease: speed in property units per second, influence as a fraction (0..1)
 * of the time span to the neighbouring keyframe.
 */
export interface Ease {
  speed: number;
  influence: number;
}

export interface Keyframe<V = PropValue> {
  id: string;
  /** Layer time, seconds. */
  t: number;
  v: V;
  inType: TemporalInterp;
  outType: TemporalInterp;
  /** One entry for 1D & spatial properties, otherwise one per dimension. */
  easeIn: Ease[];
  easeOut: Ease[];
  /** Spatial tangents (position-like properties), relative to the keyframe value. */
  spatial?: SpatialInterp;
  ti?: number[];
  to?: number[];
  roving?: boolean;
}

export interface AnimProp<V = PropValue> {
  /** Static value, used when there are no keyframes. */
  value: V;
  /** Sorted by time. Stopwatch is "on" when non-empty. */
  keyframes: Keyframe<V>[];
  expression?: string;
  expressionEnabled?: boolean;
}

// ── Blend & matte ───────────────────────────────────────────────────────────

export const BLEND_MODES = [
  'normal', 'dissolve',
  'darken', 'multiply', 'colorBurn', 'linearBurn', 'darkerColor',
  'lighten', 'screen', 'colorDodge', 'add', 'lighterColor',
  'overlay', 'softLight', 'hardLight', 'linearLight', 'vividLight', 'pinLight', 'hardMix',
  'difference', 'exclusion', 'subtract', 'divide',
  'hue', 'saturation', 'color', 'luminosity',
  'stencilAlpha', 'stencilLuma', 'silhouetteAlpha', 'silhouetteLuma', 'alphaAdd', 'luminescentPremul',
] as const;
export type BlendMode = (typeof BLEND_MODES)[number];

export type MatteMode = 'alpha' | 'alphaInverted' | 'luma' | 'lumaInverted';

export interface TrackMatte {
  layerId: string;
  mode: MatteMode;
}

// ── Transform ───────────────────────────────────────────────────────────────

export interface Transform {
  /** [x, y, z] in layer space */
  anchor: AnimProp<number[]>;
  /** [x, y, z] in parent / comp space (spatial) */
  position: AnimProp<number[]>;
  /** [x, y, z] percent */
  scale: AnimProp<number[]>;
  /** [x, y, z] degrees — 3D only */
  orientation: AnimProp<number[]>;
  rotationX: AnimProp<number>;
  rotationY: AnimProp<number>;
  /** Z rotation (the only rotation for 2D layers), degrees */
  rotation: AnimProp<number>;
  /** 0..100 */
  opacity: AnimProp<number>;
}

// ── Masks ───────────────────────────────────────────────────────────────────

export type MaskMode = 'none' | 'add' | 'subtract' | 'intersect' | 'lighten' | 'darken' | 'difference';

export interface Mask {
  id: string;
  name: string;
  mode: MaskMode;
  inverted: boolean;
  locked: boolean;
  color: RGBA;
  path: AnimProp<BezierPath>;
  /** [x, y] pixels */
  feather: AnimProp<number[]>;
  /** 0..100 */
  opacity: AnimProp<number>;
  /** pixels */
  expansion: AnimProp<number>;
}

// ── Effects ─────────────────────────────────────────────────────────────────

export interface EffectInstance {
  id: string;
  /** Registry key, e.g. "gaussianBlur" */
  type: string;
  name: string;
  enabled: boolean;
  params: Record<string, AnimProp>;
}

// ── Markers ─────────────────────────────────────────────────────────────────

export interface Marker {
  id: string;
  /** comp time for comp markers, layer time for layer markers */
  time: number;
  duration: number;
  comment: string;
  label: number;
}

// ── Shape layer contents ────────────────────────────────────────────────────

export interface ShapeItemBase {
  id: string;
  name: string;
  enabled: boolean;
}

export interface ShapeTransform {
  anchor: AnimProp<number[]>;
  position: AnimProp<number[]>;
  scale: AnimProp<number[]>;
  rotation: AnimProp<number>;
  opacity: AnimProp<number>;
  skew: AnimProp<number>;
  skewAxis: AnimProp<number>;
}

export interface ShapeGroup extends ShapeItemBase {
  type: 'group';
  contents: ShapeItem[];
  transform: ShapeTransform;
  blendMode: BlendMode;
}

export interface ShapeRect extends ShapeItemBase {
  type: 'rect';
  size: AnimProp<number[]>;
  position: AnimProp<number[]>;
  roundness: AnimProp<number>;
  reversed: boolean;
}

export interface ShapeEllipse extends ShapeItemBase {
  type: 'ellipse';
  size: AnimProp<number[]>;
  position: AnimProp<number[]>;
  reversed: boolean;
}

export interface ShapePolystar extends ShapeItemBase {
  type: 'polystar';
  starType: 'star' | 'polygon';
  points: AnimProp<number>;
  position: AnimProp<number[]>;
  rotation: AnimProp<number>;
  innerRadius: AnimProp<number>;
  outerRadius: AnimProp<number>;
  innerRoundness: AnimProp<number>;
  outerRoundness: AnimProp<number>;
  reversed: boolean;
}

export interface ShapePath extends ShapeItemBase {
  type: 'path';
  path: AnimProp<BezierPath>;
  reversed: boolean;
}

export type LineCap = 'butt' | 'round' | 'square';
export type LineJoin = 'miter' | 'round' | 'bevel';

export interface ShapeFill extends ShapeItemBase {
  type: 'fill';
  color: AnimProp<RGBA>;
  opacity: AnimProp<number>;
  fillRule: 'nonzero' | 'evenodd';
  blendMode: BlendMode;
}

export interface StrokeDashes {
  enabled: boolean;
  dash: AnimProp<number>;
  gap: AnimProp<number>;
  offset: AnimProp<number>;
}

export interface ShapeStroke extends ShapeItemBase {
  type: 'stroke';
  color: AnimProp<RGBA>;
  opacity: AnimProp<number>;
  width: AnimProp<number>;
  lineCap: LineCap;
  lineJoin: LineJoin;
  miterLimit: number;
  dashes: StrokeDashes;
  blendMode: BlendMode;
}

export interface ShapeGradientFill extends ShapeItemBase {
  type: 'gfill';
  gradientType: 'linear' | 'radial';
  start: AnimProp<number[]>;
  end: AnimProp<number[]>;
  colors: AnimProp<GradientStop[]>;
  opacity: AnimProp<number>;
  fillRule: 'nonzero' | 'evenodd';
  blendMode: BlendMode;
}

export interface ShapeGradientStroke extends ShapeItemBase {
  type: 'gstroke';
  gradientType: 'linear' | 'radial';
  start: AnimProp<number[]>;
  end: AnimProp<number[]>;
  colors: AnimProp<GradientStop[]>;
  opacity: AnimProp<number>;
  width: AnimProp<number>;
  lineCap: LineCap;
  lineJoin: LineJoin;
  miterLimit: number;
  dashes: StrokeDashes;
  blendMode: BlendMode;
}

export interface ShapeTrim extends ShapeItemBase {
  type: 'trim';
  /** percent */
  start: AnimProp<number>;
  end: AnimProp<number>;
  /** degrees; 360° = one full path length */
  offset: AnimProp<number>;
  mode: 'simultaneous' | 'individual';
}

export interface RepeaterTransform {
  anchor: AnimProp<number[]>;
  position: AnimProp<number[]>;
  scale: AnimProp<number[]>;
  rotation: AnimProp<number>;
  startOpacity: AnimProp<number>;
  endOpacity: AnimProp<number>;
}

export interface ShapeRepeater extends ShapeItemBase {
  type: 'repeater';
  copies: AnimProp<number>;
  offset: AnimProp<number>;
  composite: 'above' | 'below';
  transform: RepeaterTransform;
}

export interface ShapeMerge extends ShapeItemBase {
  type: 'merge';
  mode: 'merge' | 'add' | 'subtract' | 'intersect' | 'exclude';
}

export interface ShapeZigZag extends ShapeItemBase {
  type: 'zigzag';
  size: AnimProp<number>;
  ridges: AnimProp<number>;
  pointType: 'corner' | 'smooth';
}

export interface ShapeRoundCorners extends ShapeItemBase {
  type: 'roundCorners';
  radius: AnimProp<number>;
}

export interface ShapeOffset extends ShapeItemBase {
  type: 'offset';
  amount: AnimProp<number>;
  lineJoin: LineJoin;
  miterLimit: number;
}

export interface ShapePuckerBloat extends ShapeItemBase {
  type: 'puckerBloat';
  amount: AnimProp<number>;
}

export interface ShapeTwist extends ShapeItemBase {
  type: 'twist';
  angle: AnimProp<number>;
  center: AnimProp<number[]>;
}

export interface ShapeWiggle extends ShapeItemBase {
  type: 'wiggle';
  size: AnimProp<number>;
  detail: AnimProp<number>;
  wigglesPerSecond: AnimProp<number>;
  correlation: AnimProp<number>;
  temporalPhase: AnimProp<number>;
  spatialPhase: AnimProp<number>;
  seed: number;
  pointType: 'corner' | 'smooth';
}

export type ShapeItem =
  | ShapeGroup | ShapeRect | ShapeEllipse | ShapePolystar | ShapePath
  | ShapeFill | ShapeStroke | ShapeGradientFill | ShapeGradientStroke
  | ShapeTrim | ShapeRepeater | ShapeMerge | ShapeZigZag | ShapeRoundCorners
  | ShapeOffset | ShapePuckerBloat | ShapeTwist | ShapeWiggle;

export type ShapeItemType = ShapeItem['type'];

// ── Text ────────────────────────────────────────────────────────────────────

export interface TextDocument {
  font: string;
  weight: number;
  italic: boolean;
  size: number;
  fill: RGBA;
  fillOn: boolean;
  stroke: RGBA;
  strokeOn: boolean;
  strokeWidth: number;
  strokeOverFill: boolean;
  /** 1/1000 em */
  tracking: number;
  /** pixels; 0 = auto (120%) */
  leading: number;
  justify: 'left' | 'center' | 'right';
  allCaps: boolean;
  baselineShift: number;
  /** paragraph text box width (wraps words); null = point text */
  boxWidth: number | null;
}

export type TextBasedOn = 'characters' | 'charactersExcludingSpaces' | 'words' | 'lines';
export type SelectorMode = 'add' | 'subtract' | 'intersect' | 'min' | 'max' | 'difference';

export interface RangeSelector {
  id: string;
  type: 'range';
  name: string;
  enabled: boolean;
  start: AnimProp<number>;
  end: AnimProp<number>;
  offset: AnimProp<number>;
  units: 'percent' | 'index';
  basedOn: TextBasedOn;
  mode: SelectorMode;
  amount: AnimProp<number>;
  shape: 'square' | 'rampUp' | 'rampDown' | 'triangle' | 'round' | 'smooth';
  smoothness: AnimProp<number>;
  easeHigh: AnimProp<number>;
  easeLow: AnimProp<number>;
  randomize: boolean;
  seed: number;
}

export interface WigglySelector {
  id: string;
  type: 'wiggly';
  name: string;
  enabled: boolean;
  mode: SelectorMode;
  maxAmount: AnimProp<number>;
  minAmount: AnimProp<number>;
  basedOn: TextBasedOn;
  wigglesPerSecond: AnimProp<number>;
  correlation: AnimProp<number>;
  temporalPhase: AnimProp<number>;
  spatialPhase: AnimProp<number>;
  lockDimensions: boolean;
  seed: number;
}

export type TextSelector = RangeSelector | WigglySelector;

export interface TextAnimatorProps {
  anchor?: AnimProp<number[]>;
  position?: AnimProp<number[]>;
  scale?: AnimProp<number[]>;
  skew?: AnimProp<number>;
  rotation?: AnimProp<number>;
  opacity?: AnimProp<number>;
  fillColor?: AnimProp<RGBA>;
  strokeColor?: AnimProp<RGBA>;
  strokeWidth?: AnimProp<number>;
  tracking?: AnimProp<number>;
  blur?: AnimProp<number[]>;
}

export type TextAnimatorPropKey = keyof TextAnimatorProps;

export interface TextAnimator {
  id: string;
  name: string;
  enabled: boolean;
  props: TextAnimatorProps;
  selectors: TextSelector[];
}

export interface TextLayerData {
  sourceText: AnimProp<string>;
  document: TextDocument;
  animators: TextAnimator[];
  grouping: 'character' | 'word' | 'line' | 'all';
}

// ── Camera & lights ─────────────────────────────────────────────────────────

export interface CameraData {
  kind: 'oneNode' | 'twoNode';
  pointOfInterest: AnimProp<number[]>;
  /** pixels — distance at which layers appear at 100% */
  zoom: AnimProp<number>;
  depthOfField: boolean;
  focusDistance: AnimProp<number>;
  /** pixels */
  aperture: AnimProp<number>;
  /** percent */
  blurLevel: AnimProp<number>;
}

export type LightKind = 'parallel' | 'spot' | 'point' | 'ambient';

export interface LightData {
  kind: LightKind;
  pointOfInterest: AnimProp<number[]>;
  /** percent */
  intensity: AnimProp<number>;
  color: AnimProp<RGBA>;
  coneAngle: AnimProp<number>;
  coneFeather: AnimProp<number>;
  falloff: 'none' | 'smooth' | 'inverseSquare';
  radius: AnimProp<number>;
  falloffDistance: AnimProp<number>;
}

export interface MaterialOptions {
  acceptsLights: boolean;
  ambient: AnimProp<number>;
  diffuse: AnimProp<number>;
  specularIntensity: AnimProp<number>;
  specularShininess: AnimProp<number>;
  metal: AnimProp<number>;
}

// ── Motion tracking ─────────────────────────────────────────────────────────

export type TrackChannel = 'luminance' | 'red' | 'green' | 'blue' | 'saturation';
/** transform = Track Motion (1–2 points), stabilize = Stabilize Motion, perspective = planar corner pin */
export type TrackerKind = 'transform' | 'stabilize' | 'perspective';
export type LowConfidenceAction = 'continue' | 'stop' | 'extrapolate' | 'adapt';

export interface TrackerOptions {
  channel: TrackChannel;
  /** Gaussian pre-blur (sigma, pixels) applied before matching */
  blur: number;
  /** refresh the feature template on every frame */
  adaptFeature: boolean;
  /** search around the position predicted from the previous motion */
  predictMotion: boolean;
  subpixel: boolean;
  /** 0..100 */
  confidenceThreshold: number;
  onLowConfidence: LowConfidenceAction;
}

/** One feature point. All coordinates are LAYER (source) pixels. */
export interface TrackPoint {
  id: string;
  name: string;
  enabled: boolean;
  featureCenter: AnimProp<number[]>;
  /** [w, h] */
  featureSize: number[];
  /** search-region centre relative to the feature centre */
  searchOffset: number[];
  /** [w, h] */
  searchSize: number[];
  /** 0..100 */
  confidence: AnimProp<number>;
  attachPoint: AnimProp<number[]>;
  /** attach point − feature centre */
  attachOffset: number[];
}

export interface Tracker {
  id: string;
  name: string;
  kind: TrackerKind;
  position: boolean;
  rotation: boolean;
  scale: boolean;
  /** transform/stabilize: 1–2 points; perspective: 4 corners (UL, UR, LR, LL) */
  points: TrackPoint[];
  targetLayerId: string | null;
  applyDims: 'xy' | 'x' | 'y';
  options: TrackerOptions;
}

export interface CameraSolveFrame {
  /** world → camera rotation, row-major 3×3 (solver space) */
  R: number[];
  t: number[];
}

export interface CameraTrackPoint {
  id: number;
  /** solver-space position */
  X: number[];
  /** median reprojection error (analysis pixels) */
  error: number;
  /** first/last analysed frame index in which the feature was tracked */
  first: number;
  last: number;
  color: number[];
}

export interface CameraTrack {
  id: string;
  shotType: 'auto' | 'free' | 'tripod';
  /** specified horizontal angle of view (degrees); null = estimate */
  fov: number | null;
  detail: 'low' | 'medium' | 'high';
  solved: boolean;
  /** analysis raster (pixels) and source pixels per analysis pixel */
  width: number;
  height: number;
  sourceScale: number;
  mode: 'free' | 'tripod';
  /** focal length, analysis pixels */
  f: number;
  /** layer time of analysed frame 0 and the frame duration */
  t0: number;
  dt: number;
  frames: CameraSolveFrame[];
  /** RMS reprojection error per frame (analysis pixels, −1 when unsolved) */
  frameError: number[];
  points: CameraTrackPoint[];
  rms: number;
  /** solver-space ground plane: origin + unit normal (pointing away from the cameras) */
  ground: { origin: number[]; normal: number[] } | null;
  /** solver-space → comp-space scale multiplier chosen by the user (1 = automatic) */
  sceneScale: number;
}

/**
 * Roto (SAM 2) segmentation. Matte pixels live outside the document in an immutable revision store;
 * the document maps frame → revision, so undo/redo restores earlier mattes exactly.
 */
export interface MattePrompt {
  /** layer-time frame index (round(layerTime × fps)) */
  frame: number;
  /** matte pixels; label 1 = foreground, 0 = background */
  points: [number, number, number][];
}

export interface MatteInfo {
  id: string;
  layerId: string;
  name: string;
  /** matte raster size */
  width: number;
  height: number;
  /** frame indexing rate (comp frame rate at creation) */
  fps: number;
  /** layer-time frame index → matte revision id */
  revs: Record<string, number>;
  prompts: MattePrompt[];
}

// ── Layers ──────────────────────────────────────────────────────────────────

export type LayerType =
  | 'solid' | 'null' | 'shape' | 'text' | 'image' | 'video' | 'audio' | 'precomp' | 'camera' | 'light';

export type AutoOrient = 'off' | 'path' | 'camera';

export interface Layer {
  id: string;
  name: string;
  type: LayerType;
  label: number;
  comment: string;

  // timing (composition seconds)
  inPoint: number;
  outPoint: number;
  startTime: number;
  /** percent; negative = time-reversed */
  stretch: number;
  timeRemapEnabled: boolean;
  /** source seconds */
  timeRemap: AnimProp<number>;

  // switches
  enabled: boolean;
  audioEnabled: boolean;
  solo: boolean;
  locked: boolean;
  shy: boolean;
  threeD: boolean;
  motionBlur: boolean;
  adjustment: boolean;
  collapse: boolean;
  quality: 'draft' | 'best';
  effectsEnabled: boolean;
  guide: boolean;
  autoOrient: AutoOrient;

  blendMode: BlendMode;
  preserveTransparency: boolean;
  parentId: string | null;
  trackMatte: TrackMatte | null;

  transform: Transform;
  masks: Mask[];
  effects: EffectInstance[];
  markers: Marker[];
  material: MaterialOptions;

  // type-specific payloads
  solid?: { color: RGBA; width: number; height: number };
  source?: { footageId?: string; compId?: string };
  shape?: { contents: ShapeItem[] };
  text?: TextLayerData;
  camera?: CameraData;
  light?: LightData;
  audio?: { levels: AnimProp<number[]> };
  trackers?: Tracker[];
  cameraTrack?: CameraTrack | null;
}

// ── Composition & project ───────────────────────────────────────────────────

export interface Composition {
  id: string;
  name: string;
  width: number;
  height: number;
  pixelAspect: number;
  /** nominal frame rate (23.976, 24, 25, 29.97, 30, 50, 59.94, 60, …) */
  frameRate: number;
  dropFrame: boolean;
  duration: number;
  bgColor: RGBA;
  /** index 0 = top of the stack */
  layers: Layer[];
  workArea: [number, number];
  motionBlur: boolean;
  shutterAngle: number;
  shutterPhase: number;
  motionBlurSamples: number;
  bitDepth: 8 | 16 | 32;
  markers: Marker[];
  hideShyLayers: boolean;
  folderId: string | null;
}

export interface FootageInterpretation {
  /** conform frame rate; null = use native */
  frameRate: number | null;
  alpha: 'straight' | 'premultiplied' | 'ignore';
  invertAlpha: boolean;
  loop: number;
}

export type FootageKind = 'image' | 'video' | 'audio';

export interface Footage {
  id: string;
  name: string;
  kind: FootageKind;
  mime: string;
  width: number;
  height: number;
  /** seconds; images use 0 (still) */
  duration: number;
  frameRate: number;
  hasVideo: boolean;
  hasAudio: boolean;
  bytes: number;
  folderId: string | null;
  interpret: FootageInterpretation;
  /** generated asset (demo media), regenerated procedurally instead of stored */
  procedural?: string;
}

export interface Folder {
  id: string;
  name: string;
  folderId: string | null;
}

export interface ProjectSettings {
  expressionsEnabled: boolean;
  timeDisplay: 'timecode' | 'frames';
  /** frame numbering start for "frames" display */
  frameStart: 0 | 1;
}

export interface Project {
  format: 'pooeffects';
  version: number;
  name: string;
  comps: Record<string, Composition>;
  footage: Record<string, Footage>;
  folders: Record<string, Folder>;
  settings: ProjectSettings;
  /** roto segmentations (matte pixels are stored outside the document) */
  mattes?: Record<string, MatteInfo>;
}

// ── Property descriptors (UI + evaluation metadata) ─────────────────────────

export type PropKind =
  | 'number' | 'angle' | 'percent' | 'slider'
  | 'vec2' | 'vec3' | 'point2' | 'point3'
  | 'color' | 'bool' | 'enum' | 'path' | 'text' | 'gradient' | 'curves' | 'layer';

export interface EnumOption {
  value: string | number;
  label: string;
}

export interface PropDescriptor {
  name: string;
  kind: PropKind;
  /** position-like: interpolated along a spatial Bézier path */
  spatial?: boolean;
  dims?: number;
  min?: number;
  max?: number;
  /** slider range for UI */
  softMin?: number;
  softMax?: number;
  step?: number;
  unit?: string;
  options?: EnumOption[];
  animatable?: boolean;
  /** hide from UI */
  hidden?: boolean;
  /** decimal places shown */
  precision?: number;
}

/** Dot-separated property address within a layer, e.g. "transform.position" or "effects.fx_1.params.radius". */
export type PropPath = string;

export interface KeyframeRef {
  layerId: string;
  path: PropPath;
  kfId: string;
}
