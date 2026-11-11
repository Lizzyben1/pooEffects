// Randomised (seeded, reproducible) editing sessions.
// After every action the document must satisfy its invariants, evaluate without throwing, and the
// render worker's patch-synced copy must equal it. Undoing the whole session must restore the first
// document exactly; redoing it must restore the last.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAdjustmentLayer, createCameraLayer, createComp, createFill, createGroup, createLightLayer, createNullLayer, createPrecompLayer,
  createProject, createRect, createShapeItem, createShapeLayer, createSolidLayer, createStroke, createTextLayer, rectPath,
} from '../src/core/factory';
import type { AnimProp, Composition, Layer, Project } from '../src/core/types';
import { beginTx, cancelTx, endTx, getApp, keyOf, loadProject, redo, setApp, undo } from '../src/state/store';
import * as A from '../src/state/actions';
import { setTime } from '../src/state/time';
import { FrameEval } from '../src/core/evaluate';
import { forEachAnimProp, getProp } from '../src/core/props';
import { applyPatches, diffTree } from '../src/core/sync';
import { buildRows } from '../src/ui/timeline/rows';
import { EFFECTS } from '../src/effects/catalog';

function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    f: next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(a: readonly T[]): T => a[Math.floor(next() * a.length)],
    chance: (p: number) => next() < p,
  };
}

/** Structural invariants every document must satisfy, whatever sequence of edits produced it. */
function invariants(p: Project, label: string): void {
  const fail = (m: string) => assert.fail(`${label}: ${m}`);
  for (const c of Object.values(p.comps)) {
    if (!(c.duration > 0)) fail(`comp ${c.name} duration ${c.duration}`);
    if (!(c.workArea[0] >= -1e-9 && c.workArea[1] <= c.duration + 1e-9 && c.workArea[0] < c.workArea[1])) fail(`work area ${c.workArea} of ${c.duration}`);
    const ids = new Set<string>();
    for (const l of c.layers) {
      if (ids.has(l.id)) fail(`duplicate layer id ${l.id}`);
      ids.add(l.id);
    }
    for (const l of c.layers) {
      if (l.parentId && !ids.has(l.parentId)) fail(`${l.name}: dangling parent`);
      if (l.parentId === l.id) fail(`${l.name}: its own parent`);
      if (l.trackMatte && !ids.has(l.trackMatte.layerId)) fail(`${l.name}: dangling track matte`);
      if (l.source?.compId && !p.comps[l.source.compId]) fail(`${l.name}: missing nested comp`);
      for (const v of [l.inPoint, l.outPoint, l.startTime, l.stretch]) if (!Number.isFinite(v)) fail(`${l.name}: non-finite timing`);
      if (l.stretch === 0) fail(`${l.name}: zero stretch`);
      // parent chains terminate
      let cur: string | null = l.parentId;
      for (let n = 0; cur; n++) {
        if (n > c.layers.length) fail(`${l.name}: parent cycle`);
        cur = c.layers.find((x) => x.id === cur)?.parentId ?? null;
      }
      const sub = new Set<string>();
      for (const e of l.effects) {
        if (sub.has(e.id)) fail(`${l.name}: duplicate effect id`);
        sub.add(e.id);
      }
      for (const m of l.masks) {
        if (sub.has(m.id)) fail(`${l.name}: duplicate mask id`);
        sub.add(m.id);
      }
      forEachAnimProp(l, '', (prop: AnimProp, path: string) => {
        const seen = new Set<string>();
        let prev = -Infinity;
        for (const k of prop.keyframes) {
          if (seen.has(k.id)) fail(`${l.name}.${path}: duplicate keyframe id`);
          seen.add(k.id);
          if (!Number.isFinite(k.t)) fail(`${l.name}.${path}: keyframe time ${k.t}`);
          if (k.t < prev - 1e-9) fail(`${l.name}.${path}: keyframes out of order`);
          prev = k.t;
          const nums = typeof k.v === 'number' ? [k.v] : Array.isArray(k.v) && typeof k.v[0] === 'number' ? (k.v as number[]) : [];
          if (nums.some((x) => !Number.isFinite(x))) fail(`${l.name}.${path}: non-finite keyframe value`);
          for (const e of [...k.easeIn, ...k.easeOut]) if (!Number.isFinite(e.speed) || !(e.influence > 0 && e.influence <= 1)) fail(`${l.name}.${path}: bad ease ${JSON.stringify(e)}`);
        }
        const v = prop.value as unknown;
        const vn = typeof v === 'number' ? [v] : Array.isArray(v) && typeof v[0] === 'number' ? (v as number[]) : [];
        if (vn.some((x) => !Number.isFinite(x))) fail(`${l.name}.${path}: non-finite value`);
      });
    }
  }
  const s = getApp();
  if (s.activeCompId && !p.comps[s.activeCompId]) fail('active comp missing');
  const comp = s.activeCompId ? p.comps[s.activeCompId] : null;
  const layerIds = new Set(comp?.layers.map((l) => l.id) ?? []);
  for (const id of s.selLayers) if (!layerIds.has(id)) fail('selected layer missing');
  for (const k of s.selKeys) if (!layerIds.has(k.split('|')[0])) fail('selected keyframe on a missing layer');
  if (s.txDepth !== 0) fail(`transaction left open (${s.txDepth})`);
}

