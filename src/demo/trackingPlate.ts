// ─────────────────────────────────────────────────────────────────────────────
// Tracking demo: a synthetic "handheld" plate for the computer-vision tools.
//
//   Tracking Demo (1280×720 · 30 fps · 6 s)
//   ├─ Insert Card ....... 640×360 precomp to corner-pin onto the billboard
//   └─ Street Plate ...... precomp, treated as 2D footage by the trackers
//        ├─ Camera ....... two-node camera trucking right with a deterministic
//        │                 handheld wiggle (parallax + shake for stabilizing)
//        ├─ Billboard .... angled planar card — perspective corner pin target
//        ├─ Pillars ...... upright textured slabs at several depths (parallax)
//        ├─ Back Wall .... grid + turbulent noise
//        └─ Ground ....... horizontal textured floor (ground-plane demo)
// Every surface carries high-frequency texture (turbulent noise + grid lines)
// so FAST / Shi–Tomasi find plenty of trackable corners.
// ─────────────────────────────────────────────────────────────────────────────

import type { AnimProp, Composition, Keyframe, Layer, PropValue, RGBA } from '../core/types';
import { createCameraLayer, createComp, createEffect, createPrecompLayer, createSolidLayer, createTextLayer } from '../core/factory';
import { uid } from '../core/ids';
import { defaultEases, LINEAR_INFLUENCE } from '../anim/interpolate';

function fx(layer: Layer, type: string, dims: { w: number; h: number }, setup: (p: Record<string, AnimProp>) => void): void {
  const e = createEffect(type, dims, layer.effects.map((x) => x.name));
  setup(e.params as Record<string, AnimProp>);
  layer.effects.push(e);
}

function linearKeys<V extends PropValue>(p: AnimProp<V>, keys: [number, V][], spatial: boolean): void {
  p.keyframes = keys.map(([t, v]) => {
    const k: Keyframe = { id: uid('k'), t, v, inType: 'bezier', outType: 'bezier', easeIn: defaultEases(v, spatial, 0.33), easeOut: defaultEases(v, spatial, 0.33) };
    if (spatial) k.spatial = 'auto';
    return k;
  }) as Keyframe<V>[];
  // the first and last keys ease in/out; interior keys stay smooth
  const first = p.keyframes[0], last = p.keyframes[p.keyframes.length - 1];
  if (first) first.easeIn = defaultEases(first.v, spatial, LINEAR_INFLUENCE);
  if (last) last.easeOut = defaultEases(last.v, spatial, LINEAR_INFLUENCE);
}

/** Corner-rich texture: turbulent noise, tint and a grid overlay. */
function texture(l: Layer, w: number, h: number, o: { scale: number; cell: number; dark: RGBA; light: RGBA; seed: number; gridOpacity?: number }): void {
  const dims = { w, h };
  fx(l, 'fractalNoise', dims, (p) => {
    p.fractalType.value = 'turbulentSharp';
    p.contrast.value = 210;
    p.brightness.value = -8;
    p.scale.value = o.scale;
    p.complexity.value = 5;
    if (p.offset) p.offset.value = [o.seed * 137.1, o.seed * 71.3];
  });
  fx(l, 'tint', dims, (p) => {
    p.black.value = o.dark;
    p.white.value = o.light;
  });
  fx(l, 'grid', dims, (p) => {
    p.cellW.value = o.cell;
    p.cellH.value = o.cell;
    p.border.value = Math.max(2, o.cell / 26);
    p.color.value = [1, 1, 1, 1];
    p.opacity.value = o.gridOpacity ?? 55;
  });
}

