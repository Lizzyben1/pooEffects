// ─────────────────────────────────────────────────────────────────────────────
// Effect catalog — parameter schemas shared by the UI and the GPU implementations.
// This module must stay free of WebGL code so the main thread can import it.
// Point parameters are expressed in LAYER space pixels.
// ─────────────────────────────────────────────────────────────────────────────

import type { CurvesValue, GradientStop, PropDescriptor, PropValue, RGBA } from '../core/types';

export interface LayerDims {
  w: number;
  h: number;
}

export interface EffectParamDef extends PropDescriptor {
  id: string;
  default: PropValue | ((d: LayerDims) => PropValue);
  /** UI group label (rendered as a twirl-down) */
  group?: string;
}

export interface EffectDef {
  type: string;
  name: string;
  category: EffectCategory;
  params: EffectParamDef[];
  description: string;
  /** pixels of padding the effect may add around the layer at 100% (function of params) */
  expands?: boolean;
}

export type EffectCategory =
  | 'Blur & Sharpen' | 'Color Correction' | 'Distort' | 'Generate' | 'Keying'
  | 'Noise & Grain' | 'Perspective' | 'Stylize' | 'Transition' | 'Audio' | 'Expression Controls';

export const EFFECT_CATEGORIES: EffectCategory[] = [
  'Audio', 'Blur & Sharpen', 'Color Correction', 'Distort', 'Expression Controls', 'Generate', 'Keying',
  'Noise & Grain', 'Perspective', 'Stylize', 'Transition',
];

/** Effects that render nothing (rig controls for expressions). */
export const PASSTHROUGH_EFFECTS = new Set(['sliderControl', 'angleControl', 'pointControl', 'colorControl', 'checkboxControl']);

const C = (r: number, g: number, b: number, a = 1): RGBA => [r, g, b, a];

const slider = (id: string, name: string, def: number, softMin: number, softMax: number, extra: Partial<EffectParamDef> = {}): EffectParamDef =>
  ({ id, name, kind: 'slider', default: def, softMin, softMax, precision: 2, ...extra });
const num = (id: string, name: string, def: number, extra: Partial<EffectParamDef> = {}): EffectParamDef =>
  ({ id, name, kind: 'number', default: def, precision: 1, ...extra });
const angle = (id: string, name: string, def = 0, extra: Partial<EffectParamDef> = {}): EffectParamDef =>
  ({ id, name, kind: 'angle', default: def, ...extra });
const point = (id: string, name: string, def: (d: LayerDims) => number[], extra: Partial<EffectParamDef> = {}): EffectParamDef =>
  ({ id, name, kind: 'point2', dims: 2, spatial: true, default: def, ...extra });
const color = (id: string, name: string, def: RGBA, extra: Partial<EffectParamDef> = {}): EffectParamDef =>
  ({ id, name, kind: 'color', default: def, ...extra });
const bool = (id: string, name: string, def: boolean, extra: Partial<EffectParamDef> = {}): EffectParamDef =>
  ({ id, name, kind: 'bool', default: def, animatable: false, ...extra });
const choice = (id: string, name: string, options: [string, string][], def: string, extra: Partial<EffectParamDef> = {}): EffectParamDef =>
  ({ id, name, kind: 'enum', default: def, options: options.map(([value, label]) => ({ value, label })), animatable: false, ...extra });
const pct = (id: string, name: string, def: number, extra: Partial<EffectParamDef> = {}): EffectParamDef =>
  ({ id, name, kind: 'percent', default: def, min: 0, max: 100, softMin: 0, softMax: 100, unit: '%', precision: 1, ...extra });

const center = (d: LayerDims) => [d.w / 2, d.h / 2];

export const DEFAULT_CURVES: CurvesValue = {
  rgb: [[0, 0], [1, 1]],
  r: [[0, 0], [1, 1]],
  g: [[0, 0], [1, 1]],
  b: [[0, 0], [1, 1]],
  a: [[0, 0], [1, 1]],
};

