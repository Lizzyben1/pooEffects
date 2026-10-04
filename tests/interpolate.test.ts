import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyframedValue, velocityAt } from '../src/anim/interpolate';
import type { AnimProp, Keyframe } from '../src/core/types';

const kf = (t: number, v: any, o: Partial<Keyframe> = {}): Keyframe => ({
  id: `k${t}`, t, v, inType: 'linear', outType: 'linear',
  easeIn: [{ speed: 0, influence: 1 / 3 }], easeOut: [{ speed: 0, influence: 1 / 3 }], ...o,
});
const near = (a: number, b: number, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('static value without keyframes', () => {
  const p: AnimProp<number> = { value: 42, keyframes: [] };
  assert.equal(keyframedValue(p, 3), 42);
});

test('linear interpolation and clamping outside the keyed range', () => {
  const p: AnimProp<number> = { value: 0, keyframes: [kf(0, 0), kf(2, 100)] };
  near(keyframedValue(p, -1), 0);
  near(keyframedValue(p, 1), 50);
  near(keyframedValue(p, 0.5), 25);
  near(keyframedValue(p, 5), 100);
});

test('hold interpolation keeps the value until the next keyframe', () => {
  const p: AnimProp<number> = { value: 0, keyframes: [kf(0, 10, { outType: 'hold' }), kf(1, 20)] };
  near(keyframedValue(p, 0.99), 10);
  near(keyframedValue(p, 1), 20);
});

test('easy ease is symmetric and has zero speed at both keyframes', () => {
  const ease = { inType: 'bezier' as const, outType: 'bezier' as const };
  const p: AnimProp<number> = { value: 0, keyframes: [kf(0, 0, ease), kf(1, 100, ease)] };
  near(keyframedValue(p, 0.5), 50);
  near(keyframedValue(p, 0.25) + keyframedValue(p, 0.75), 100);
  near(velocityAt(p, 0.001)[0], 0, 2);
  near(velocityAt(p, 0.999)[0], 0, 2);
  assert.ok(velocityAt(p, 0.5)[0] > 100, 'eased curve must be faster than linear mid-segment');
});

test('speed at a bezier keyframe equals the specified ease speed', () => {
  const p: AnimProp<number> = {
    value: 0,
    keyframes: [
      kf(0, 0, { outType: 'bezier', easeOut: [{ speed: 300, influence: 0.5 }] }),
      kf(2, 100, { inType: 'bezier', easeIn: [{ speed: -50, influence: 0.25 }] }),
    ],
  };
  near(velocityAt(p, 0.0005, false, 1e-4)[0], 300, 1);
  near(velocityAt(p, 1.9995, false, 1e-4)[0], -50, 1);
});

test('multi-dimensional values ease per dimension', () => {
  const p: AnimProp<number[]> = { value: [0, 0], keyframes: [kf(0, [0, 100]), kf(1, [100, 0])] };
  const v = keyframedValue(p, 0.5);
  near(v[0], 50);
  near(v[1], 50);
});

test('spatial linear path moves at constant speed in a straight line', () => {
  const p: AnimProp<number[]> = {
    value: [0, 0, 0],
    keyframes: [kf(0, [0, 0, 0], { spatial: 'linear' }), kf(1, [300, 400, 0], { spatial: 'linear' })],
  };
  const v = keyframedValue(p, 0.5, true);
  near(v[0], 150);
  near(v[1], 200);
  near(Math.hypot(...velocityAt(p, 0.5, true)), 500, 1);
});

test('spatial bezier path passes through the keyframes and curves', () => {
  const p: AnimProp<number[]> = {
    value: [0, 0],
    keyframes: [
      kf(0, [0, 0], { spatial: 'bezier', to: [0, -200], ti: [0, 0] }),
      kf(1, [400, 0], { spatial: 'bezier', ti: [0, -200], to: [0, 0] }),
    ],
  };
  const mid = keyframedValue(p, 0.5, true);
  near(mid[0], 200, 1);
  assert.ok(mid[1] < -100, 'mid point should bulge upward');
  near(keyframedValue(p, 1, true)[0], 400);
});

test('auto-bezier temporal is flat at extrema and smooth through monotonic keys', () => {
  const auto = { inType: 'auto' as const, outType: 'auto' as const };
  const p: AnimProp<number> = { value: 0, keyframes: [kf(0, 0, auto), kf(1, 100, auto), kf(2, 0, auto)] };
  near(velocityAt(p, 1)[0], 0, 2);
  const q: AnimProp<number> = { value: 0, keyframes: [kf(0, 0, auto), kf(1, 50, auto), kf(2, 100, auto)] };
  near(velocityAt(q, 1)[0], 50, 2);
});

test('bezier paths interpolate vertex-wise', () => {
  const a = { closed: true, v: [[0, 0], [10, 0]] as [number, number][], i: [[0, 0], [0, 0]] as [number, number][], o: [[0, 0], [0, 0]] as [number, number][] };
  const b = { closed: true, v: [[0, 10], [20, 10]] as [number, number][], i: [[0, 0], [0, 0]] as [number, number][], o: [[0, 0], [0, 0]] as [number, number][] };
  const p: AnimProp<any> = { value: a, keyframes: [kf(0, a), kf(1, b)] };
  const m = keyframedValue(p, 0.5);
  near(m.v[1][0], 15);
  near(m.v[0][1], 5);
});
