import { test } from 'node:test';
import assert from 'node:assert/strict';
import { svd, symEig, choleskySolve, eulerXYZToMat, matToEulerXYZ, rodrigues, rotationLog, mat3Mul, mat3T } from '../src/cv/linalg';
import { buildPyramid } from '../src/cv/image';
import { detectCorners } from '../src/cv/features';
import { makeTemplate, trackFeature, trackFlow } from '../src/cv/klt';
import { render, texture } from './cvsynth';

const near = (a: number, b: number, eps: number, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} ≉ ${b} (±${eps})`);

test('SVD reconstructs a random matrix and finds the null space', () => {
  const m = 5, n = 4;
  const A = Float64Array.from({ length: m * n }, (_, i) => Math.sin(i * 1.7) * 3 + (i % 3));
  const { U, S, V } = svd(A, m, n);
  for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) {
    let s = 0;
    for (let k = 0; k < n; k++) s += U[i * n + k] * S[k] * V[j * n + k];
    near(s, A[i * n + j], 1e-9);
  }
  // rank-deficient 3x4 → null vector
  const B = [1, 2, 3, 4, 2, 4, 1, 3, 0, 1, 1, 1];
  const r = svd(B, 3, 4);
  const x = [0, 1, 2, 3].map((i) => r.V[i * 4 + 3]);
  for (let i = 0; i < 3; i++) near(B[i * 4] * x[0] + B[i * 4 + 1] * x[1] + B[i * 4 + 2] * x[2] + B[i * 4 + 3] * x[3], 0, 1e-10);
});

test('symmetric eigen decomposition and Cholesky', () => {
  const A = [4, 1, 0.5, 1, 3, 0.2, 0.5, 0.2, 2];
  const { values, vectors } = symEig(A, 3);
  for (let k = 0; k < 3; k++) {
    const v = [vectors[k], vectors[3 + k], vectors[6 + k]];
    for (let i = 0; i < 3; i++) near(A[i * 3] * v[0] + A[i * 3 + 1] * v[1] + A[i * 3 + 2] * v[2], values[k] * v[i], 1e-10);
  }
  const x = choleskySolve(A, [1, 2, 3], 3)!;
  for (let i = 0; i < 3; i++) near(A[i * 3] * x[0] + A[i * 3 + 1] * x[1] + A[i * 3 + 2] * x[2], [1, 2, 3][i], 1e-10);
});

test('rotation helpers round-trip (Rodrigues, AE Euler order)', () => {
  const R = rodrigues([0.3, -0.5, 0.2]);
  const w = rotationLog(R);
  near(w[0], 0.3, 1e-9); near(w[1], -0.5, 1e-9); near(w[2], 0.2, 1e-9);
  const I = mat3Mul(R, mat3T(R));
  for (let i = 0; i < 9; i++) near(I[i], i % 4 === 0 ? 1 : 0, 1e-12);
  const e = matToEulerXYZ(eulerXYZToMat(12, -33, 71));
  near(e[0], 12, 1e-9); near(e[1], -33, 1e-9); near(e[2], 71, 1e-9);
  // continuity: the solution nearest a previous frame is chosen
  const e2 = matToEulerXYZ(eulerXYZToMat(190, 10, -5), [185, 12, -3]);
  near(e2[0], 190, 1e-6); near(e2[1], 10, 1e-6); near(e2[2], -5, 1e-6);
});

test('corner detection is well distributed', () => {
  const img = render(texture(3), 320, 240);
  for (const method of ['fast', 'shi-tomasi'] as const) {
    const cs = detectCorners(img, { maxCorners: 120, minDistance: 10, method });
    assert.ok(cs.length > 60, `${method}: only ${cs.length} corners`);
    for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++)
      assert.ok(Math.hypot(cs[i].x - cs[j].x, cs[i].y - cs[j].y) >= 10);
  }
});

test('pyramidal KLT recovers a large sub-pixel translation', () => {
  const f = texture(11);
  const dx = 23.37, dy = -14.81;
  const a = render(f, 320, 240), b = render(f, 320, 240, (x, y) => [x - dx, y - dy]);
  const pa = buildPyramid(a, 4), pb = buildPyramid(b, 4);
  const cs = detectCorners(a, { maxCorners: 80, minDistance: 12, border: 40 });
  const pts = new Float32Array(cs.flatMap((c) => [c.x, c.y]));
  const r = trackFlow(pa, pb, pts, { radius: 7 });
  let ok = 0, errSum = 0;
  for (let i = 0; i < cs.length; i++) {
    if (!r.status[i]) continue;
    ok++;
    errSum += Math.hypot(r.pts[i * 2] - pts[i * 2] - dx, r.pts[i * 2 + 1] - pts[i * 2 + 1] - dy);
  }
  assert.ok(ok > cs.length * 0.7, `tracked ${ok}/${cs.length}`);
  assert.ok(errSum / ok < 0.08, `mean error ${errSum / ok}`);
});

test('feature-region tracker: NCC search + sub-pixel refinement under gain change', () => {
  const f = texture(5);
  const dx = 31.6, dy = 18.2;
  const a = render(f, 400, 300), b = render((x, y) => f(x, y) * 0.8 + 20, 400, 300, (x, y) => [x - dx, y - dy]);
  const pa = buildPyramid(a, 5), pb = buildPyramid(b, 5);
  const tpl = makeTemplate(pa, 180, 140, 41, 41);
  const m = trackFeature(tpl, pb, { cx: 180, cy: 140, offX: 0, offY: 0, searchW: 140, searchH: 140 });
  near(m.x, 180 + dx, 0.08, 'x');
  near(m.y, 140 + dy, 0.08, 'y');
  assert.ok(m.ncc > 0.97, `ncc ${m.ncc}`);
});
