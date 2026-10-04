// ─────────────────────────────────────────────────────────────────────────────
// The demo project: a 12-second title sequence that exercises most of the
// engine at once.
//
//   Showreel (1920×1080 · 30 fps)
//   ├─ Grade ............. adjustment layer: Curves, Vignette, Add Grain, RGB Split
//   ├─ Camera ............ two-node camera on an auto-Bézier spatial path, DOF
//   │                      with an expression-driven rack focus
//   ├─ Key / Rim / Fill .. spot, point and ambient lights
//   ├─ Spectrum .......... Audio Spectrum driven by the generated soundtrack
//   ├─ Feature Chips ..... precomp: parented shape + text layers, overshoot pops
//   ├─ Tagline / Title ... kinetic type: range, smooth and wiggly selectors,
//   │                      Gradient Ramp, Deep Glow, animated Light Rays
//   ├─ Logo Mark ......... precomp: the soft-serve swirl built from Bézier paths
//   ├─ Mandala ........... precomp: repeaters, trim paths, merge paths, zig zag,
//   │                      round corners, beat-synced expressions
//   ├─ Bokeh Near / Far .. 3D shape layers blurred by depth of field
//   ├─ Grid Floor ........ 3D solid with a scrolling Grid effect
//   ├─ Stars / Nebula .... Fractal Noise + Colorama + Hue/Saturation
//   └─ pooBeat.wav ....... procedurally synthesised music (see music.ts)
// ─────────────────────────────────────────────────────────────────────────────

import type {
  AnimProp, BezierPath, Composition, GradientStop, Keyframe, Layer, Project, PropValue, RangeSelector, RGBA, ShapeGroup, ShapeItem,
} from '../core/types';
import {
  createAdjustmentLayer, createCameraLayer, createComp, createEffect, createEllipse, createFill, createFootage, createFootageLayer,
  createGradientFill, createGradientStroke, createGroup, createLightLayer, createMask, createMerge, createPathItem, createPolystar,
  createPrecompLayer, createProject, createRect, createRepeater, createRoundCorners, createShapeLayer, createSolidLayer, createStroke,
  createTextAnimator, createTextLayer, createTrim, createWigglySelector, createZigZag, ellipsePath,
} from '../core/factory';
import { uid } from '../core/ids';
import { defaultEases, EASY_EASE_INFLUENCE, LINEAR_INFLUENCE } from '../anim/interpolate';
import { mulberry32 } from '../math/noise';
import { DEMO_MUSIC_DURATION, DEMO_MUSIC_KEY } from './music';

// ── keyframe helpers ────────────────────────────────────────────────────────

type Interp = 'linear' | 'bezier' | 'hold';

interface KeyOpts {
  /** influence for both sides (0..1) */
  inf?: number;
  inInf?: number;
  outInf?: number;
  type?: Interp;
  inType?: Interp;
  outType?: Interp;
}

function key(t: number, v: PropValue, spatial: boolean, o: KeyOpts = {}): Keyframe {
  const inType = o.inType ?? o.type ?? 'bezier';
  const outType = o.outType ?? o.type ?? 'bezier';
  const inInf = inType === 'linear' ? LINEAR_INFLUENCE : o.inInf ?? o.inf ?? EASY_EASE_INFLUENCE;
  const outInf = outType === 'linear' ? LINEAR_INFLUENCE : o.outInf ?? o.inf ?? EASY_EASE_INFLUENCE;
  const k: Keyframe = { id: uid('k'), t, v, inType, outType, easeIn: defaultEases(v, spatial, inInf), easeOut: defaultEases(v, spatial, outInf) };
  if (spatial) k.spatial = 'auto';
  return k;
}

type KeyDef<V> = [number, V] | [number, V, KeyOpts];

function anim<V extends PropValue>(p: AnimProp<V>, keys: KeyDef<V>[], spatial = false): void {
  p.keyframes = keys.map(([t, v, o]) => key(t, v, spatial, o)) as Keyframe<V>[];
}

function expr(p: AnimProp, code: string): void {
  p.expression = code;
  p.expressionEnabled = true;
}

/** scale 0 → overshoot → 100 */
function pop(p: AnimProp<number[]>, t: number, dims = 2, over = 112, dur = 0.42): void {
  const v = (s: number) => (dims === 3 ? [s, s, 100] : [s, s]);
  anim(p, [
    [t, v(0), { outInf: 0.3 }],
    [t + dur * 0.62, v(over), { inInf: 0.5, outInf: 0.45 }],
    [t + dur, v(100), { inInf: 0.7 }],
  ]);
}

const rgb = (r: number, g: number, b: number, a = 1): RGBA => [r, g, b, a];
const hex = (h: string, a = 1): RGBA => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255, a];

