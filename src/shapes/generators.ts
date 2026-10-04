// Parametric shape → Bézier path generators. Vertex order and start points match After Effects
// (rectangles start at the top-right going clockwise, ellipses & polystars start at 12 o'clock),
// which matters for Trim Paths and other order-dependent operators.

import type { BezierPath, Vec2 } from '../core/types';
import { reversePath } from './path';

const KAPPA = 0.5522847498307936;

export function rectToPath(size: number[], position: number[], roundness: number, reversed: boolean): BezierPath {
  const hw = Math.abs(size[0]) / 2, hh = Math.abs(size[1]) / 2;
  const x = position[0], y = position[1];
  const r = Math.max(0, Math.min(roundness, hw, hh));
  let p: BezierPath;
  if (r <= 1e-6) {
    p = {
      closed: true,
      v: [[x + hw, y - hh], [x + hw, y + hh], [x - hw, y + hh], [x - hw, y - hh]],
      i: [[0, 0], [0, 0], [0, 0], [0, 0]],
      o: [[0, 0], [0, 0], [0, 0], [0, 0]],
    };
  } else {
    const k = r * KAPPA;
    p = {
      closed: true,
      v: [
        [x + hw, y - hh + r], [x + hw, y + hh - r], [x + hw - r, y + hh], [x - hw + r, y + hh],
        [x - hw, y + hh - r], [x - hw, y - hh + r], [x - hw + r, y - hh], [x + hw - r, y - hh],
      ],
      i: [[0, -k], [0, 0], [k, 0], [0, 0], [0, k], [0, 0], [-k, 0], [0, 0]],
      o: [[0, 0], [0, k], [0, 0], [-k, 0], [0, 0], [0, -k], [0, 0], [k, 0]],
    };
  }
  return reversed ? reversePath(p) : p;
}

export function ellipseToPath(size: number[], position: number[], reversed: boolean): BezierPath {
  const rx = Math.abs(size[0]) / 2, ry = Math.abs(size[1]) / 2;
  const x = position[0], y = position[1];
  const kx = rx * KAPPA, ky = ry * KAPPA;
  const p: BezierPath = {
    closed: true,
    v: [[x, y - ry], [x + rx, y], [x, y + ry], [x - rx, y]],
    i: [[-kx, 0], [0, -ky], [kx, 0], [0, ky]],
    o: [[kx, 0], [0, ky], [-kx, 0], [0, -ky]],
  };
  return reversed ? reversePath(p) : p;
}

export function polystarToPath(
  starType: 'star' | 'polygon', points: number, position: number[], rotation: number,
  innerRadius: number, outerRadius: number, innerRoundness: number, outerRoundness: number, reversed: boolean,
): BezierPath {
  const n = Math.max(3, Math.floor(points));
  const isStar = starType === 'star';
  const numPts = isStar ? n * 2 : n;
  const angle = (Math.PI * 2) / numPts;
  let cur = -Math.PI / 2 + (rotation * Math.PI) / 180;
  const v: Vec2[] = [], ii: Vec2[] = [], oo: Vec2[] = [];
  const longPerim = (2 * Math.PI * outerRadius) / (numPts * 2);
  const shortPerim = (2 * Math.PI * innerRadius) / (numPts * 2);
  // AE rounds polygons with a slightly larger factor than stars
  const roundFactor = isStar ? 1 : 2;
  let long = true;
  for (let k = 0; k < numPts; k++) {
    const rad = isStar ? (long ? outerRadius : innerRadius) : outerRadius;
    const round = (isStar ? (long ? outerRoundness : innerRoundness) : outerRoundness) / 100;
    const perim = (isStar ? (long ? longPerim : shortPerim) : longPerim) * roundFactor;
    const cx = rad * Math.cos(cur), cy = rad * Math.sin(cur);
    const len = Math.hypot(cx, cy);
    const ox = len === 0 ? 0 : cy / len;
    const oy = len === 0 ? 0 : -cx / len;
    v.push([cx + position[0], cy + position[1]]);
    oo.push([-ox * perim * round, -oy * perim * round]);
    ii.push([ox * perim * round, oy * perim * round]);
    long = !long;
    cur += angle;
  }
  const p: BezierPath = { closed: true, v, i: ii, o: oo };
  return reversed ? reversePath(p) : p;
}