export const GRADIENT_PRESETS: Record<string, GradientStop[]> = {
  'Fire': [
    { p: 0, c: C(0, 0, 0) }, { p: 0.35, c: C(0.7, 0.05, 0.02) }, { p: 0.65, c: C(1, 0.55, 0.05) }, { p: 1, c: C(1, 0.97, 0.75) },
  ],
  'Ocean': [
    { p: 0, c: C(0.01, 0.02, 0.1) }, { p: 0.45, c: C(0.0, 0.32, 0.55) }, { p: 0.8, c: C(0.2, 0.8, 0.85) }, { p: 1, c: C(0.92, 1, 1) },
  ],
  'Rainbow': [
    { p: 0, c: C(1, 0, 0) }, { p: 0.17, c: C(1, 1, 0) }, { p: 0.33, c: C(0, 1, 0) }, { p: 0.5, c: C(0, 1, 1) },
    { p: 0.67, c: C(0, 0, 1) }, { p: 0.83, c: C(1, 0, 1) }, { p: 1, c: C(1, 0, 0) },
  ],
  'Golden Hour': [
    { p: 0, c: C(0.12, 0.03, 0.18) }, { p: 0.4, c: C(0.8, 0.2, 0.25) }, { p: 0.7, c: C(1, 0.6, 0.2) }, { p: 1, c: C(1, 0.93, 0.7) },
  ],
  'Neon': [
    { p: 0, c: C(0.05, 0, 0.15) }, { p: 0.33, c: C(0.95, 0.1, 0.75) }, { p: 0.66, c: C(0.1, 0.8, 1) }, { p: 1, c: C(0.05, 0, 0.15) },
  ],
  'Aurora': [
    { p: 0, c: C(0.0, 0.03, 0.08) }, { p: 0.35, c: C(0.05, 0.6, 0.45) }, { p: 0.6, c: C(0.3, 0.95, 0.6) }, { p: 0.85, c: C(0.55, 0.3, 0.9) }, { p: 1, c: C(0.0, 0.03, 0.08) },
  ],
  'Mono': [{ p: 0, c: C(0, 0, 0) }, { p: 1, c: C(1, 1, 1) }],
  'Poo Gold': [
    { p: 0, c: C(0.16, 0.08, 0.03) }, { p: 0.45, c: C(0.55, 0.3, 0.1) }, { p: 0.75, c: C(1, 0.66, 0.24) }, { p: 1, c: C(1, 0.92, 0.72) },
  ],
};

const BLEND_OPTIONS: [string, string][] = [
  ['normal', 'Normal'], ['add', 'Add'], ['multiply', 'Multiply'], ['screen', 'Screen'], ['overlay', 'Overlay'],
  ['softLight', 'Soft Light'], ['hardLight', 'Hard Light'], ['difference', 'Difference'],
];

