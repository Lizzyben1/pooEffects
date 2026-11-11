// Regression tests for the stability pass: incremental worker sync, easing maths behind the graph
// editor, keyframe drags, path vertex editing, pre-compose and the RAM cache policy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { produce } from 'immer';
import { applyPatches, diffTree } from '../src/core/sync';
import { createComp, createProject, createSolidLayer } from '../src/core/factory';
import type { AnimProp, BezierPath, Composition, Keyframe, Layer, Project } from '../src/core/types';
import { effectiveEase, keyframedValue, segmentSpeed } from '../src/anim/interpolate';
import { getApp, keyOf, loadProject, setApp, setPrefs, undo, useApp } from '../src/state/store';
import * as A from '../src/state/actions';
import * as cache from '../src/state/cache';
import { setTime } from '../src/state/time';
import { getSegment, insertVertex, pointOnSeg, removeVertex, toggleVertexSmooth } from '../src/shapes/path';

function project(): { project: Project; comp: Composition; layer: Layer } {
  const p = createProject('Test');
  const comp = createComp({ name: 'Comp', width: 1280, height: 720, duration: 6, frameRate: 30 });
  const layer = createSolidLayer(comp, [1, 0, 0, 1], 'Box', 200, 100);
  comp.layers.push(layer, createSolidLayer(comp, [0, 1, 0, 1], 'Other', 300, 300));
  p.comps[comp.id] = comp;
  return { project: p, comp, layer };
}

function open(): { compId: string; layerId: string } {
  const { project: p, comp, layer } = project();
  loadProject(p);
  setApp({ activeCompId: comp.id });
  return { compId: comp.id, layerId: layer.id };
}

const liveLayer = (compId: string, layerId: string) => getApp().project.comps[compId].layers.find((l) => l.id === layerId)!;
const kfKey = (layerId: string, path: string, k: Keyframe) => keyOf({ layerId, path, kfId: k.id });

function addKeys(compId: string, layerId: string, path: string, keys: [number, unknown][]): void {
  for (const [t, v] of keys) {
    setTime(compId, t);
    A.addKeyframeAt(compId, layerId, path);
    A.setPropValue(compId, layerId, path, v as never);
  }
}

// ── incremental sync ────────────────────────────────────────────────────────

test('diffTree / applyPatches reproduce edits and keep untouched subtrees identical', () => {
  const { project: a, comp, layer } = project();
  const edits: ((d: Project) => void)[] = [
    (d) => { (d.comps[comp.id].layers[0].transform.position.value as number[])[0] = 42; },
    (d) => { d.comps[comp.id].layers[0].name = 'Renamed'; },
    (d) => { d.comps[comp.id].layers.reverse(); },
    (d) => { d.comps[comp.id].layers.unshift(createSolidLayer(comp, [0, 0, 1, 1], 'New', 10, 10) as never); },
    (d) => { d.comps[comp.id].layers.splice(1, 1); },
    (d) => { delete (d.comps[comp.id].layers[0] as { solid?: unknown }).solid; },
    (d) => { d.comps.extra = createComp({ name: 'Extra', width: 10, height: 10, duration: 1, frameRate: 24 }) as never; },
    (d) => { delete d.comps[comp.id]; },
  ];
  let main = a;
  let worker = structuredClone(a);
  for (const edit of edits) {
    const next = produce(main, edit as never);
    const patches = diffTree(main, next);
    assert.ok(patches, 'small edits are always patchable');
    // patches travel through structured clone on their way to the worker
    const before = worker;
    worker = applyPatches(worker, structuredClone(patches));
    assert.deepEqual(worker, JSON.parse(JSON.stringify(next)));
    assert.notEqual(worker, before);
    main = next;
  }
  // identity: an edit to one layer leaves the other layer object untouched in the worker copy
  const base = structuredClone(a);
  const next = produce(a, (d) => { d.comps[comp.id].layers[0].name = 'x'; });
  const out = applyPatches(base, diffTree(a, next)!);
  assert.equal(out.comps[comp.id].layers[1], base.comps[comp.id].layers[1]);
  assert.notEqual(out.comps[comp.id].layers[0], base.comps[comp.id].layers[0]);
  assert.equal(layer.name, 'Box', 'the source document is never mutated');
});

