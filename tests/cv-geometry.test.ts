import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyH, homographyRansac } from '../src/cv/homography';
import { essentialRansac, recoverPose, pnpRansac, project, cameraCenter, type Pose } from '../src/cv/geometry3d';
import { eulerXYZToMat, mat3T, mat3Vec, rng, type V3 } from '../src/cv/linalg';
import { solveCamera, type Track2D } from '../src/cv/sfm';

const near = (a: number, b: number, eps: number, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} ≉ ${b} (±${eps})`);

function gauss(r: () => number): number {
  return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
}

test('homography RANSAC rejects 30% outliers', () => {
  const H = [1.1, 0.05, 12, -0.03, 0.95, -7, 0.0004, -0.0002, 1];
  const r = rng(5);
  const n = 120;
  const src = new Float64Array(n * 2), dst = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    const x = r() * 640, y = r() * 480;
    src[i * 2] = x; src[i * 2 + 1] = y;
    const [u, v] = applyH(H, x, y);
    const out = i % 10 < 3;
    dst[i * 2] = out ? r() * 640 : u + gauss(r) * 0.3;
    dst[i * 2 + 1] = out ? r() * 480 : v + gauss(r) * 0.3;
  }
  const res = homographyRansac(src, dst, { threshold: 2 })!;
  assert.ok(res.count >= 80 && res.count <= 86, `inliers ${res.count}`);
  for (const [x, y] of [[0, 0], [640, 480], [320, 100]]) {
    const a = applyH(H, x, y), b = applyH(res.H, x, y);
    near(a[0], b[0], 0.6); near(a[1], b[1], 0.6);
  }
});

interface Scene { points: V3[]; poses: Pose[]; f: number; W: number; H: number }

function makeScene(frames: number, opts: { tripod?: boolean; f?: number } = {}): Scene {
  const r = rng(21);
  const W = 960, H = 540, f = opts.f ?? 800;
  const points: V3[] = [];
  for (let i = 0; i < 900; i++) points.push([(r() - 0.5) * 16, (r() - 0.5) * 7 + 1, 6 + r() * 14]);
  // ground plane points
  for (let i = 0; i < 300; i++) points.push([(r() - 0.5) * 20, 3, 4 + r() * 18]);
  const poses: Pose[] = [];
  for (let k = 0; k < frames; k++) {
    const s = k / (frames - 1);
    const C: V3 = opts.tripod ? [0, 0, 0] : [-2.5 + 5 * s, -0.3 * Math.sin(s * 3), 0.8 * s];
    const R = mat3T(eulerXYZToMat(3 * Math.sin(s * 2), -12 * s + 4, 2 * Math.sin(s * 5)));
    const Rc = mat3Vec(R, C);
    poses.push({ R, t: [-Rc[0], -Rc[1], -Rc[2]] });
  }
  return { points, poses, f, W, H };
}

function tracksFrom(sc: Scene, noise = 0.25): Track2D[] {
  const r = rng(3);
  const K = { f: sc.f, cx: sc.W / 2, cy: sc.H / 2 };
  return sc.points.map((X, id) => {
    const xy = new Float32Array(sc.poses.length * 2).fill(NaN);
    let alive = false, ended = false;
    sc.poses.forEach((P, k) => {
      if (ended) return;
      const [u, v, z] = project(P, K, X);
      const vis = z > 0.5 && u > 5 && v > 5 && u < sc.W - 5 && v < sc.H - 5;
      if (vis) {
        xy[k * 2] = u + gauss(r) * noise;
        xy[k * 2 + 1] = v + gauss(r) * noise;
        alive = true;
      } else if (alive) ended = true; // tracks never resurrect, like KLT tracks
    });
    return { id, xy, color: [200, 200, 200] as [number, number, number] };
  });
}

test('two-view essential matrix + pose recovery', () => {
  const sc = makeScene(30);
  const K = { f: sc.f, cx: sc.W / 2, cy: sc.H / 2 };
  const a = sc.poses[0], b = sc.poses[20];
  const n1: number[] = [], n2: number[] = [];
  for (const X of sc.points) {
    const p = project(a, K, X), q = project(b, K, X);
    if (p[2] <= 0 || q[2] <= 0) continue;
    n1.push((p[0] - K.cx) / K.f, (p[1] - K.cy) / K.f);
    n2.push((q[0] - K.cx) / K.f, (q[1] - K.cy) / K.f);
  }
  const E = essentialRansac(n1, n2, 1 / K.f)!;
  const rp = recoverPose(E.E, n1, n2, E.inliers, 3 / K.f)!;
  assert.ok(rp.goodCount > (n1.length / 2) * 0.9, `good ${rp.goodCount} inl ${E.count} of ${n1.length / 2}`);
  // relative rotation matches ground truth
  const RbRaT = (() => { const A = b.R, B = mat3T(a.R); const o = new Float64Array(9); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j]; return o; })();
  for (let i = 0; i < 9; i++) near(rp.pose.R[i], RbRaT[i], 2e-3, `R${i}`);
});

test('PnP RANSAC recovers a pose with outliers', () => {
  const sc = makeScene(10);
  const K = { f: sc.f, cx: sc.W / 2, cy: sc.H / 2 };
  const P = sc.poses[6];
  const r = rng(8);
  const X: number[] = [], uv: number[] = [], idx: number[] = [];
  for (const p of sc.points.slice(0, 200)) {
    const q = project(P, K, p);
    if (q[2] <= 0) continue;
    idx.push(idx.length);
    X.push(...p);
    const bad = r() < 0.2;
    uv.push(bad ? r() * sc.W : q[0] + gauss(r) * 0.3, bad ? r() * sc.H : q[1] + gauss(r) * 0.3);
  }
  const res = pnpRansac(X, uv, idx, K)!;
  const c1 = cameraCenter(res.pose), c0 = cameraCenter(P);
  near(c1[0], c0[0], 0.03); near(c1[1], c0[1], 0.03); near(c1[2], c0[2], 0.03);
});

function alignError(sc: Scene, res: ReturnType<typeof solveCamera>): number {
  // similarity-align solved centres to ground truth (Umeyama, scale from centroid spread)
  const A = res.cameras.map((c) => cameraCenter({ R: Float64Array.from(c.R), t: c.t }));
  const B = sc.poses.map((p) => cameraCenter(p));
  const n = A.length;
  const ca = [0, 0, 0], cb = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { ca[k] += A[i][k] / n; cb[k] += B[i][k] / n; }
  // rotation: solved world = first camera frame; ground truth world → first camera frame
  const R0 = sc.poses[0].R;
  const Bc = B.map((b) => mat3Vec(R0, [b[0] - cb[0], b[1] - cb[1], b[2] - cb[2]]));
  const Ac = A.map((a) => [a[0] - ca[0], a[1] - ca[1], a[2] - ca[2]]);
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += Math.hypot(...Ac[i]); sb += Math.hypot(...Bc[i]); }
  const s = sb / sa;
  let err = 0;
  for (let i = 0; i < n; i++) err += Math.hypot(Ac[i][0] * s - Bc[i][0], Ac[i][1] * s - Bc[i][1], Ac[i][2] * s - Bc[i][2]);
  return err / n / (sb / n);
}

test('camera solve: free move, unknown focal length', () => {
  const sc = makeScene(60);
  const res = solveCamera(tracksFrom(sc), { width: sc.W, height: sc.H, frameCount: 60, shotType: 'auto' });
  assert.equal(res.mode, 'free');
  assert.ok(res.rms < 0.8, `rms ${res.rms}`);
  near(res.f, sc.f, sc.f * 0.06, 'focal');
  assert.ok(res.cameras.every((c) => c.solved), 'all frames solved');
  const e = alignError(sc, res);
  assert.ok(e < 0.06, `relative trajectory error ${e}`);
});

test('camera solve: tripod pan detected and solved', () => {
  const sc = makeScene(45, { tripod: true, f: 1100 });
  const res = solveCamera(tracksFrom(sc), { width: sc.W, height: sc.H, frameCount: 45, shotType: 'auto' });
  assert.equal(res.mode, 'tripod');
  assert.ok(res.rms < 0.8, `rms ${res.rms}`);
  near(res.f, sc.f, sc.f * 0.08, 'focal');
});
