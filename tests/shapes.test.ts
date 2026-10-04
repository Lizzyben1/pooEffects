import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGroup, createRect, createEllipse, createStroke, createFill, createTrim, createRepeater, createPolystar } from '../src/core/factory';
import { evaluateShapeContents, type ValFn } from '../src/shapes/evaluate';
import { pathLength, trimPath } from '../src/shapes/path';
import { rectToPath, ellipseToPath } from '../src/shapes/generators';
import { keyframedValue } from '../src/anim/interpolate';

const val: ValFn = ((p: any) => keyframedValue(p, 0)) as ValFn;
const near = (a: number, b: number, eps = 0.5) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('rect path perimeter and AE start vertex (top-right)', () => {
  const p = rectToPath([200, 100], [0, 0], 0, false);
  near(pathLength(p), 600, 1e-6);
  assert.deepEqual(p.v[0], [100, -50]);
});

test('ellipse circumference approximates 2πr', () => {
  near(pathLength(ellipseToPath([200, 200], [0, 0], false)), 2 * Math.PI * 100, 0.2);
});

test('trim 0–50% of a closed rect yields half the perimeter', () => {
  const p = rectToPath([200, 100], [0, 0], 0, false);
  const half = trimPath(p, 0, 0.5);
  assert.equal(half.length, 1);
  near(pathLength(half[0]), 300, 1e-3);
});

test('trim with offset wrapping a closed path stays continuous', () => {
  const p = rectToPath([200, 200], [0, 0], 0, false);
  const r = trimPath(p, 0.9, 1.2);
  assert.equal(r.length, 1);
  near(pathLength(r[0]), 0.3 * 800, 1e-3);
});

test('trim paths placed below a stroke trims that stroke (AE semantics)', () => {
  const trim = createTrim();
  trim.end.value = 25;
  const draws = evaluateShapeContents([createGroup([createRect([100, 100]), createStroke(), trim])], val, 0);
  assert.equal(draws.length, 1);
  const L = draws[0].entries.flatMap((e) => e.paths).reduce((s, p) => s + pathLength(p), 0);
  near(L, 100, 1e-3);
});

test('repeater duplicates fills and strokes above it', () => {
  const rep = createRepeater(5);
  const draws = evaluateShapeContents([createEllipse([20, 20]), createFill(), createStroke(), rep], val, 0);
  assert.equal(draws.length, 10);
  // copies are offset by +100 x cumulatively
  const xs = draws.filter((d) => d.kind === 'fill').map((d) => d.entries[0].paths[0].v[0][0]).sort((a, b) => a - b);
  assert.deepEqual(xs.map(Math.round), [0, 100, 200, 300, 400]);
});

test('group transforms bake into geometry and scale stroke width', () => {
  const g = createGroup([createPolystar('polygon', 4, 50), createStroke([1, 1, 1, 1], 2)]);
  g.transform.scale.value = [200, 200];
  g.transform.position.value = [10, 0];
  const draws = evaluateShapeContents([g], val, 0);
  near(draws[0].width, 4, 1e-9);
  const v0 = draws[0].entries[0].paths[0].v[0];
  near(v0[0], 10, 1e-6);
  near(v0[1], -100, 1e-6);
});