test('diffTree is proportional to the edit and gives up on unrelated documents', () => {
  const { project: a, comp } = project();
  const next = produce(a, (d) => { (d.comps[comp.id].layers[0].transform.opacity as AnimProp<number>).value = 50; });
  const patches = diffTree(a, next)!;
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].p.slice(-3), ['transform', 'opacity', 'value']);
  assert.equal(diffTree(a, a)!.length, 0);
  // a keyframe insert re-sends only the new keyframe, not the whole array
  const kf = (t: number): Keyframe => ({ id: `k${t}`, t, v: t, inType: 'linear', outType: 'linear', easeIn: [], easeOut: [] });
  const many = produce(a, (d) => { d.comps[comp.id].layers[0].transform.opacity.keyframes = Array.from({ length: 500 }, (_, i) => kf(i)) as never; });
  const plusOne = produce(many, (d) => { d.comps[comp.id].layers[0].transform.opacity.keyframes.splice(250, 0, kf(250.5) as never); });
  const p2 = diffTree(many, plusOne)!;
  assert.equal(p2.length, 1);
  assert.ok('ids' in p2[0] && Object.keys(p2[0].add).length === 1);
  assert.deepEqual(applyPatches(structuredClone(many), structuredClone(p2)), JSON.parse(JSON.stringify(plusOne)));
  assert.equal(diffTree(a, plusOne, 3), null, 'over budget → send the whole project');
});

// ── easing maths ────────────────────────────────────────────────────────────

test('effectiveEase reports the ease a linear keyframe really uses; segmentSpeed is its exact slope', () => {
  const { compId, layerId } = open();
  addKeys(compId, layerId, 'transform.opacity', [[0, 0], [2, 100], [4, 40]]);
  const kfs = liveLayer(compId, layerId).transform.opacity.keyframes as Keyframe[];
  const out0 = effectiveEase(kfs, 0, 'out', 0, false);
  assert.ok(Math.abs(out0.speed - 50) < 1e-9 && Math.abs(out0.influence - 1 / 6) < 1e-9);
  const in1 = effectiveEase(kfs, 1, 'in', 0, false);
  assert.ok(Math.abs(in1.speed - 50) < 1e-9);
  assert.ok(Math.abs(effectiveEase(kfs, 1, 'out', 0, false).speed + 30) < 1e-9);
  assert.ok(Math.abs(segmentSpeed(kfs, 0, 1, 0, false) - 50) < 1e-9);
  // eased segment: analytic slope agrees with a numerical derivative
  A.easyEase(kfs.map((k) => kfKey(layerId, 'transform.opacity', k)), 'both');
  const eased = liveLayer(compId, layerId).transform.opacity;
  for (const t of [0.3, 1, 1.7, 2.5, 3.6]) {
    const h = 1e-4;
    const num = ((keyframedValue(eased, t + h) as number) - (keyframedValue(eased, t - h) as number)) / (2 * h);
    const a = t < 2 ? 0 : 1;
    assert.ok(Math.abs(segmentSpeed(eased.keyframes as Keyframe[], a, t, 0, false) - num) < 0.05, `t=${t}`);
  }
  assert.equal(segmentSpeed(eased.keyframes as Keyframe[], 0, 0, 0, false), 0, 'easy ease starts at rest');
});