function path(v: number[][], i: number[][], o: number[][], closed = true): BezierPath {
  return { closed, v: v as BezierPath['v'], i: i as BezierPath['i'], o: o as BezierPath['o'] };
}

function group(name: string, contents: ShapeItem[], setup?: (g: ShapeGroup) => void): ShapeGroup {
  const g = createGroup(contents, name);
  setup?.(g);
  return g;
}

function named<T extends { name: string }>(item: T, name: string): T {
  item.name = name;
  return item;
}

function fx(layer: Layer, type: string, dims: { w: number; h: number }, setup: (p: Record<string, AnimProp>) => void, name?: string) {
  const e = createEffect(type, dims, layer.effects.map((x) => x.name));
  if (name) e.name = name;
  setup(e.params as Record<string, AnimProp>);
  layer.effects.push(e);
  return e;
}

/** beat pulse at 120 BPM once the drums enter at 2.0 s (1 → 0 every half second) */
const PULSE = 'var ph = (time * 2) % 1;\nvar pulse = time < 2 ? 0 : Math.pow(1 - ph, 4);';

const WARM: GradientStop[] = [
  { p: 0, c: hex('#ffd27a') },
  { p: 0.45, c: hex('#ff9b3f') },
  { p: 1, c: hex('#e2552c') },
];

// ── Logo Mark (the soft-serve swirl from the app icon, 14× scale) ────────────

function buildLogo(): Composition {
  const comp = createComp({ name: 'Logo Mark', width: 600, height: 600, duration: 12, bgColor: [0, 0, 0, 0] });
  const S = 14;
  const P = (x: number, y: number) => [(x - 16) * S, (y - 16) * S];
  const T = (x: number, y: number) => [x * S, y * S];
  const gfill = () => {
    const g = createGradientFill(WARM);
    g.start.value = [-175, -175];
    g.end.value = [175, 175];
    return g;
  };
  const tier = (name: string, x0: number, x1: number, y: number, up: number, down: number, t: number) => {
    const shape = createPathItem(path([P(x0, y), P(x1, y)], [T(0, down), T(0, -up)], [T(0, -up), T(0, down)]));
    const cy = (y - 16) * S;
    const g = group(name, [shape, gfill()], (gr) => {
      gr.transform.anchor.value = [0, cy];
      gr.transform.position.value = [0, cy];
      pop(gr.transform.scale, t, 2, 116, 0.46);
    });
    const l = createShapeLayer(comp, [g], name);
    l.label = 11;
    return l;
  };
  const tier1 = tier('Tier 1', 3.5, 28.5, 24.2, 3.6, 3.4, 0.45);
  const tier2 = tier('Tier 2', 6.6, 25.4, 18.6, 3.2, 3.0, 0.62);
  const tier3 = tier('Tier 3', 9.6, 22.4, 13.3, 2.7, 2.5, 0.79);

  const tipPath = path(
    [P(16.2, 4.2), P(17.8, 10.2), P(13.9, 8.8), P(16.2, 6.7)],
    [T(-0.2, 0.8), T(1.9, -2.2), T(0.3, 1.2), T(0.5, 1.3)],
    [T(2.6, 1.4), T(-1.9, 0.6), T(1.7, 0.2), T(-0.2, -0.8)],
  );
  const tip = createShapeLayer(comp, [
    group('Curl', [named(createPathItem(tipPath), 'Curl Path'), gfill()], (g) => {
      g.transform.anchor.value = [0, -85];
      g.transform.position.value = [0, -85];
      pop(g.transform.scale, 0.96, 2, 122, 0.5);
      anim(g.transform.rotation, [[0.96, -28, { outInf: 0.2 }], [1.46, 0, { inInf: 0.75 }]]);
    }),
  ], 'Curl');
  tip.label = 11;

  const shineLine = (name: string, a: number[], b: number[], o: number[], i: number[], t: number) => {
    const stroke = createStroke(rgb(1, 1, 1), 15);
    stroke.opacity.value = 72;
    const trim = createTrim();
    anim(trim.end, [[t, 0, { outInf: 0.1 }], [t + 0.5, 100, { inInf: 0.8 }]]);
    return group(name, [createPathItem(path([P(a[0], a[1]), P(b[0], b[1])], [[0, 0], T(i[0], i[1])], [T(o[0], o[1]), [0, 0]], false)), trim, stroke]);
  };
  const shine = createShapeLayer(comp, [
    shineLine('Shine 1', [7, 22.6], [23.5, 22.8], [4, -1.3], [-4.5, -1.5], 1.2),
    shineLine('Shine 2', [9.6, 17.2], [22.2, 17.4], [3.4, -1.1], [-3.2, -1.3], 1.3),
    shineLine('Shine 3', [12.2, 12.1], [19.8, 12.2], [2.2, -0.8], [-2, -0.9], 1.4),
  ], 'Shine');
  shine.label = 2;
  shine.blendMode = 'screen';

  const shadowFill = createFill(rgb(0, 0, 0));
  shadowFill.opacity.value = 45;
  const shadow = createShapeLayer(comp, [group('Shadow', [createEllipse([400, 44], [0, 0]), shadowFill], (g) => pop(g.transform.scale, 0.38, 2, 104, 0.5))], 'Contact Shadow');
  shadow.transform.position.value = [300, 300 + 10.4 * S, 0];
  shadow.label = 0;
  fx(shadow, 'gaussianBlur', { w: 600, h: 600 }, (p) => {
    p.blurriness.value = 16;
  });

  comp.layers = [shine, tip, tier3, tier2, tier1, shadow];
  return comp;
}