/** Everything the UI and renderer evaluate must work on any document the actions can produce. */
function evaluates(p: Project, r: ReturnType<typeof rng>, label: string): void {
  for (const c of Object.values(p.comps)) {
    const fe = new FrameEval(p, c, r.f() * c.duration);
    for (const l of c.layers) {
      const w = fe.worldMatrix(l);
      if (![...w].every(Number.isFinite)) assert.fail(`${label}: non-finite world matrix for ${l.name}`);
      const tv = fe.transformValues(l);
      if (![...tv.position, ...tv.scale].every(Number.isFinite)) assert.fail(`${label}: non-finite transform for ${l.name}`);
      if (!Number.isFinite(fe.opacity(l))) assert.fail(`${label}: non-finite opacity for ${l.name}`);
      fe.sourceTime(l);
    }
    fe.camera();
    fe.lights();
    buildRows(p, c, Object.fromEntries(c.layers.flatMap((l) => [[l.id, true], [`${l.id}|transform`, true], [`${l.id}|effects`, true], [`${l.id}|masks`, true]])), { kind: 'none' }, [], '');
    buildRows(p, c, {}, { kind: 'modified' }, [], '');
  }
}

function firstDiff(a: unknown, b: unknown, path = ''): string | null {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return `${path}: ${JSON.stringify(a)?.slice(0, 80)} ≠ ${JSON.stringify(b)?.slice(0, 80)}`;
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  for (const k of new Set([...ka, ...kb])) {
    const d = firstDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}/${k}`);
    if (d) return d;
  }
  return null;
}

const PATHS = ['transform.position', 'transform.scale', 'transform.rotation', 'transform.opacity', 'transform.anchor'] as const;
const SWITCHES = ['enabled', 'solo', 'locked', 'shy', 'threeD', 'motionBlur', 'adjustment', 'collapse', 'guide', 'audioEnabled'] as const;
const FX = EFFECTS.map((e) => e.type).filter((t) => t !== 'rotoBrush');

// Undo coalescing is time based. A fake clock (one tick per step) makes every session reproducible.
let clock = 0;
Object.defineProperty(globalThis.performance, 'now', { value: () => clock, configurable: true });

function session(seed: number, steps: number): void {
  const r = rng(seed);
  // ── starting document: two comps, mixed layer types, a precomp link ──
  const p0 = createProject(`Fuzz ${seed}`);
  const inner = createComp({ name: 'Inner', width: 640, height: 360, duration: 4, frameRate: 24 });
  inner.layers.push(createSolidLayer(inner, [1, 0, 0, 1], 'InnerSolid', 200, 200), createTextLayer(inner, 'inner', { size: 40 }));
  const main = createComp({ name: 'Main', width: 1280, height: 720, duration: 8, frameRate: 30 });
  main.layers.push(
    createTextLayer(main, 'Title', { size: 90 }),
    createShapeLayer(main, [createGroup([createRect([200, 120]), createFill([1, 1, 0, 1]), createStroke([0, 0, 0, 1], 3)], 'Group 1')], 'Shape'),
    createSolidLayer(main, [0, 0.5, 1, 1], 'Solid', 400, 300),
    createPrecompLayer(main, inner),
    createNullLayer(main, 'Null'),
    createCameraLayer(main, 35, 'Camera'),
    createLightLayer(main, 'point'),
    createAdjustmentLayer(main),
  );
  p0.comps[main.id] = main;
  p0.comps[inner.id] = inner;
  loadProject(p0);
  setApp({ activeCompId: main.id });
  const first = getApp().project;
  let shadow: Project = structuredClone(first);
  let synced: Project = first;
  const sync = (label: string) => {
    const cur = getApp().project;
    if (cur === synced) return;
    const patches = diffTree(synced, cur);
    shadow = patches ? applyPatches(shadow, structuredClone(patches)) : structuredClone(cur);
    synced = cur;
    const want = JSON.parse(JSON.stringify(cur));
    const where = firstDiff(shadow, want);
    if (where) assert.fail(`${label}: worker copy diverged at ${where} (patches: ${JSON.stringify(patches)?.slice(0, 600)})`);
  };

  const comp = (): Composition => {
    const s = getApp();
    return s.project.comps[s.activeCompId!];
  };
  const anyLayer = (): Layer | undefined => (comp().layers.length ? r.pick(comp().layers) : undefined);
  const someLayers = (): string[] => comp().layers.filter(() => r.chance(0.35)).map((l) => l.id);
  const t = () => Math.round(r.f() * comp().duration * comp().frameRate) / comp().frameRate;
  const allKeys = (): string[] => {
    const out: string[] = [];
    for (const l of comp().layers) forEachAnimProp(l, '', (prop: AnimProp, path: string) => { for (const k of prop.keyframes) out.push(keyOf({ layerId: l.id, path, kfId: k.id })); });
    return out;
  };
  const someKeys = (): string[] => allKeys().filter(() => r.chance(0.3));
  const value = (path: string, l: Layer): never => {
    const cur = getProp(l, path)!.value as number | number[];
    return (typeof cur === 'number' ? cur + (r.f() - 0.5) * 80 : cur.map((x) => x + (r.f() - 0.5) * 200)) as never;
  };

  const actions: (() => void)[] = [
    // values & keyframes
    () => { const l = anyLayer(); if (l) { setTime(comp().id, t()); const path = r.pick(PATHS); A.setPropValue(comp().id, l.id, path, value(path, l)); } },
    () => { const l = anyLayer(); if (l) { setTime(comp().id, t()); A.toggleStopwatch(comp().id, l.id, r.pick(PATHS)); } },
    () => { const l = anyLayer(); if (l) A.addKeyframeAt(comp().id, l.id, r.pick(PATHS), t()); },
    () => { const l = anyLayer(); if (l) { setTime(comp().id, t()); A.toggleKeyframeAtCTI(comp().id, l.id, r.pick(PATHS)); } },
    () => A.deleteKeyframes(someKeys()),
    () => { const keys = someKeys(); const orig = A.keyframeCompTimes(comp().id, keys); beginTx(); A.retimeKeyframes(comp().id, orig, (r.f() - 0.5) * 2, false); A.retimeKeyframes(comp().id, orig, (r.f() - 0.5) * 3, false); A.mergeKeyframeCollisions(comp().id, keys); endTx(); },
    () => A.retimeKeyframes(comp().id, A.keyframeCompTimes(comp().id, someKeys()), (r.f() - 0.5)),
    () => A.setKeyframeInterpolation(someKeys(), r.pick(['linear', 'bezier', 'continuous', 'auto', 'hold'] as const)),
    () => A.setKeyframeInterpolation(someKeys(), null, r.pick(['linear', 'bezier', 'continuous', 'auto'] as const)),
    () => A.easyEase(someKeys(), r.pick(['both', 'in', 'out'] as const)),
    () => A.toggleHold(someKeys()),
    () => { const k = someKeys()[0]; if (k) A.setKeyframeEase(comp().id, k, r.pick(['in', 'out'] as const), r.int(3), { speed: (r.f() - 0.5) * 500, influence: r.f() * 1.2 }, r.chance(0.5), r.pick([true, false, undefined])); },
    () => A.toggleRoving(someKeys()),
    () => { setApp({ selKeys: someKeys() }); A.copySelection(); const l = anyLayer(); if (l) setApp({ selLayers: [l.id] }); setTime(comp().id, t()); A.paste(); },
    () => { setApp({ selKeys: someKeys() }); A.cutSelection(); },
    // layers
    () => {
      const c = comp();
      const l = r.pick([
        () => createSolidLayer(c, [r.f(), r.f(), r.f(), 1], 'Solid', 100 + r.int(400), 100 + r.int(300)), () => createTextLayer(c, 'text', { size: 50 }),
        () => createNullLayer(c, 'Null'), () => createShapeLayer(c, [createGroup([createRect([100, 100]), createFill()], 'G')], 'Shape'),
        () => createAdjustmentLayer(c), () => createCameraLayer(c, 50, 'Camera'), () => createLightLayer(c, r.pick(['point', 'spot', 'parallel', 'ambient'] as const)),
      ])();
      A.addLayer(c.id, l, r.chance(0.5) ? { index: r.int(c.layers.length + 1) } : {});
    },
    () => { if (comp().layers.length > 3) A.deleteLayers(comp().id, someLayers().slice(0, 2)); },
    () => A.duplicateLayers(comp().id, someLayers().slice(0, 3)),
    () => A.splitLayers(comp().id, someLayers(), t()),
    () => A.reorderLayers(comp().id, someLayers(), r.int(comp().layers.length + 1)),
    () => A.arrangeLayers(comp().id, someLayers(), r.pick(['forward', 'backward', 'front', 'back'] as const)),
    () => A.setLayerFields(comp().id, someLayers(), { blendMode: r.pick(['normal', 'screen', 'multiply', 'add'] as const), label: r.int(8) }),
    () => A.toggleLayerSwitch(comp().id, someLayers(), r.pick(SWITCHES)),
    () => { const a = anyLayer(), b = anyLayer(); if (a) A.setParent(comp().id, a.id, b && r.chance(0.8) ? b.id : null, r.chance(0.8)); },
    () => { const a = anyLayer(), b = anyLayer(); if (a && b && a.id !== b.id) A.setTrackMatte(comp().id, a.id, r.chance(0.8) ? b.id : null, r.pick(['alpha', 'alphaInverted', 'luma', 'lumaInverted'] as const)); },
    () => A.shiftLayers(comp().id, someLayers(), (r.f() - 0.5) * 2),
    () => A.trimLayers(comp().id, someLayers(), r.pick(['in', 'out'] as const), t()),
    () => A.moveLayersTo(comp().id, someLayers(), r.pick(['in', 'out'] as const), t()),
    () => A.timeReverse(comp().id, someLayers().slice(0, 1)),
    () => { const l = anyLayer(); if (l) A.timeStretch(comp().id, l.id, r.pick([50, 100, 200, -100, 33]) ); },
    () => { const l = anyLayer(); if (l) A.setTimeRemap(comp().id, l.id, !l.timeRemapEnabled); },
    () => { const l = anyLayer(); if (l) { setTime(comp().id, t()); A.freezeFrame(comp().id, l.id); } },
    () => A.resetTransform(comp().id, someLayers()),
    () => A.fitToComp(comp().id, someLayers(), r.pick(['fit', 'width', 'height'] as const)),
    () => A.centerAnchor(comp().id, someLayers()),
    // comps
    () => A.updateComp(comp().id, { duration: 2 + r.int(10), frameRate: r.pick([24, 30, 60]) }),
    () => A.setWorkArea(comp().id, r.chance(0.6) ? t() : undefined, r.chance(0.6) ? t() : undefined),
    () => { if (r.chance(0.3)) A.trimCompToWorkArea(comp().id); },
    () => A.addCompMarker(comp().id, t()),
    () => { const ids = someLayers().slice(0, 2); if (ids.length && comp().layers.length > 2) A.precompose(comp().id, ids, 'Pre', r.chance(0.5)); },
    () => { const id = A.duplicateComp(comp().id); if (id && r.chance(0.3)) A.openComp(id); },
    () => { const ids = Object.keys(getApp().project.comps); A.openComp(r.pick(ids)); },
    () => { const p = getApp().project; const ids = Object.keys(p.comps); if (ids.length > 2) A.deleteProjectItems([r.pick(ids.filter((id) => id !== getApp().activeCompId))].filter(Boolean)); },
    // effects, masks, shapes, text, expressions
    () => { const l = anyLayer(); if (l) A.addEffect(comp().id, l.id, r.pick(FX)); },
    () => { const l = comp().layers.find((x) => x.effects.length); if (l) { const fx = r.pick(l.effects); r.pick([() => A.removeEffect(comp().id, l.id, fx.id), () => A.moveEffect(comp().id, l.id, fx.id, r.int(4)), () => A.resetEffect(comp().id, l.id, fx.id), () => A.duplicateEffect(comp().id, l.id, fx.id), () => A.setEffectField(comp().id, l.id, fx.id, { enabled: !fx.enabled })])(); } },
    () => { const l = anyLayer(); if (l) A.addMask(comp().id, l.id, rectPath(10, 10, 100 + r.int(100), 80)); },
    () => { const l = comp().layers.find((x) => x.masks.length); if (l) { const m = r.pick(l.masks); r.pick([() => A.removeMask(comp().id, l.id, m.id), () => A.setMaskFields(comp().id, l.id, m.id, { inverted: !m.inverted, mode: r.pick(A.MASK_MODES) })])(); } },
    () => { const l = comp().layers.find((x) => x.shape); if (l) A.addShapeItem(comp().id, l.id, createShapeItem(r.pick(['rect', 'ellipse', 'polystar', 'fill', 'stroke', 'trim', 'repeater', 'group', 'twist'] as const)), null, r.chance(0.5)); },
    () => { const l = comp().layers.find((x) => x.shape && x.shape.contents.length > 1); if (l) { const it = r.pick(l.shape!.contents); r.pick([() => A.removeShapeItem(comp().id, l.id, `shape.contents.${it.id}`), () => A.moveShapeItem(comp().id, l.id, `shape.contents.${it.id}`, r.pick([-1, 1] as const))])(); } },
    () => { const l = comp().layers.find((x) => x.text); if (l) r.pick([() => A.setSourceText(comp().id, l.id, `t${r.int(999)}`), () => A.setTextDocument(comp().id, [l.id], { size: 20 + r.int(100), tracking: r.int(200) }), () => A.addTextAnimator(comp().id, l.id, [r.pick(['position', 'opacity', 'scale', 'rotation'] as const)])])(); },
    () => { const l = comp().layers.find((x) => x.text?.animators.length); if (l) { const a = r.pick(l.text!.animators); r.pick([() => A.addAnimatorProperty(comp().id, l.id, a.id, r.pick(['tracking', 'blur', 'skew'] as const)), () => A.addSelector(comp().id, l.id, a.id, r.pick(['range', 'wiggly'] as const)), () => A.removeTextNode(comp().id, l.id, `text.animators.${a.id}`)])(); } },
    () => { const l = anyLayer(); if (l) A.setExpression(comp().id, l.id, r.pick(PATHS), r.pick(['value', 'wiggle(2, 20)', 'time * 10', 'thisComp.layer(1).transform.position', 'syntax error (', null])); },
    () => { const l = anyLayer(); if (l) A.toggleExpressionEnabled(comp().id, l.id, r.pick(PATHS)); },
    // selection, transactions
    () => A.selectLayers(someLayers(), r.pick(['set', 'add', 'toggle'] as const)),
    () => { A.selectAllLayers(); if (r.chance(0.5)) A.deselectAll(); },
    () => { const l = anyLayer(); if (!l) return; beginTx(); for (let i = 0; i < 5; i++) A.setPropValue(comp().id, l.id, 'transform.position', [r.f() * 1000, r.f() * 600, 0]); if (r.chance(0.3)) cancelTx(); else endTx(); },
  ];

  let done = 0, undone = 0;
  const trail: string[] = [];
  for (let i = 0; i < steps; i++) {
    clock += 5000;
    const roll = r.f();
    let what = 'undo';
    try {
      if (roll < 0.1) { undo(); undone++; } else if (roll < 0.16) { what = 'redo'; redo(); }
      else {
        const fn = r.pick(actions);
        // the action's own source is its name in failure reports
        what = fn.toString().replace(/\s+/g, ' ').slice(6, 96);
        fn();
        done++;
      }
    } catch (e) {
      assert.fail(`seed ${seed} step ${i} [${what}]: action threw ${(e as Error).stack ?? e}`);
    }
    trail.push(what);
    const label = `seed ${seed} step ${i} [${what}] (before: ${trail.slice(-3, -1).join(' ⟶ ')})`;
    const p = getApp().project;
    invariants(p, label);
    if (i % 3 === 0) evaluates(p, r, label);
    sync(label);
  }
  assert.ok(done > steps * 0.6 && undone > 0);
  // the whole history unwinds to the very first document and replays to the last
  // (the session may have ended on an undo: the newest document is the redo tip)
  let guard = 0;
  while (getApp().future.length && guard++ < 10000) redo();
  const last = getApp().project;
  while (getApp().past.length && guard++ < 20000) undo();
  if (getApp().past.length === 0 && steps < 250) assert.deepEqual(getApp().project, first, `seed ${seed}: undoing everything restores the first document`);
  while (getApp().future.length && guard++ < 30000) redo();
  assert.deepEqual(getApp().project, last, `seed ${seed}: redoing everything restores the last document`);
  invariants(getApp().project, `seed ${seed} end`);
}

// FUZZ_SEEDS=500 npm test widens the search; the default keeps the suite quick.
const SEEDS = Number(process.env.FUZZ_SEEDS ?? 12);
for (let seed = 1; seed <= SEEDS; seed++) {
  test(`fuzz: random editing session (seed ${seed}) keeps the document valid, evaluable and in sync`, () => session(seed, seed % 3 === 0 ? 200 : 320));
}