test('converting keyframes to Bézier, or editing one ease dimension, does not disturb the curve', () => {
  const { compId, layerId } = open();
  addKeys(compId, layerId, 'transform.scale', [[0, [100, 100, 100]], [2, [200, 50, 100]], [4, [80, 120, 100]]]);
  addKeys(compId, layerId, 'transform.position', [[0, [100, 100, 0]], [2, [900, 100, 0]], [4, [900, 600, 0]]]);
  const sample = (path: 'scale' | 'position') => {
    const p = liveLayer(compId, layerId).transform[path];
    return [0.4, 1, 1.9, 2.6, 3.5].map((t) => keyframedValue(p, t, path === 'position') as number[]);
  };
  const close = (a: number[][], b: number[][], eps: number) => a.every((v, i) => v.every((x, j) => Math.abs(x - b[i][j]) < eps));
  for (const path of ['scale', 'position'] as const) {
    const before = sample(path);
    const keys = (liveLayer(compId, layerId).transform[path].keyframes as Keyframe[]).map((k) => kfKey(layerId, `transform.${path}`, k));
    A.setKeyframeInterpolation(keys, 'bezier');
    const kf = liveLayer(compId, layerId).transform[path].keyframes[1];
    assert.equal(kf.inType, 'bezier');
    assert.ok(close(before, sample(path), path === 'position' ? 0.5 : 1e-6), `${path} keeps its shape`);
  }
  // editing only the X ease of a still-linear keyframe must leave Y exactly as it was
  undo();
  undo();
  const before = sample('scale');
  const mid = liveLayer(compId, layerId).transform.scale.keyframes[1] as Keyframe;
  assert.equal(mid.outType, 'linear');
  A.setKeyframeEase(compId, kfKey(layerId, 'transform.scale', mid), 'out', 0, { speed: 0, influence: 0.6 }, false);
  const after = sample('scale');
  assert.ok(after.every((v, i) => Math.abs(v[1] - before[i][1]) < 1e-6), 'the untouched dimension is unchanged');
  assert.ok(after.some((v, i) => Math.abs(v[0] - before[i][0]) > 0.5), 'the edited dimension moved');
});

test('linked ease edits keep one speed through the keyframe; a held keyframe stays held', () => {
  const { compId, layerId } = open();
  addKeys(compId, layerId, 'transform.opacity', [[0, 0], [2, 100], [4, 40]]);
  const path = 'transform.opacity';
  const k = () => liveLayer(compId, layerId).transform.opacity.keyframes as Keyframe[];
  A.setKeyframeEase(compId, kfKey(layerId, path, k()[1]), 'out', 0, { speed: 12, influence: 0.4 }, false, true);
  assert.equal(k()[1].inType, 'continuous');
  assert.equal(k()[1].easeIn[0].speed, 12);
  assert.equal(k()[1].easeOut[0].speed, 12);
  A.setKeyframeEase(compId, kfKey(layerId, path, k()[1]), 'in', 0, { speed: 5, influence: 0.4 }, false, false);
  assert.equal(k()[1].inType, 'bezier');
  assert.equal(k()[1].easeOut[0].speed, 12, 'splitting leaves the other side alone');
  // toggle hold on and off
  const key0 = kfKey(layerId, path, k()[0]);
  A.toggleHold([key0]);
  assert.equal(k()[0].outType, 'hold');
  A.setKeyframeEase(compId, key0, 'out', 0, { speed: 1, influence: 0.3 }, false);
  assert.equal(k()[0].outType, 'hold', 'velocity edits do not release a hold');
  A.toggleHold([key0]);
  assert.notEqual(k()[0].outType, 'hold');
});

// ── keyframe drags ──────────────────────────────────────────────────────────

test('dragging a keyframe past another does not delete it; dropping onto it replaces it', () => {
  const { compId, layerId } = open();
  const path = 'transform.opacity';
  addKeys(compId, layerId, path, [[0, 0], [1, 50], [2, 100]]);
  const kfs = () => liveLayer(compId, layerId).transform.opacity.keyframes as Keyframe[];
  const first = kfKey(layerId, path, kfs()[0]);
  const orig = A.keyframeCompTimes(compId, [first]);
  // drag: over the middle keyframe (exactly on it for one move), then beyond
  A.retimeKeyframes(compId, orig, 1, false);
  assert.equal(kfs().length, 3, 'a keyframe under the dragged one survives the drag');
  A.retimeKeyframes(compId, orig, 1.5, false);
  A.mergeKeyframeCollisions(compId, [first]);
  assert.equal(kfs().length, 3);
  assert.deepEqual(kfs().map((k) => Math.round(k.t * 10) / 10), [1, 1.5, 2]);
  // released exactly on the last keyframe → it replaces it
  A.retimeKeyframes(compId, orig, 2, false);
  A.mergeKeyframeCollisions(compId, [first]);
  assert.equal(kfs().length, 2);
  assert.equal(kfs()[1].v, 0);
  // batched value edits are one document change
  const past = getApp().past.length;
  A.setKeyframeValues(compId, new Map(kfs().map((k) => [kfKey(layerId, path, k), 7])));
  assert.equal(getApp().past.length, past + 1);
  assert.ok(kfs().every((k) => k.v === 7));
});