// ── Mandala (procedural shape operators) ────────────────────────────────────

function buildMandala(): Composition {
  const comp = createComp({ name: 'Mandala', width: 1080, height: 1080, duration: 12, bgColor: [0, 0, 0, 0] });
  const layers: Layer[] = [];
  const add = (name: string, label: number, items: ShapeItem[], setup?: (l: Layer) => void) => {
    const l = createShapeLayer(comp, items, name);
    l.label = label;
    setup?.(l);
    layers.push(l);
    return l;
  };

  // Core: radial glow that breathes with the kick drum
  const coreFill = createGradientFill([
    { p: 0, c: rgb(1, 1, 1) },
    { p: 0.35, c: rgb(1, 0.87, 0.58) },
    { p: 1, c: rgb(1, 0.42, 0.3, 0) },
  ]);
  coreFill.gradientType = 'radial';
  coreFill.start.value = [0, 0];
  coreFill.end.value = [92, 0];
  add('Core', 6, [group('Core', [createEllipse([184, 184]), coreFill])], (l) => {
    pop(l.transform.scale, 0.3, 3, 120, 0.8);
    expr(l.transform.scale, `${PULSE}\nvar k = 1 + pulse * 0.22;\n[value[0] * k, value[1] * k, value[2]]`);
  });

  // Inner petals
  const innerFill = createFill(rgb(1, 0.74, 0.5));
  innerFill.opacity.value = 58;
  const innerRep = createRepeater(16);
  innerRep.transform.position.value = [0, 0];
  innerRep.transform.rotation.value = 22.5;
  add('Inner Petals', 4, [
    group('Inner Petals', [createEllipse([54, 168], [0, -150]), innerFill, innerRep], (g) => {
      pop(g.transform.scale, 1.15, 2, 110, 0.7);
      expr(g.transform.rotation, 'time * -16');
    }),
  ]);

  // Petals: gradient-filled ellipses in a 12-way repeater
  const petalFill = createGradientFill([
    { p: 0, c: rgb(1, 0.78, 0.42) },
    { p: 0.5, c: rgb(0.96, 0.4, 0.38) },
    { p: 1, c: rgb(0.62, 0.16, 0.52) },
  ]);
  petalFill.start.value = [0, -385];
  petalFill.end.value = [0, -90];
  petalFill.opacity.value = 86;
  const petalRep = createRepeater(12);
  petalRep.transform.position.value = [0, 0];
  petalRep.transform.rotation.value = 30;
  petalRep.transform.endOpacity.value = 70;
  add('Petals', 1, [
    group('Petals', [createEllipse([96, 292], [0, -236]), petalFill, petalRep], (g) => {
      pop(g.transform.scale, 0.9, 2, 108, 0.8);
      expr(g.transform.rotation, 'time * 9');
    }),
  ]);

  // Orbiting dots with an opacity falloff
  const dotRep = createRepeater(36);
  dotRep.transform.position.value = [0, 0];
  dotRep.transform.rotation.value = 10;
  dotRep.transform.endOpacity.value = 12;
  add('Orbit Dots', 2, [group('Orbit Dots', [createEllipse([16, 16], [0, -500]), createFill(rgb(1, 0.94, 0.8)), dotRep], (g) => expr(g.transform.rotation, 'time * 24'))], (l) => {
    anim(l.transform.opacity, [[1, 0], [2, 100]]);
  });

  // Dotted ring that draws on with Trim Paths
  const dash = createStroke(rgb(1, 1, 1), 5);
  dash.dashes.enabled = true;
  dash.dashes.dash.value = 0.5;
  dash.dashes.gap.value = 22;
  dash.opacity.value = 55;
  const dashTrim = createTrim();
  anim(dashTrim.end, [[0.2, 0, { outInf: 0.15 }], [1.6, 100, { inInf: 0.8 }]]);
  add('Dash Ring', 3, [group('Dash Ring', [createEllipse([800, 800]), dashTrim, dash], (g) => expr(g.transform.rotation, 'time * -12'))]);

  // Spinning gradient arc
  const arc = createGradientStroke([{ p: 0, c: rgb(1, 0.82, 0.42) }, { p: 1, c: rgb(1, 0.34, 0.62) }], 9);
  arc.start.value = [-460, 0];
  arc.end.value = [460, 0];
  const arcTrim = createTrim();
  anim(arcTrim.end, [[0.5, 0, { outInf: 0.1 }], [2.2, 78, { inInf: 0.85 }]]);
  expr(arcTrim.offset, 'time * 50');
  add('Outer Ring', 13, [group('Outer Ring', [createEllipse([920, 920]), arcTrim, arc])]);

  // Starburst: star + round corners + trim, repeated three times inward
  const starStroke = createStroke(rgb(1, 0.78, 0.5), 2.5);
  starStroke.opacity.value = 70;
  const starTrim = createTrim();
  anim(starTrim.end, [[0.8, 0, { outInf: 0.1 }], [2.4, 100, { inInf: 0.8 }]]);
  const round = createRoundCorners();
  round.radius.value = 16;
  const starRep = createRepeater(3);
  starRep.transform.position.value = [0, 0];
  starRep.transform.scale.value = [84, 84];
  starRep.transform.rotation.value = 15;
  starRep.transform.endOpacity.value = 40;
  add('Star Burst', 11, [group('Star Burst', [createPolystar('star', 12, 440, 362), round, starTrim, starStroke, starRep], (g) => expr(g.transform.rotation, 'time * -6'))]);

  // Wavy ring: Zig Zag with smooth points, ridge size pumping on the beat
  const zig = createZigZag();
  zig.ridges.value = 30;
  zig.pointType = 'smooth';
  zig.size.value = 14;
  expr(zig.size, `${PULSE}\n14 + pulse * 12`);
  const waveStroke = createStroke(rgb(0.55, 0.78, 1), 3);
  waveStroke.opacity.value = 80;
  const waveTrim = createTrim();
  anim(waveTrim.end, [[1, 0, { outInf: 0.1 }], [2.4, 100, { inInf: 0.8 }]]);
  add('Wave Ring', 14, [group('Wave Ring', [createEllipse([640, 640]), zig, waveTrim, waveStroke], (g) => expr(g.transform.rotation, 'time * 10'))]);

  // Hex frame: two polygons, rounded, merged with Subtract into a ring
  const hexFill = createGradientFill([{ p: 0, c: rgb(0.58, 0.4, 1) }, { p: 1, c: rgb(0.25, 0.78, 1) }]);
  hexFill.start.value = [-340, -340];
  hexFill.end.value = [340, 340];
  hexFill.opacity.value = 82;
  const hexRound = createRoundCorners();
  hexRound.radius.value = 14;
  const merge = createMerge();
  merge.mode = 'subtract';
  add('Hex Frame', 10, [
    group('Hex Frame', [named(createPolystar('polygon', 6, 340, 0), 'Hex Outer'), named(createPolystar('polygon', 6, 312, 0), 'Hex Inner'), hexRound, merge, hexFill], (g) => {
      pop(g.transform.scale, 0.6, 2, 106, 0.8);
      expr(g.transform.rotation, 'time * 4');
    }),
  ]);

  comp.layers = layers;
  return comp;
}

