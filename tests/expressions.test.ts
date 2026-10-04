import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateExpression, type ExprHost } from '../src/anim/expressions';

const host = (o: Partial<ExprHost> = {}): ExprHost => ({
  time: 1, value: [100, 200], valueAtTime: (t) => [t * 10, 0], velocityAtTime: () => [10, 0],
  numKeys: 2, key: (i) => (i === 1 ? { time: 0, value: [0, 0], index: 1 } : i === 2 ? { time: 2, value: [20, 0], index: 2 } : null),
  frameDuration: 1 / 30, seed: 1234, thisLayer: { name: 'L', index: 1 }, thisComp: { width: 1920, height: 1080 },
  comp: () => null, inPoint: 0, outPoint: 10, ...o,
});

test('single expression', () => {
  assert.deepEqual(evaluateExpression('[value[0] + 5, time * 100]', host()).value, [105, 100]);
});

test('multi-statement with undeclared variables and last-statement result', () => {
  const r = evaluateExpression('amp = 10;\nfreq = 2\n[value[0] + amp * freq, value[1]]', host());
  assert.equal(r.error, null);
  assert.deepEqual(r.value, [120, 200]);
});

test('if/else as the final statement uses completion value semantics', () => {
  const r = evaluateExpression('if (time > 0.5) { [1, 2] } else { [3, 4] }', host());
  assert.equal(r.error, null);
  assert.deepEqual(r.value, [1, 2]);
});

test('wiggle is deterministic and bounded', () => {
  const a = evaluateExpression('wiggle(3, 50)', host()).value as number[];
  const b = evaluateExpression('wiggle(3, 50)', host()).value as number[];
  assert.deepEqual(a, b);
  assert.ok(Math.abs(a[0] - 100) <= 50 && Math.abs(a[1] - 200) <= 50);
});

test('loopOut cycle maps time back into the keyed range', () => {
  const r = evaluateExpression("loopOut('cycle')", host({ time: 2.5 }));
  assert.deepEqual(r.value, [5, 0]);
});

test('scalar broadcast and errors fall back to the original value', () => {
  assert.deepEqual(evaluateExpression('50', host()).value, [50, 50]);
  const bad = evaluateExpression('thisIs.not.valid', host());
  assert.ok(bad.error);
  assert.deepEqual(bad.value, [100, 200]);
});

test('globals are not reachable from expressions', () => {
  const r = evaluateExpression('typeof document === "undefined" && typeof fetch === "undefined" ? 1 : 0', host({ value: 0 }));
  assert.equal(r.value, 1);
});

test('linear/ease helpers', () => {
  assert.equal(evaluateExpression('linear(time, 0, 2, 0, 100)', host({ value: 0 })).value, 50);
  assert.equal(evaluateExpression('ease(time, 0, 2, 0, 100)', host({ value: 0 })).value, 50);
});