// ── path vertex editing ─────────────────────────────────────────────────────

test('insertVertex keeps the shape; removeVertex and toggleVertexSmooth behave', () => {
  const p: BezierPath = { closed: true, v: [[0, 0], [100, 0], [100, 100], [0, 100]], i: [[0, -20], [-30, 0], [0, 0], [0, 0]], o: [[30, 0], [0, 20], [0, 0], [0, 0]] };
  const { path: q, index } = insertVertex(p, 0, 0.37);
  assert.equal(index, 1);
  assert.equal(q.v.length, 5);
  // the old segment 0 is now segments 0 and 1: every sample of the old curve lies on the new one
  for (let s = 0; s <= 10; s++) {
    const t = s / 10;
    const old = pointOnSeg(getSegment(p, 0), t);
    const neu = t <= 0.37 ? pointOnSeg(getSegment(q, 0), t / 0.37) : pointOnSeg(getSegment(q, 1), (t - 0.37) / 0.63);
    assert.ok(Math.hypot(old[0] - neu[0], old[1] - neu[1]) < 1e-9, `t=${t}`);
  }
  assert.deepEqual(removeVertex(q, 1)!.v.length, 4);
  assert.equal(removeVertex({ closed: true, v: [[0, 0], [1, 0], [1, 1]], i: [[0, 0], [0, 0], [0, 0]], o: [[0, 0], [0, 0], [0, 0]] }, 0), null);
  assert.equal(removeVertex({ closed: false, v: [[0, 0], [1, 0]], i: [[0, 0], [0, 0]], o: [[0, 0], [0, 0]] }, 0), null);
  const smooth = toggleVertexSmooth(p, 2);
  assert.ok(Math.hypot(...smooth.o[2]) > 1 && smooth.i[2][0] === -smooth.o[2][0]);
  assert.deepEqual(toggleVertexSmooth(p, 0).o[0], [0, 0]);
  assert.deepEqual(p.o[0], [30, 0], 'inputs are not mutated');
});

// ── pre-compose ─────────────────────────────────────────────────────────────

test('pre-compose "leave all attributes" keeps the layer (id, transform, masks, effects) on a comp of the source size', () => {
  const { compId, layerId } = open();
  A.setPropValue(compId, layerId, 'transform.position', [300, 200, 0]);
  A.addEffect(compId, layerId, 'gaussianBlur');
  const before = liveLayer(compId, layerId);
  assert.ok(A.canLeaveAttributes(before));
  const nestedId = A.precompose(compId, [layerId], 'Box Comp', false)!;
  const p = getApp().project;
  const outer = liveLayer(compId, layerId);
  assert.equal(outer.type, 'precomp');
  assert.equal(outer.source?.compId, nestedId);
  assert.deepEqual(outer.transform, before.transform);
  assert.equal(outer.effects.length, 1);
  assert.equal(p.comps[nestedId].width, 200);
  assert.equal(p.comps[nestedId].height, 100);
  const inner = p.comps[nestedId].layers[0];
  assert.notEqual(inner.id, layerId);
  assert.equal(inner.effects.length, 0);
  assert.deepEqual(inner.transform.position.value, [100, 50, 0]);
  assert.deepEqual(inner.transform.anchor.value, [100, 50, 0]);
  assert.equal(p.comps[compId].layers.length, 2);
});

// ── RAM cache ───────────────────────────────────────────────────────────────