// ── Feature chips (parenting + staggered pops) ──────────────────────────────

function buildChips(): Composition {
  const comp = createComp({ name: 'Feature Chips', width: 1920, height: 220, duration: 12, bgColor: [0, 0, 0, 0] });
  const labels = ['GPU EFFECTS STACK', '3D CAMERAS & LIGHTS', 'WEBCODECS EXPORT'];
  const layers: Layer[] = [];
  labels.forEach((label, i) => {
    const t = 7.3 + i * 0.16;
    const fill = createFill(rgb(0.07, 0.04, 0.11));
    fill.opacity.value = 62;
    const edge = createGradientStroke([{ p: 0, c: rgb(1, 0.76, 0.42) }, { p: 1, c: rgb(1, 0.38, 0.6) }], 2);
    edge.start.value = [-220, 0];
    edge.end.value = [220, 0];
    edge.opacity.value = 85;
    const dot = group('Dot', [createEllipse([12, 12], [-186, 0]), createFill(rgb(1, 0.62, 0.25))]);
    const chip = createShapeLayer(comp, [group('Pill', [createRect([440, 78], [0, 0], 39), fill, edge]), dot], `Chip ${i + 1}`);
    chip.label = 11;
    chip.transform.position.value = [480 + i * 480, 110, 0];
    pop(chip.transform.scale, t, 3, 108, 0.42);
    anim(chip.transform.opacity, [[t, 0], [t + 0.15, 100], [10.55 + i * 0.06, 100], [10.95 + i * 0.06, 0]]);
    const text = createTextLayer(comp, label, { font: 'Inter', weight: 650, size: 26, tracking: 140, fill: rgb(0.95, 0.95, 1) });
    text.name = `Label ${i + 1}`;
    text.label = 2;
    text.parentId = chip.id;
    text.transform.position.value = [12, 9, 0];
    anim(text.transform.opacity, [[t + 0.1, 0], [t + 0.32, 100], [10.55 + i * 0.06, 100], [10.95 + i * 0.06, 0]]);
    layers.push(text, chip);
  });
  comp.layers = layers;
  return comp;
}