export function buildTrackingDemo(): { plate: Composition; demo: Composition; card: Composition } {
  const W = 1280, H = 720;
  const plate = createComp({ name: 'Street Plate', width: W, height: H, duration: 6, frameRate: 30, bgColor: [0.05, 0.055, 0.07, 1] });
  const layers: Layer[] = [];

  const cam = createCameraLayer(plate, 30, 'Camera');
  cam.camera!.pointOfInterest.value = [640, 400, 900];
  linearKeys(cam.transform.position, [[0, [260, 250, -820]], [3, [640, 215, -900]], [6, [1040, 250, -760]]], true);
  linearKeys(cam.camera!.pointOfInterest, [[0, [560, 420, 900]], [6, [760, 400, 900]]], true);
  // deterministic handheld shake on top of the dolly move
  cam.transform.position.expression = 'var a = wiggle(2.2, 9);\nvar b = wiggle(1.7, 7);\n[a[0], b[1], value[2]]';
  cam.transform.position.expressionEnabled = true;
  layers.push(cam);

  const billboard = createSolidLayer(plate, [1, 1, 1, 1], 'Billboard', 520, 300);
  billboard.threeD = true;
  billboard.transform.position.value = [330, 330, 380];
  billboard.transform.orientation.value = [0, 34, 0];
  texture(billboard, 520, 300, { scale: 26, cell: 52, dark: [0.08, 0.04, 0.12, 1], light: [1, 0.62, 0.3, 1], seed: 3, gridOpacity: 70 });
  layers.push(billboard);

  const pillarDefs: [number, number, string, RGBA][] = [
    [780, 260, 'Pillar A', [0.3, 0.75, 1, 1]], [1010, 620, 'Pillar B', [0.6, 1, 0.55, 1]], [560, 980, 'Pillar C', [1, 0.45, 0.7, 1]], [1260, 1180, 'Pillar D', [1, 0.85, 0.35, 1]],
  ];
  pillarDefs.forEach(([x, z, name, col], i) => {
    const p = createSolidLayer(plate, [1, 1, 1, 1], name, 150, 560);
    p.threeD = true;
    p.transform.position.value = [x, 330, z];
    p.transform.orientation.value = [0, -8 + i * 6, 0];
    texture(p, 150, 560, { scale: 18, cell: 38, dark: [0.03, 0.03, 0.05, 1], light: col, seed: 10 + i });
    layers.push(p);
  });

  const wall = createSolidLayer(plate, [1, 1, 1, 1], 'Back Wall', 4400, 1700);
  wall.threeD = true;
  wall.transform.position.value = [640, 60, 1700];
  texture(wall, 4400, 1700, { scale: 40, cell: 110, dark: [0.04, 0.05, 0.09, 1], light: [0.55, 0.62, 0.86, 1], seed: 21 });
  layers.push(wall);

  const ground = createSolidLayer(plate, [1, 1, 1, 1], 'Ground', 4400, 2800);
  ground.threeD = true;
  ground.transform.orientation.value = [90, 0, 0];
  ground.transform.position.value = [640, 610, 500];
  texture(ground, 4400, 2800, { scale: 34, cell: 120, dark: [0.06, 0.05, 0.05, 1], light: [0.85, 0.78, 0.68, 1], seed: 33, gridOpacity: 45 });
  layers.push(ground);

  plate.layers = layers;

  const demo = createComp({ name: 'Tracking Demo', width: W, height: H, duration: 6, frameRate: 30, bgColor: [0, 0, 0, 1] });
  const plateLayer = createPrecompLayer(demo, plate);
  plateLayer.name = 'Street Plate (handheld)';
  plateLayer.label = 9;
  // a card with well-defined bounds (a precomp's source rect is its frame — ideal for Corner Pin)
  const card = createComp({ name: 'Insert Card', width: 640, height: 360, duration: 6, frameRate: 30, bgColor: [0, 0, 0, 1] });
  const cardBg = createSolidLayer(card, [1, 1, 1, 1], 'Card Gradient', 640, 360);
  fx(cardBg, 'gradientRamp', { w: 640, h: 360 }, (p) => {
    p.start.value = [0, 0];
    p.end.value = [640, 360];
    p.startColor.value = [1, 0.62, 0.22, 1];
    p.endColor.value = [0.93, 0.2, 0.52, 1];
  });
  const cardTitle = createTextLayer(card, 'pooEffects', { size: 96, fill: [1, 1, 1, 1], justify: 'center', font: 'Inter', weight: 800 });
  cardTitle.transform.position.value = [320, 200, 0];
  const cardSub = createTextLayer(card, 'CORNER PINNED', { size: 30, fill: [1, 1, 1, 0.9], justify: 'center', tracking: 300 });
  cardSub.transform.position.value = [320, 262, 0];
  card.layers = [cardTitle, cardSub, cardBg];
  const insert = createPrecompLayer(demo, card);
  insert.name = 'Insert Card';
  insert.transform.position.value = [1100, 110, 0];
  insert.transform.scale.value = [40, 40, 100];
  insert.label = 2;
  demo.layers = [insert, plateLayer];
  return { plate, demo, card };
}