test('cache: LRU eviction, pinned frames survive, background caching stops when full', async () => {
  const closed = new Set<number>();
  let n = 0;
  // 512×512 RGBA = 1 MB per frame
  const bmp = () => {
    const id = n++;
    return { width: 512, height: 512, close: () => closed.add(id), id } as unknown as ImageBitmap & { id: number };
  };
  const { compId } = open();
  const p = getApp().project;
  setPrefs({ cacheBudgetMB: 256 });
  cache.clearAll();
  const MB = 1024 * 1024;
  assert.ok(cache.hasRoomFor(compId, 'a', MB));
  const frames: (ImageBitmap & { id: number })[] = [];
  for (let f = 0; f < 200; f++) {
    const b = bmp();
    frames.push(b);
    assert.ok(cache.put(p, compId, f, 'a', b));
  }
  assert.equal(cache.stats().frames, 200);
  // touch frame 0 so it is the most recently used, pin frame 1 (on screen)
  assert.equal(cache.get(compId, 0, 'a'), frames[0]);
  cache.pin(frames[1]);
  for (let f = 200; f < 300; f++) cache.put(p, compId, f, 'a', bmp());
  assert.ok(cache.stats().mb <= 256);
  assert.ok(cache.has(compId, 0, 'a'), 'recently used frame is kept');
  assert.ok(!cache.has(compId, 1, 'a') && !closed.has(frames[1].id), 'an evicted frame that is on screen is not closed');
  assert.ok(closed.has(frames[2].id), 'old frames are closed when evicted');
  cache.unpin(frames[1]);
  assert.ok(closed.has(frames[1].id), 'released once the viewer lets go');
  // full of this comp's own frames: background caching must stop rather than churn
  while (cache.hasRoomFor(compId, 'a', MB) && n < 2000) cache.put(p, compId, n, 'a', bmp());
  assert.ok(!cache.hasRoomFor(compId, 'a', MB));
  assert.ok(cache.hasRoom(MB), 'playback may still render (older frames make room)');
  // frames of another configuration are the first to go, so a different one still has room
  assert.ok(cache.hasRoomFor(compId, 'b', MB));
  cache.clearAll();
  for (let f = 0; f < 250; f++) cache.put(p, compId, f, 'old', bmp());
  assert.ok(cache.hasRoomFor(compId, 'new', 20 * MB), 'stale frames of other settings can be evicted');
  for (let f = 0; f < 20; f++) cache.put(p, compId, f, 'new', bmp());
  assert.equal(cache.cachedFrames(compId, 'new').size, 20);
  // a frame rendered from an outdated document is refused and left with the caller
  A.setPropValue(compId, getApp().project.comps[compId].layers[0].id, 'transform.opacity', 10);
  cache.validate(getApp().project);
  const stale = bmp();
  assert.equal(cache.put(p, compId, 0, 'new', stale), false);
  assert.ok(!closed.has(stale.id));
  cache.clearAll();
  await new Promise((r) => setTimeout(r, 80));
});

test('project panel: folders cannot be nested into themselves; names cannot be emptied', () => {
  const { compId } = open();
  const a = A.newFolder('A');
  const b = A.newFolder('B', a);
  const c = A.newFolder('C', b);
  A.moveToFolder([a], c); // into its own grandchild
  A.moveToFolder([a], a); // into itself
  A.moveToFolder([b], 'missing'); // into a folder that does not exist
  let f = getApp().project.folders;
  assert.equal(f[a].folderId, null);
  assert.equal(f[b].folderId, a);
  A.moveToFolder([c, compId], null);
  A.moveToFolder([a], c); // now legal: C is no longer inside A
  f = getApp().project.folders;
  assert.equal(f[a].folderId, c);
  assert.equal(f[c].folderId, null);
  // every folder still reaches the root
  for (const id of Object.keys(f)) {
    let cur: string | null = id;
    for (let n = 0; cur && n < 10; n++) cur = f[cur].folderId;
    assert.equal(cur, null);
  }
  const name = getApp().project.comps[compId].name;
  A.renameItem(compId, '   ');
  assert.equal(getApp().project.comps[compId].name, name);
  A.renameItem(compId, '  Shot 1 ');
  assert.equal(getApp().project.comps[compId].name, 'Shot 1');
});

test('a store listener that throws does not stop the listeners after it', () => {
  open();
  const seen: string[] = [];
  const err = console.error;
  const logged: unknown[] = [];
  console.error = (...a: unknown[]) => void logged.push(a);
  const off1 = useApp.subscribe(() => {
    throw new Error('boom');
  });
  const off2 = useApp.subscribe((s) => void seen.push(s.project.name));
  try {
    assert.doesNotThrow(() => A.renameItem(Object.keys(getApp().project.comps)[0], 'After'));
  } finally {
    console.error = err;
    off1();
    off2();
  }
  assert.equal(seen.length, 1);
  assert.equal(logged.length, 1);
});