// ── Showreel (main comp) ────────────────────────────────────────────────────

export interface DemoBuild {
  project: Project;
  mainCompId: string;
  initialTime: number;
}

export function buildDemoProject(): DemoBuild {
  const project = createProject('pooEffects Demo');
  const W = 1920, H = 1080;
  const dims = { w: W, h: H };
  const main = createComp({ name: 'Showreel', width: W, height: H, duration: 12, frameRate: 30, bgColor: [0.012, 0.012, 0.02, 1] });
  main.motionBlurSamples = 10;
  main.markers = [
    { id: uid('mk'), time: 0, duration: 0, comment: 'Ignition', label: 6 },
    { id: uid('mk'), time: 2, duration: 0, comment: 'Impact', label: 1 },
    { id: uid('mk'), time: 7.3, duration: 0, comment: 'Features', label: 8 },
    { id: uid('mk'), time: 10, duration: 0, comment: 'Outro', label: 10 },
  ];
  const logo = buildLogo();
  const mandala = buildMandala();
  const chips = buildChips();
  // insertion order = Project panel order; the main comp first so it opens by default
  project.comps[main.id] = main;
  project.comps[mandala.id] = mandala;
  project.comps[logo.id] = logo;
  project.comps[chips.id] = chips;
  const precompFolder = uid('fd');
  project.folders[precompFolder] = { id: precompFolder, name: 'Precomps', folderId: null };
  for (const c of [mandala, logo, chips]) c.folderId = precompFolder;

  // ── soundtrack ──
  const music = createFootage({
    name: 'pooBeat (generated).wav', kind: 'audio', mime: 'audio/wav', duration: DEMO_MUSIC_DURATION, frameRate: 30,
    hasAudio: true, hasVideo: false, bytes: 48000 * 2 * 2 * DEMO_MUSIC_DURATION + 44, procedural: DEMO_MUSIC_KEY,
  });
  project.footage[music.id] = music;
  const musicLayer = createFootageLayer(main, music);
  musicLayer.label = 7;

  // ── Grade ──
  const grade = createAdjustmentLayer(main);
  grade.name = 'Grade';
  fx(grade, 'curves', dims, (p) => {
    p.curves.value = {
      rgb: [[0, 0.025], [0.25, 0.2], [0.75, 0.83], [1, 1]],
      r: [[0, 0], [1, 1]],
      g: [[0, 0], [1, 1]],
      b: [[0, 0.03], [0.5, 0.5], [1, 0.97]],
      a: [[0, 0], [1, 1]],
    };
  });
  fx(grade, 'chromaticAberration', dims, (p) => {
    anim(p.amount as AnimProp<number>, [
      [0, 1.5], [1.93, 1.5, { outType: 'linear' }], [2, 18, { inType: 'linear', outInf: 0.6 }], [2.45, 1.5, { inInf: 0.8 }],
      [7.2, 1.5, { outType: 'linear' }], [7.3, 10, { inType: 'linear', outInf: 0.5 }], [7.55, 1.5],
    ]);
  });
  fx(grade, 'vignette', dims, (p) => {
    p.amount.value = 58;
    p.size.value = 64;
    p.softness.value = 62;
  });
  fx(grade, 'noise', dims, (p) => {
    p.amount.value = 6;
    p.size.value = 1.2;
  });

  // ── camera & lights ──
  const cam = createCameraLayer(main, 32, 'Camera');
  const camData = cam.camera!;
  camData.pointOfInterest.value = [960, 540, 0];
  camData.depthOfField = true;
  camData.aperture.value = 34;
  camData.blurLevel.value = 100;
  anim(cam.transform.position, [
    [0, [960, 540, -3500], { outInf: 0.1 }],
    [2, [960, 566, -2150], { inInf: 0.85, outInf: 0.3 }],
    [6, [1480, 420, -1950]],
    [10, [500, 650, -2000]],
    [12, [960, 540, -2280], { inInf: 0.5 }],
  ], true);
  expr(camData.focusDistance, [
    '// rack focus: track the title, then pull to the mandala for the outro',
    'var p = transform.position;',
    'var a = length(p, thisComp.layer("pooEffects").transform.position);',
    'var b = length(p, thisComp.layer("Mandala").transform.position);',
    'ease(time, 8.8, 10.2, a, b)',
  ].join('\n'));

  const key = createLightLayer(main, 'spot', 'Key Light');
  key.transform.position.value = [520, 160, -1100];
  key.light!.pointOfInterest.value = [960, 540, 0];
  key.light!.color.value = rgb(1, 0.86, 0.7);
  key.light!.intensity.value = 105;
  key.light!.coneAngle.value = 110;
  key.light!.coneFeather.value = 70;
  const rim = createLightLayer(main, 'point', 'Rim Light');
  rim.transform.position.value = [1650, 860, 600];
  rim.light!.color.value = rgb(1, 0.36, 0.72);
  rim.light!.intensity.value = 75;
  const fill = createLightLayer(main, 'ambient', 'Fill Light');
  fill.light!.intensity.value = 30;
  fill.light!.color.value = rgb(0.55, 0.65, 1);

  // ── spectrum ──
  const spectrum = createSolidLayer(main, rgb(0, 0, 0), 'Spectrum');
  spectrum.label = 9;
  spectrum.blendMode = 'screen';
  fx(spectrum, 'audioSpectrum', dims, (p) => {
    p.audioLayer.value = musicLayer.id;
    p.start.value = [300, 1022];
    p.end.value = [1620, 1022];
    p.startFreq.value = 30;
    p.endFreq.value = 5200;
    p.bands.value = 72;
    p.maxHeight.value = 120;
    p.duration.value = 110;
    p.thickness.value = 9;
    p.softness.value = 45;
    p.inside.value = rgb(1, 0.93, 0.78);
    p.outside.value = rgb(1, 0.44, 0.4);
    p.side.value = 'a';
    p.composite.value = false;
  });
  anim(spectrum.transform.opacity, [[1.95, 0], [2.3, 92]]);

  // ── feature chips ──
  const chipsLayer = createPrecompLayer(main, chips);
  chipsLayer.transform.position.value = [960, 872, 0];
  chipsLayer.label = 15;

  // ── tagline ──
  const tagline = createTextLayer(main, 'MOTION GRAPHICS  ·  VFX  ·  COMPOSITING', {
    font: 'Space Grotesk', weight: 400, size: 36, tracking: 420, fill: rgb(0.86, 0.88, 0.96),
  });
  tagline.name = 'Tagline';
  tagline.label = 2;
  tagline.threeD = true;
  tagline.material.acceptsLights = false;
  tagline.transform.position.value = [960, 748, -300];
  fx(tagline, 'dropShadow', dims, (p) => {
    p.opacity.value = 90;
    p.distance.value = 0;
    p.softness.value = 22;
    p.color.value = rgb(0.04, 0.01, 0.06);
  });
  const tagTrack = createTextAnimator(['tracking', 'opacity'], 1);
  tagTrack.name = 'Tracking In';
  anim(tagTrack.props.tracking!, [[2.55, 900, { outInf: 0.1 }], [4.3, 0, { inInf: 0.9 }]]);
  anim(tagTrack.props.opacity!, [[2.55, 0], [3.3, 100]]);
  tagline.text!.animators.push(tagTrack);

  // ── title ──
  const title = createTextLayer(main, 'pooEffects', { font: 'Montserrat', weight: 800, size: 236, tracking: -10, fill: rgb(1, 1, 1) });
  title.name = 'pooEffects';
  title.label = 1;
  title.threeD = true;
  title.motionBlur = true;
  title.material.acceptsLights = false;
  title.transform.position.value = [960, 652, -300];
  anim(title.transform.scale, [
    [2, [116, 116, 100], { outInf: 0.9 }],
    [3.3, [100, 100, 100], { inInf: 0.9, outType: 'linear' }],
    [12, [105, 105, 100], { inType: 'linear' }],
  ]);
  const reveal = createTextAnimator(['position', 'scale', 'opacity', 'blur', 'rotation'], 1);
  reveal.name = 'Reveal';
  reveal.props.position!.value = [0, 170, 0];
  reveal.props.scale!.value = [55, 55];
  reveal.props.opacity!.value = 0;
  reveal.props.blur!.value = [26, 26];
  reveal.props.rotation!.value = -12;
  const rs = reveal.selectors[0] as RangeSelector;
  rs.shape = 'rampUp';
  rs.end.value = 34;
  anim(rs.offset, [[2, -34, { outInf: 0.05 }], [3.25, 100, { inInf: 0.75 }]]);
  const shimmer = createTextAnimator(['fillColor', 'scale'], 2);
  shimmer.name = 'Shimmer';
  shimmer.props.fillColor!.value = rgb(1, 1, 0.92);
  shimmer.props.scale!.value = [106, 106];
  const ss = shimmer.selectors[0] as RangeSelector;
  ss.shape = 'smooth';
  ss.end.value = 24;
  expr(ss.offset, '// a highlight sweeping across every 3.75 s once the title has landed\ntime < 3.2 ? -30 : ((time - 3.2) * 40) % 150 - 26');
  const float = createTextAnimator(['position', 'rotation'], 3);
  float.name = 'Float';
  float.props.position!.value = [0, 16, 0];
  float.props.rotation!.value = 3;
  float.selectors = [createWigglySelector()];
  float.selectors[0].name = 'Wiggly Selector 1';
  const wig = float.selectors[0];
  if (wig.type === 'wiggly') {
    wig.mode = 'add';
    wig.wigglesPerSecond.value = 0.7;
    wig.correlation.value = 65;
  }
  title.text!.animators.push(reveal, shimmer, float);
  fx(title, 'gradientRamp', dims, (p) => {
    p.start.value = [-620, -190];
    p.startColor.value = rgb(1, 0.87, 0.58);
    p.end.value = [620, 30];
    p.endColor.value = rgb(1, 0.38, 0.56);
  });
  fx(title, 'dropShadow', dims, (p) => {
    p.opacity.value = 70;
    p.distance.value = 8;
    p.softness.value = 46;
    p.color.value = rgb(0.06, 0.0, 0.08);
  });
  fx(title, 'glow', dims, (p) => {
    p.threshold.value = 62;
    p.radius.value = 70;
    p.intensity.value = 0.85;
    p.tint.value = rgb(1, 0.5, 0.3);
    p.tintAmount.value = 55;
  });
  fx(title, 'lightRays', dims, (p) => {
    anim(p.center as AnimProp<number[]>, [[2.1, [-520, -140], { type: 'linear' }], [6.6, [520, -140], { type: 'linear' }]], true);
    p.intensity.value = 0.42;
    p.length.value = 26;
    p.threshold.value = 58;
    p.color.value = rgb(1, 0.72, 0.5);
  });

  // ── logo mark ──
  const logoLayer = createPrecompLayer(main, logo);
  logoLayer.label = 11;
  logoLayer.threeD = true;
  logoLayer.motionBlur = true;
  logoLayer.material.acceptsLights = false;
  anim(logoLayer.transform.position, [
    [0, [960, 560, -320]],
    [1.9, [960, 560, -320], { outInf: 0.7 }],
    [2.75, [960, 296, -320], { inInf: 0.85 }],
  ], true);
  anim(logoLayer.transform.scale, [[1.9, [100, 100, 100], { outInf: 0.7 }], [2.75, [52, 52, 100], { inInf: 0.85 }]]);
  fx(logoLayer, 'glow', { w: 600, h: 600 }, (p) => {
    p.threshold.value = 60;
    p.radius.value = 60;
    p.intensity.value = 0.8;
    p.tintAmount.value = 40;
  });

  // ── mandala ──
  const mandalaLayer = createPrecompLayer(main, mandala);
  mandalaLayer.label = 13;
  mandalaLayer.threeD = true;
  mandalaLayer.motionBlur = true;
  mandalaLayer.transform.position.value = [960, 520, 620];
  anim(mandalaLayer.transform.scale, [[0, [96, 96, 100], { outInf: 0.2 }], [2.6, [146, 146, 100], { inInf: 0.8 }]]);
  anim(mandalaLayer.transform.rotationY, [[2, -22, { type: 'linear' }], [12, 18, { type: 'linear' }]]);
  expr(mandalaLayer.transform.rotation, 'time * 3');
  anim(mandalaLayer.transform.opacity, [[0, 0], [1, 78]]);
  fx(mandalaLayer, 'glow', { w: 1080, h: 1080 }, (p) => {
    p.threshold.value = 64;
    p.radius.value = 70;
    p.intensity.value = 0.8;
    p.tint.value = rgb(1, 0.42, 0.62);
    p.tintAmount.value = 50;
  });

  // ── bokeh: random discs far from the focal plane ──
  const bokeh = (name: string, seed: number, count: number, spreadX: number, spreadY: number, rMin: number, rMax: number, color: RGBA, z: number, wiggle: string) => {
    const rand = mulberry32(seed);
    const items: ShapeItem[] = [];
    for (let i = 0; i < count; i++) {
      const d = rMin + rand() * (rMax - rMin);
      const f = createFill(color);
      f.opacity.value = 35 + rand() * 55;
      items.push(group(`Disc ${i + 1}`, [createEllipse([d, d], [(rand() * 2 - 1) * spreadX, (rand() * 2 - 1) * spreadY]), f]));
    }
    const l = createShapeLayer(main, items, name);
    l.threeD = true;
    l.material.acceptsLights = false;
    l.blendMode = 'add';
    l.label = 5;
    l.transform.position.value = [960, 540, z];
    expr(l.transform.position, wiggle);
    anim(l.transform.opacity, [[0.4, 0], [2, 100]]);
    return l;
  };
  const bokehNear = bokeh('Bokeh Near', 7, 14, 1300, 760, 40, 150, rgb(1, 0.72, 0.45), -1150, 'wiggle(0.25, 60)');
  const bokehFar = bokeh('Bokeh Far', 99, 40, 2600, 1500, 14, 42, rgb(0.55, 0.72, 1), 1900, 'wiggle(0.15, 90)');

  // ── grid floor ──
  const floor = createSolidLayer(main, rgb(0, 0, 0), 'Grid Floor', 4400, 4400);
  floor.label = 14;
  floor.threeD = true;
  floor.material.acceptsLights = false;
  floor.blendMode = 'add';
  floor.transform.orientation.value = [90, 0, 0];
  floor.transform.position.value = [960, 1030, 1000];
  floor.masks.push({ ...createMask(ellipsePath(2200, 2200, 2050, 2050)), name: 'Horizon Fade', feather: { value: [760, 760], keyframes: [] } });
  fx(floor, 'grid', { w: 4400, h: 4400 }, (p) => {
    p.cellW.value = 180;
    p.cellH.value = 180;
    p.border.value = 5;
    p.feather.value = 1;
    p.color.value = rgb(1, 0.42, 0.66);
    p.blend.value = 'none';
    expr(p.anchor, '// scroll the floor towards the camera\n[value[0], value[1] - time * 180]');
  });
  anim(floor.transform.opacity, [[1.6, 0], [2.4, 70]]);

  // ── stars & nebula ──
  const stars = createSolidLayer(main, rgb(0, 0, 0), 'Stars');
  stars.label = 8;
  stars.blendMode = 'screen';
  stars.transform.opacity.value = 75;
  fx(stars, 'fractalNoise', dims, (p) => {
    p.contrast.value = 760;
    p.brightness.value = -330;
    p.scale.value = 6;
    p.complexity.value = 1;
    anim(p.evolution as AnimProp<number>, [[0, 0, { type: 'linear' }], [12, 160, { type: 'linear' }]]);
  });

  const nebula = createSolidLayer(main, rgb(0, 0, 0), 'Nebula');
  nebula.label = 10;
  fx(nebula, 'fractalNoise', dims, (p) => {
    p.fractalType.value = 'turbulentSmooth';
    p.contrast.value = 135;
    p.brightness.value = -12;
    p.scale.value = 520;
    p.complexity.value = 7;
    p.subInfluence.value = 65;
    anim(p.evolution as AnimProp<number>, [[0, 0, { type: 'linear' }], [12, 540, { type: 'linear' }]]);
    anim(p.offset as AnimProp<number[]>, [[0, [960, 540], { type: 'linear' }], [12, [1260, 470], { type: 'linear' }]], true);
  });
  fx(nebula, 'colorama', dims, (p) => {
    p.palette.value = [
      { p: 0, c: rgb(0.01, 0.006, 0.03) },
      { p: 0.32, c: rgb(0.12, 0.03, 0.24) },
      { p: 0.56, c: rgb(0.52, 0.08, 0.42) },
      { p: 0.8, c: rgb(1, 0.42, 0.28) },
      { p: 1, c: rgb(1, 0.86, 0.56) },
    ];
  });
  fx(nebula, 'hueSaturation', dims, (p) => {
    anim(p.hue as AnimProp<number>, [[0, -10, { type: 'linear' }], [12, 22, { type: 'linear' }]]);
  });
  anim(nebula.transform.opacity, [[0, 0], [1.2, 100]]);

  main.layers = [
    grade, cam, key, rim, fill, spectrum, chipsLayer, tagline, title, logoLayer, mandalaLayer, bokehNear, bokehFar, floor, stars, nebula, musicLayer,
  ];
  return { project, mainCompId: main.id, initialTime: 4 };
}
