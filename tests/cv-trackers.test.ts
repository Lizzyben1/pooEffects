import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPyramid } from '../src/cv/image';
import { applyH } from '../src/cv/homography';
import { PlanarTracker } from '../src/cv/planar';
import { PointTracker } from '../src/cv/pointTracker';
import { traceContours, resampleClosed, polygonArea, distanceTransform, keepComponents } from '../src/cv/mask';
import { render, texture } from './cvsynth';

test('planar tracker follows a perspective warp across frames', () => {
  const f = texture(17);
  const W = 480, H = 360;
  // frame k shows the plane through homography Hk (plane → image); render with the inverse
  const Hk = (k: number) => {
    const s = k / 9;
    const a = 0.12 * s, sc = 1 - 0.15 * s, px = 0.0006 * s;
    return [sc * Math.cos(a), -sc * Math.sin(a), 20 * s, sc * Math.sin(a), sc * Math.cos(a), 12 * s, px, -0.0003 * s, 1];
  };
  const inv = (m: number[]) => {
    const [a, b, c, d, e, g, h, i, j] = m;
    const A = e * j - g * i, B = -(d * j - g * h), C = d * i - e * h;
    const det = a * A + b * B + c * C;
    return [A / det, -(b * j - c * i) / det, (b * g - c * e) / det, B / det, (a * j - c * h) / det, -(a * g - c * d) / det, C / det, -(a * i - b * h) / det, (a * e - b * d) / det];
  };
  const frames = Array.from({ length: 10 }, (_, k) => {
    const Hi = inv(Hk(k));
    return buildPyramid(render(f, W, H, (x, y) => applyH(Hi, x, y)), 4);
  });
  const quad = [140, 100, 340, 110, 330, 260, 150, 250];
  const tr = new PlanarTracker(frames[0], quad);
  let last = null;
  for (let k = 1; k < 10; k++) last = tr.step(frames[k]);
  assert.ok(last, 'tracking failed');
  const Hl = Hk(9);
  for (let c = 0; c < 4; c++) {
    const want = applyH(Hl, quad[c * 2], quad[c * 2 + 1]);
    const err = Math.hypot(last!.quad[c * 2] - want[0], last!.quad[c * 2 + 1] - want[1]);
    assert.ok(err < 0.25, `corner ${c} error ${err}`);
  }
  assert.ok(last!.confidence > 0.6, `confidence ${last!.confidence}`);
});

test('point tracker with adaptive template follows a drifting feature', () => {
  const f = texture(29);
  const frames = Array.from({ length: 8 }, (_, k) => buildPyramid(render(f, 320, 240, (x, y) => [x - 6 * k - 0.3 * k * k, y + 4.5 * k]), 4));
  const tr = new PointTracker(frames[0], [{ id: 'a', x: 120, y: 120, featureW: 31, featureH: 31, searchOffX: 0, searchOffY: 0, searchW: 90, searchH: 90 }],
    { adaptFeature: false, predictMotion: true, subpixel: true, confidenceThreshold: 80, onLowConfidence: 'adapt' });
  let r = null;
  for (let k = 1; k < 8; k++) r = tr.step(frames[k])[0];
  assert.ok(Math.abs(r!.x - (120 + 42 + 0.3 * 49)) < 0.15, `x ${r!.x}`);
  assert.ok(Math.abs(r!.y - (120 - 31.5)) < 0.15, `y ${r!.y}`);
  assert.ok(r!.confidence > 95);
});

test('contour tracing, resampling and distance transform', () => {
  const w = 64, h = 48;
  const a = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = Math.hypot(x - 30, y - 22) - 14;
    a[y * w + x] = Math.max(0, Math.min(255, Math.round(128 - d * 128)));
    if (x > 52 && y > 38) a[y * w + x] = 255; // a second blob
  }
  const cs = traceContours(a, w, h);
  assert.equal(cs.length, 2);
  const area = Math.abs(polygonArea(cs[0]));
  assert.ok(Math.abs(area - Math.PI * 14 * 14) < 12, `area ${area}`);
  const rs = resampleClosed(cs[0], 32);
  for (const [x, y] of rs) assert.ok(Math.abs(Math.hypot(x - 30, y - 22) - 14) < 0.35);
  const dt = distanceTransform(a, w, h);
  assert.ok(Math.abs(Math.sqrt(dt[22 * w + 30]) - 14.5) < 1.1);
  const kept = keepComponents(a, w, h, [[30, 22]]);
  assert.equal(kept[45 * w + 60], 0);
  assert.ok(kept[22 * w + 30] > 200);
});