export const EFFECTS: EffectDef[] = [
  // ── Blur & Sharpen ────────────────────────────────────────────────────────
  {
    type: 'gaussianBlur', name: 'Gaussian Blur', category: 'Blur & Sharpen', expands: true,
    description: 'Separable two-pass Gaussian blur.',
    params: [
      slider('blurriness', 'Blurriness', 10, 0, 100, { min: 0, max: 2000 }),
      choice('dimensions', 'Blur Dimensions', [['both', 'Horizontal and Vertical'], ['h', 'Horizontal'], ['v', 'Vertical']], 'both'),
      bool('repeatEdge', 'Repeat Edge Pixels', false),
    ],
  },
  {
    type: 'directionalBlur', name: 'Directional Blur', category: 'Blur & Sharpen', expands: true,
    description: 'Motion-style blur along an angle.',
    params: [angle('direction', 'Direction', 0), slider('length', 'Blur Length', 10, 0, 200, { min: 0, max: 1000 })],
  },
  {
    type: 'radialBlur', name: 'Radial Blur', category: 'Blur & Sharpen',
    description: 'Spin or zoom blur around a center point.',
    params: [
      slider('amount', 'Amount', 10, 0, 100, { min: 0, max: 100 }),
      point('center', 'Center', center),
      choice('kind', 'Type', [['spin', 'Spin'], ['zoom', 'Zoom']], 'zoom'),
    ],
  },
  {
    type: 'sharpen', name: 'Sharpen', category: 'Blur & Sharpen',
    description: 'Unsharp-mask style sharpening.',
    params: [slider('amount', 'Sharpen Amount', 25, 0, 100, { min: 0, max: 500 })],
  },

  // ── Color Correction ──────────────────────────────────────────────────────
  {
    type: 'curves', name: 'Curves', category: 'Color Correction',
    description: 'Per-channel tone curves (monotone cubic spline LUT).',
    params: [{ id: 'curves', name: 'Curves', kind: 'curves', default: DEFAULT_CURVES }],
  },
  {
    type: 'levels', name: 'Levels', category: 'Color Correction',
    description: 'Input/output black & white points with gamma.',
    params: [
      choice('channel', 'Channel', [['rgb', 'RGB'], ['r', 'Red'], ['g', 'Green'], ['b', 'Blue'], ['a', 'Alpha']], 'rgb'),
      slider('inBlack', 'Input Black', 0, 0, 255, { precision: 1 }),
      slider('inWhite', 'Input White', 255, 0, 255, { precision: 1 }),
      slider('gamma', 'Gamma', 1, 0.1, 5, { min: 0.01, max: 10 }),
      slider('outBlack', 'Output Black', 0, 0, 255, { precision: 1 }),
      slider('outWhite', 'Output White', 255, 0, 255, { precision: 1 }),
    ],
  },
  {
    type: 'hueSaturation', name: 'Hue/Saturation', category: 'Color Correction',
    description: 'Master hue rotation, saturation and lightness, or colorize.',
    params: [
      angle('hue', 'Master Hue', 0),
      slider('saturation', 'Master Saturation', 0, -100, 100, { min: -100, max: 100, precision: 0 }),
      slider('lightness', 'Master Lightness', 0, -100, 100, { min: -100, max: 100, precision: 0 }),
      bool('colorize', 'Colorize', false),
      angle('colorizeHue', 'Colorize Hue', 0),
      slider('colorizeSaturation', 'Colorize Saturation', 25, 0, 100, { min: 0, max: 100, precision: 0 }),
      slider('colorizeLightness', 'Colorize Lightness', 0, -100, 100, { min: -100, max: 100, precision: 0 }),
    ],
  },
  {
    type: 'channelMixer', name: 'Channel Mixer', category: 'Color Correction',
    description: 'Rebuild each output channel from a weighted mix of inputs.',
    params: [
      slider('rr', 'Red-Red', 100, -200, 200, { group: 'Red', precision: 0 }),
      slider('rg', 'Red-Green', 0, -200, 200, { group: 'Red', precision: 0 }),
      slider('rb', 'Red-Blue', 0, -200, 200, { group: 'Red', precision: 0 }),
      slider('rc', 'Red-Const', 0, -200, 200, { group: 'Red', precision: 0 }),
      slider('gr', 'Green-Red', 0, -200, 200, { group: 'Green', precision: 0 }),
      slider('gg', 'Green-Green', 100, -200, 200, { group: 'Green', precision: 0 }),
      slider('gb', 'Green-Blue', 0, -200, 200, { group: 'Green', precision: 0 }),
      slider('gc', 'Green-Const', 0, -200, 200, { group: 'Green', precision: 0 }),
      slider('br', 'Blue-Red', 0, -200, 200, { group: 'Blue', precision: 0 }),
      slider('bg', 'Blue-Green', 0, -200, 200, { group: 'Blue', precision: 0 }),
      slider('bb', 'Blue-Blue', 100, -200, 200, { group: 'Blue', precision: 0 }),
      slider('bc', 'Blue-Const', 0, -200, 200, { group: 'Blue', precision: 0 }),
      bool('monochrome', 'Monochrome', false),
    ],
  },
  {
    type: 'colorama', name: 'Colorama', category: 'Color Correction',
    description: 'Cycle colors through a gradient palette driven by an input phase.',
    params: [
      choice('inputPhase', 'Get Phase From', [['intensity', 'Intensity'], ['red', 'Red'], ['green', 'Green'], ['blue', 'Blue'], ['hue', 'Hue'], ['lightness', 'Lightness'], ['saturation', 'Saturation'], ['alpha', 'Alpha']], 'intensity', { group: 'Input Phase' }),
      angle('phaseShift', 'Phase Shift', 0, { group: 'Input Phase' }),
      { id: 'palette', name: 'Output Cycle', kind: 'gradient', default: GRADIENT_PRESETS['Golden Hour'], group: 'Output Cycle' },
      slider('cycles', 'Cycle Repetitions', 1, 0, 10, { min: 0, max: 100, group: 'Output Cycle' }),
      pct('blend', 'Blend With Original', 0),
    ],
  },
  {
    type: 'tint', name: 'Tint', category: 'Color Correction',
    description: 'Map black and white to two colors.',
    params: [color('black', 'Map Black To', C(0, 0, 0)), color('white', 'Map White To', C(1, 1, 1)), pct('amount', 'Amount to Tint', 100)],
  },
  {
    type: 'tritone', name: 'Tritone', category: 'Color Correction',
    description: 'Map shadows, midtones and highlights to three colors.',
    params: [
      color('highlights', 'Highlights', C(1, 0.95, 0.85)),
      color('midtones', 'Midtones', C(0.58, 0.42, 0.3)),
      color('shadows', 'Shadows', C(0.06, 0.04, 0.03)),
      pct('blend', 'Blend With Original', 0),
    ],
  },
  {
    type: 'exposure', name: 'Exposure', category: 'Color Correction',
    description: 'Photographic exposure in stops, offset and gamma correction.',
    params: [
      slider('exposure', 'Exposure', 0, -5, 5, { min: -20, max: 20 }),
      slider('offset', 'Offset', 0, -0.5, 0.5, { min: -2, max: 2, precision: 3 }),
      slider('gamma', 'Gamma Correction', 1, 0.1, 3, { min: 0.01, max: 10 }),
    ],
  },
  {
    type: 'brightnessContrast', name: 'Brightness & Contrast', category: 'Color Correction',
    description: 'Simple brightness and contrast adjustment.',
    params: [
      slider('brightness', 'Brightness', 0, -150, 150, { min: -150, max: 150, precision: 0 }),
      slider('contrast', 'Contrast', 0, -100, 100, { min: -100, max: 100, precision: 0 }),
    ],
  },
  {
    type: 'invert', name: 'Invert', category: 'Color Correction',
    description: 'Invert color channels.',
    params: [
      choice('channel', 'Channel', [['rgb', 'RGB'], ['r', 'Red'], ['g', 'Green'], ['b', 'Blue'], ['a', 'Alpha']], 'rgb'),
      pct('blend', 'Blend With Original', 0),
    ],
  },

  // ── Distort ───────────────────────────────────────────────────────────────
  {
    type: 'turbulentDisplace', name: 'Turbulent Displace', category: 'Distort', expands: true,
    description: 'Fractal-noise driven displacement with evolution.',
    params: [
      choice('displacement', 'Displacement', [['turbulent', 'Turbulent'], ['bulge', 'Bulge'], ['twist', 'Twist'], ['horizontal', 'Horizontal'], ['vertical', 'Vertical']], 'turbulent'),
      slider('amount', 'Amount', 50, -200, 200, { min: -1000, max: 1000 }),
      slider('size', 'Size', 100, 2, 400, { min: 2, max: 1000 }),
      point('offset', 'Offset (Turbulence)', center),
      slider('complexity', 'Complexity', 1, 1, 10, { min: 1, max: 10, precision: 1 }),
      angle('evolution', 'Evolution', 0),
      choice('pinning', 'Pinning', [['none', 'None'], ['all', 'Pin All']], 'none'),
    ],
  },
  {
    type: 'bulge', name: 'Bulge', category: 'Distort',
    description: 'Lens-like bulge or pinch around a center.',
    params: [
      slider('hRadius', 'Horizontal Radius', 120, 0, 1000, { min: 0, max: 4000 }),
      slider('vRadius', 'Vertical Radius', 120, 0, 1000, { min: 0, max: 4000 }),
      point('center', 'Bulge Center', center),
      slider('height', 'Bulge Height', 1, -4, 4, { min: -4, max: 4 }),
    ],
  },
  {
    type: 'opticsCompensation', name: 'Optics Compensation', category: 'Distort',
    description: 'Simulate (or remove) wide-angle lens barrel distortion.',
    params: [
      slider('fov', 'Field Of View (FOV)', 0, 0, 180, { min: 0, max: 179, precision: 1 }),
      bool('reverse', 'Reverse Lens Distortion', false),
      point('center', 'View Center', center),
    ],
  },
  {
    type: 'cornerPin', name: 'Corner Pin', category: 'Distort', expands: true,
    description: 'Projective four-corner warp.',
    params: [
      point('ul', 'Upper Left', () => [0, 0]),
      point('ur', 'Upper Right', (d) => [d.w, 0]),
      point('ll', 'Lower Left', (d) => [0, d.h]),
      point('lr', 'Lower Right', (d) => [d.w, d.h]),
    ],
  },
  {
    type: 'twirl', name: 'Twirl', category: 'Distort',
    description: 'Rotate pixels around a center, more strongly near the middle.',
    params: [angle('angle', 'Angle', 90), slider('radius', 'Twirl Radius', 30, 0, 100, { min: 0, max: 100 }), point('center', 'Twirl Center', center)],
  },
  {
    type: 'waveWarp', name: 'Wave Warp', category: 'Distort', expands: true,
    description: 'Animated wave distortion.',
    params: [
      choice('waveType', 'Wave Type', [['sine', 'Sine'], ['square', 'Square'], ['triangle', 'Triangle'], ['sawtooth', 'Sawtooth']], 'sine'),
      slider('height', 'Wave Height', 10, 0, 100, { min: -1000, max: 1000 }),
      slider('width', 'Wave Width', 40, 1, 400, { min: 1, max: 2000 }),
      angle('direction', 'Direction', 90),
      slider('speed', 'Wave Speed', 1, -5, 5, { min: -100, max: 100 }),
      angle('phase', 'Phase', 0),
    ],
  },
  {
    type: 'mirror', name: 'Mirror', category: 'Distort',
    description: 'Reflect the image across a line.',
    params: [point('center', 'Reflection Center', center), angle('angle', 'Reflection Angle', 0)],
  },

  // ── Generate ──────────────────────────────────────────────────────────────
  {
    type: 'fractalNoise', name: 'Fractal Noise', category: 'Generate',
    description: 'Multi-octave simplex noise with evolution and seamless loop cycles.',
    params: [
      choice('fractalType', 'Fractal Type', [['basic', 'Basic'], ['turbulentSmooth', 'Turbulent Smooth'], ['turbulentSharp', 'Turbulent Sharp'], ['dynamic', 'Dynamic'], ['max', 'Max']], 'basic'),
      bool('invert', 'Invert', false),
      slider('contrast', 'Contrast', 100, 0, 400, { min: 0, max: 10000, precision: 1 }),
      slider('brightness', 'Brightness', 0, -100, 100, { min: -10000, max: 10000, precision: 1 }),
      angle('rotation', 'Rotation', 0, { group: 'Transform' }),
      slider('scale', 'Scale', 100, 20, 600, { min: 1, max: 10000, group: 'Transform', precision: 1 }),
      slider('scaleW', 'Scale Width', 100, 20, 600, { min: 1, max: 10000, group: 'Transform', precision: 1 }),
      slider('scaleH', 'Scale Height', 100, 20, 600, { min: 1, max: 10000, group: 'Transform', precision: 1 }),
      point('offset', 'Offset Turbulence', center, { group: 'Transform' }),
      slider('complexity', 'Complexity', 6, 1, 20, { min: 1, max: 20, precision: 1 }),
      pct('subInfluence', 'Sub Influence (%)', 70, { group: 'Sub Settings' }),
      slider('subScaling', 'Sub Scaling', 56, 25, 100, { min: 10, max: 100, group: 'Sub Settings', precision: 1 }),
      angle('subRotation', 'Sub Rotation', 0, { group: 'Sub Settings' }),
      angle('evolution', 'Evolution', 0),
      bool('cycle', 'Cycle Evolution', false, { group: 'Evolution Options' }),
      num('cycleRevolutions', 'Cycle (in Revolutions)', 1, { min: 1, max: 100, precision: 0, group: 'Evolution Options' }),
      num('seed', 'Random Seed', 0, { precision: 0, group: 'Evolution Options' }),
      pct('opacity', 'Opacity', 100),
      choice('blend', 'Blending Mode', BLEND_OPTIONS, 'normal'),
    ],
  },
  {
    type: 'gradientRamp', name: 'Gradient Ramp', category: 'Generate',
    description: 'Linear or radial two-color ramp.',
    params: [
      point('start', 'Start of Ramp', (d) => [d.w / 2, 0]),
      color('startColor', 'Start Color', C(0, 0, 0)),
      point('end', 'End of Ramp', (d) => [d.w / 2, d.h]),
      color('endColor', 'End Color', C(1, 1, 1)),
      choice('shape', 'Ramp Shape', [['linear', 'Linear Ramp'], ['radial', 'Radial Ramp']], 'linear'),
      slider('scatter', 'Ramp Scatter', 0, 0, 100, { min: 0, max: 512 }),
      pct('blend', 'Blend With Original', 0),
    ],
  },
  {
    type: 'fourColorGradient', name: '4-Color Gradient', category: 'Generate',
    description: 'Smooth blend between four colored points.',
    params: [
      point('p1', 'Point 1', (d) => [d.w * 0.1, d.h * 0.1]), color('c1', 'Color 1', C(1, 0.85, 0.2)),
      point('p2', 'Point 2', (d) => [d.w * 0.9, d.h * 0.1]), color('c2', 'Color 2', C(0.1, 0.8, 0.3)),
      point('p3', 'Point 3', (d) => [d.w * 0.1, d.h * 0.9]), color('c3', 'Color 3', C(0.9, 0.1, 0.8)),
      point('p4', 'Point 4', (d) => [d.w * 0.9, d.h * 0.9]), color('c4', 'Color 4', C(0.1, 0.3, 1)),
      slider('blend', 'Blend', 100, 1, 500, { min: 1, max: 10000 }),
      pct('opacity', 'Opacity', 100),
    ],
  },
  {
    type: 'grid', name: 'Grid', category: 'Generate',
    description: 'Procedural grid lines.',
    params: [
      point('anchor', 'Anchor', center),
      slider('cellW', 'Width', 100, 4, 500, { min: 1, max: 10000 }),
      slider('cellH', 'Height', 100, 4, 500, { min: 1, max: 10000 }),
      slider('border', 'Border', 2, 0, 50, { min: 0, max: 1000 }),
      slider('feather', 'Feather', 0, 0, 20, { min: 0, max: 200 }),
      bool('invert', 'Invert Grid', false),
      color('color', 'Color', C(1, 1, 1)),
      pct('opacity', 'Opacity', 100),
      choice('blend', 'Blending Mode', [['none', 'None'], ...BLEND_OPTIONS], 'normal'),
    ],
  },
  {
    type: 'fill', name: 'Fill', category: 'Generate',
    description: 'Fill opaque pixels with a solid color.',
    params: [color('color', 'Color', C(1, 0.1, 0.1)), bool('invert', 'Invert', false), pct('opacity', 'Opacity', 100)],
  },
  {
    type: 'lightRays', name: 'Light Rays', category: 'Generate',
    description: 'Volumetric rays streaming from bright pixels around a source point.',
    params: [
      point('center', 'Source Point', center),
      slider('intensity', 'Intensity', 1.2, 0, 5, { min: 0, max: 20 }),
      slider('length', 'Ray Length', 40, 0, 100, { min: 0, max: 100 }),
      pct('threshold', 'Threshold', 35),
      color('color', 'Ray Color', C(1, 0.85, 0.55)),
      choice('composite', 'Composite', [['add', 'Add Over Original'], ['only', 'Rays Only']], 'add'),
    ],
  },
  {
    type: 'audioSpectrum', name: 'Audio Spectrum', category: 'Audio',
    description: 'Frequency bars computed from an audio layer (FFT).',
    params: [
      { id: 'audioLayer', name: 'Audio Layer', kind: 'layer', default: '', animatable: false },
      point('start', 'Start Point', (d) => [d.w * 0.1, d.h * 0.75]),
      point('end', 'End Point', (d) => [d.w * 0.9, d.h * 0.75]),
      num('startFreq', 'Start Frequency', 20, { min: 1, max: 20000, precision: 0 }),
      num('endFreq', 'End Frequency', 4000, { min: 1, max: 20000, precision: 0 }),
      num('bands', 'Frequency Bands', 64, { min: 4, max: 256, precision: 0 }),
      slider('maxHeight', 'Maximum Height', 400, 0, 2000, { min: 0, max: 10000 }),
      slider('duration', 'Audio Duration (ms)', 90, 10, 500, { min: 10, max: 3000, precision: 0 }),
      slider('thickness', 'Thickness', 8, 1, 50, { min: 0.5, max: 500 }),
      pct('softness', 'Softness', 30),
      color('inside', 'Inside Color', C(1, 1, 1)),
      color('outside', 'Outside Color', C(1, 0.55, 0.15)),
      choice('display', 'Display Options', [['digital', 'Digital'], ['lines', 'Analog Lines'], ['dots', 'Analog Dots']], 'digital'),
      choice('side', 'Side Options', [['a', 'Side A'], ['b', 'Side B'], ['ab', 'Side A & B']], 'ab'),
      bool('composite', 'Composite On Original', true),
    ],
  },
  {
    type: 'audioWaveform', name: 'Audio Waveform', category: 'Audio',
    description: 'Oscilloscope-style waveform from an audio layer.',
    params: [
      { id: 'audioLayer', name: 'Audio Layer', kind: 'layer', default: '', animatable: false },
      point('start', 'Start Point', (d) => [d.w * 0.1, d.h / 2]),
      point('end', 'End Point', (d) => [d.w * 0.9, d.h / 2]),
      num('samples', 'Displayed Samples', 256, { min: 8, max: 2048, precision: 0 }),
      slider('maxHeight', 'Maximum Height', 300, 0, 2000, { min: 0, max: 10000 }),
      slider('duration', 'Audio Duration (ms)', 90, 10, 1000, { min: 10, max: 3000, precision: 0 }),
      slider('thickness', 'Thickness', 3, 0.5, 30, { min: 0.5, max: 500 }),
      pct('softness', 'Softness', 40),
      color('inside', 'Inside Color', C(1, 1, 1)),
      color('outside', 'Outside Color', C(0.3, 0.75, 1)),
      bool('composite', 'Composite On Original', true),
    ],
  },

  // ── Keying ────────────────────────────────────────────────────────────────
  {
    type: 'colorKey', name: 'Chroma Key', category: 'Keying',
    description: 'Key out a color (green/blue screen) with spill suppression.',
    params: [
      color('keyColor', 'Key Color', C(0.1, 0.85, 0.2)),
      pct('similarity', 'Similarity', 30),
      pct('smoothness', 'Smoothness', 10),
      pct('spill', 'Spill Suppression', 50),
    ],
  },

  // ── Noise & Grain ─────────────────────────────────────────────────────────
  {
    type: 'noise', name: 'Add Grain', category: 'Noise & Grain',
    description: 'Animated film grain.',
    params: [
      pct('amount', 'Intensity', 15),
      slider('size', 'Size', 1, 0.5, 6, { min: 0.1, max: 50 }),
      bool('color', 'Color Grain', false),
      bool('animated', 'Animate', true),
    ],
  },

  // ── Perspective ───────────────────────────────────────────────────────────
  {
    type: 'dropShadow', name: 'Drop Shadow', category: 'Perspective', expands: true,
    description: 'Offset, blurred shadow behind the layer.',
    params: [
      color('color', 'Shadow Color', C(0, 0, 0)),
      pct('opacity', 'Opacity', 50),
      angle('direction', 'Direction', 135),
      slider('distance', 'Distance', 12, 0, 200, { min: 0, max: 4000 }),
      slider('softness', 'Softness', 20, 0, 250, { min: 0, max: 1000 }),
      bool('shadowOnly', 'Shadow Only', false),
    ],
  },

  // ── Stylize ───────────────────────────────────────────────────────────────
  {
    type: 'glow', name: 'Deep Glow', category: 'Stylize', expands: true,
    description: 'Physically-inspired multi-pass Gaussian bloom pyramid with threshold and tint.',
    params: [
      pct('threshold', 'Glow Threshold', 55),
      slider('radius', 'Glow Radius', 80, 0, 500, { min: 0, max: 3000 }),
      slider('intensity', 'Glow Intensity', 1.2, 0, 6, { min: 0, max: 50 }),
      slider('exposure', 'Exposure', 0, -3, 3, { min: -10, max: 10 }),
      color('tint', 'Tint Color', C(1, 0.62, 0.25)),
      pct('tintAmount', 'Tint Amount', 0),
      slider('aberration', 'Chromatic Aberration', 0, 0, 20, { min: 0, max: 100 }),
      choice('composite', 'Composite', [['onTop', 'On Top'], ['behind', 'Behind'], ['glowOnly', 'Glow Only']], 'onTop'),
    ],
  },
  {
    type: 'findEdges', name: 'Find Edges', category: 'Stylize',
    description: 'Sobel edge detection.',
    params: [bool('invert', 'Invert', false), pct('blend', 'Blend With Original', 0)],
  },
  {
    type: 'threshold', name: 'Threshold', category: 'Stylize',
    description: 'Convert to pure black and white at a luminance level.',
    params: [slider('level', 'Level', 128, 0, 255, { min: 0, max: 255, precision: 0 })],
  },
  {
    type: 'posterize', name: 'Posterize', category: 'Stylize',
    description: 'Reduce the number of tonal levels per channel.',
    params: [slider('level', 'Level', 6, 2, 32, { min: 2, max: 255, precision: 0 })],
  },
  {
    type: 'mosaic', name: 'Mosaic', category: 'Stylize',
    description: 'Pixelate into solid blocks.',
    params: [
      num('hBlocks', 'Horizontal Blocks', 24, { min: 1, max: 4000, precision: 0 }),
      num('vBlocks', 'Vertical Blocks', 14, { min: 1, max: 4000, precision: 0 }),
    ],
  },
  {
    type: 'chromaticAberration', name: 'RGB Split', category: 'Stylize', expands: true,
    description: 'Offset color channels for a lens-fringe look.',
    params: [
      slider('amount', 'Amount', 6, 0, 50, { min: 0, max: 500 }),
      angle('angle', 'Angle', 0),
      bool('radial', 'Radial', true),
    ],
  },
  {
    type: 'vignette', name: 'Vignette', category: 'Stylize',
    description: 'Darken the edges of the frame.',
    params: [
      pct('amount', 'Amount', 50),
      pct('size', 'Size', 60),
      pct('softness', 'Softness', 55),
      slider('roundness', 'Roundness', 0, -100, 100, { min: -100, max: 100, precision: 0 }),
      color('color', 'Color', C(0, 0, 0)),
    ],
  },

  // ── Expression Controls ───────────────────────────────────────────────────
  {
    type: 'sliderControl', name: 'Slider Control', category: 'Expression Controls',
    description: 'A keyframeable number for driving expressions.',
    params: [slider('slider', 'Slider', 0, 0, 100, { min: -1e6, max: 1e6 })],
  },
  {
    type: 'angleControl', name: 'Angle Control', category: 'Expression Controls',
    description: 'A keyframeable angle for driving expressions.',
    params: [angle('angle', 'Angle', 0)],
  },
  {
    type: 'pointControl', name: 'Point Control', category: 'Expression Controls',
    description: 'A keyframeable 2D point for driving expressions.',
    params: [point('point', 'Point', center)],
  },
  {
    type: 'colorControl', name: 'Color Control', category: 'Expression Controls',
    description: 'A keyframeable color for driving expressions.',
    params: [color('color', 'Color', C(1, 0.62, 0.22))],
  },
  {
    type: 'checkboxControl', name: 'Checkbox Control', category: 'Expression Controls',
    description: 'A boolean switch for driving expressions.',
    params: [{ id: 'checkbox', name: 'Checkbox', kind: 'bool', default: false, animatable: true }],
  },

  // ── Transition ────────────────────────────────────────────────────────────
  {
    type: 'linearWipe', name: 'Linear Wipe', category: 'Transition',
    description: 'Wipe the layer away along an angle.',
    params: [pct('completion', 'Transition Completion', 0), angle('angle', 'Wipe Angle', 90), slider('feather', 'Feather', 0, 0, 200, { min: 0, max: 2000 })],
  },
  {
    type: 'radialWipe', name: 'Radial Wipe', category: 'Transition',
    description: 'Clock-style radial reveal.',
    params: [
      pct('completion', 'Transition Completion', 0),
      angle('startAngle', 'Start Angle', 0),
      point('center', 'Wipe Center', center),
      choice('direction', 'Wipe', [['cw', 'Clockwise'], ['ccw', 'Counterclockwise'], ['both', 'Both']], 'cw'),
      slider('feather', 'Feather', 0, 0, 100, { min: 0, max: 1000 }),
    ],
  },
];

export const EFFECT_MAP: Record<string, EffectDef> = Object.fromEntries(EFFECTS.map((e) => [e.type, e]));

export function getEffectDef(type: string): EffectDef | undefined {
  return EFFECT_MAP[type];
}

export function getParamDef(type: string, paramId: string): EffectParamDef | undefined {
  return EFFECT_MAP[type]?.params.find((p) => p.id === paramId);
}

export function resolveDefault(p: EffectParamDef, dims: LayerDims): PropValue {
  const d = typeof p.default === 'function' ? p.default(dims) : p.default;
  return structuredCloneSafe(d);
}

function structuredCloneSafe<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  return JSON.parse(JSON.stringify(v)) as T;
}
