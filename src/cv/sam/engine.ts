// ─────────────────────────────────────────────────────────────────────────────
// SAM 2 (Segment Anything 2, Hiera-Tiny) inference engine — environment
// agnostic: it receives an onnxruntime module and two sessions, so the same
// code runs in the browser worker (onnxruntime-web, WebGPU/WASM) and in node
// tests.
//
// Model I/O (onnx-community/sam2.1-hiera-tiny-ONNX):
//   vision_encoder:  pixel_values [1,3,1024,1024] (ImageNet-normalised RGB,
//                    frame resized to 1024² without preserving aspect)
//                 →  image_embeddings.0 [1,32,256,256], .1 [1,64,128,128],
//                    .2 [1,256,64,64]
//   prompt_encoder_mask_decoder: input_points [1,1,N,2] (1024² space),
//                    input_labels [1,1,N] int64, input_boxes [1,B,4], the
//                    three embeddings → pred_masks [1,1,3,256,256] logits,
//                    iou_scores [1,1,3], object_score_logits [1,1,1]
//
// Temporal propagation (video): the decoder has no memory-attention input in
// this export, so the previous frame's result is carried forward as prompts:
// a sparse KLT flow field between consecutive frames warps the previous matte
// (RANSAC homography over features inside the object), the warped matte
// yields a box prompt plus positive points at its distance-transform maxima,
// and tracked background features just outside it become negative points.
// Among SAM's three hypotheses the one most consistent with the warped matte
// (and SAM's own IoU estimate) wins; a collapsing object score stops the run.
// ─────────────────────────────────────────────────────────────────────────────

import { buildPyramid, toGray, type Pyramid } from '../image';
import { detectCorners } from '../features';
import { trackFlow } from '../klt';
import { homographyRansac } from '../homography';
import { distanceTransform, iou, keepComponents, maskArea, maskBounds, warpMask, warpPoints, type Pt } from '../mask';

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface OrtTensor {
  data: any;
  dims: readonly number[];
  dispose?: () => void;
}
export interface OrtModule {
  Tensor: new (type: any, data: any, dims: readonly number[]) => OrtTensor;
}
export interface OrtSession {
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
}

export interface Embedding {
  e0: OrtTensor;
  e1: OrtTensor;
  e2: OrtTensor;
}

const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
const S = 1024;

/** RGBA8 (w×h) → normalised CHW float tensor data at 1024×1024 (bilinear). */
export function preprocess(rgba: ArrayLike<number>, w: number, h: number): Float32Array {
  const out = new Float32Array(3 * S * S);
  const sx = w / S, sy = h / S;
  const plane = S * S;
  for (let y = 0; y < S; y++) {
    let fy = (y + 0.5) * sy - 0.5;
    if (fy < 0) fy = 0;
    const y0 = Math.min(h - 1, fy | 0), y1 = Math.min(h - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < S; x++) {
      let fx = (x + 0.5) * sx - 0.5;
      if (fx < 0) fx = 0;
      const x0 = Math.min(w - 1, fx | 0), x1 = Math.min(w - 1, x0 + 1), tx = fx - x0;
      const a = (y0 * w + x0) * 4, b = (y0 * w + x1) * 4, c = (y1 * w + x0) * 4, d = (y1 * w + x1) * 4;
      const o = y * S + x;
      for (let k = 0; k < 3; k++) {
        const top = rgba[a + k] + (rgba[b + k] - rgba[a + k]) * tx;
        const bot = rgba[c + k] + (rgba[d + k] - rgba[c + k]) * tx;
        out[k * plane + o] = ((top + (bot - top) * ty) / 255 - MEAN[k]) / STD[k];
      }
    }
  }
  return out;
}

/** Bilinear upsample of a 256² logit map to the matte raster, then sigmoid → 8-bit alpha. */
export function logitsToAlpha(logits: ArrayLike<number>, offset: number, mw: number, mh: number): Uint8Array {
  const N = 256;
  const out = new Uint8Array(mw * mh);
  const sx = N / mw, sy = N / mh;
  for (let y = 0; y < mh; y++) {
    let fy = (y + 0.5) * sy - 0.5;
    if (fy < 0) fy = 0;
    const y0 = Math.min(N - 1, fy | 0), y1 = Math.min(N - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < mw; x++) {
      let fx = (x + 0.5) * sx - 0.5;
      if (fx < 0) fx = 0;
      const x0 = Math.min(N - 1, fx | 0), x1 = Math.min(N - 1, x0 + 1), tx = fx - x0;
      const a = logits[offset + y0 * N + x0], b = logits[offset + y0 * N + x1];
      const c = logits[offset + y1 * N + x0], d = logits[offset + y1 * N + x1];
      const l = a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
      out[y * mw + x] = Math.round(255 / (1 + Math.exp(-l)));
    }
  }
  return out;
}

export interface DecodeResult {
  /** the three hypotheses as alpha mattes */
  masks: Uint8Array[];
  iou: number[];
  objectScore: number;
}

export class SamEngine {
  constructor(private ort: OrtModule, private encoder: OrtSession, private decoder: OrtSession) {}

  async encode(rgba: ArrayLike<number>, w: number, h: number): Promise<Embedding> {
    const px = preprocess(rgba, w, h);
    const out = await this.encoder.run({ pixel_values: new this.ort.Tensor('float32', px, [1, 3, S, S]) });
    return { e0: out['image_embeddings.0'], e1: out['image_embeddings.1'], e2: out['image_embeddings.2'] };
  }

  /** Points/box in matte pixels (matte raster mw×mh covers the whole frame). */
  async decode(emb: Embedding, points: [number, number, number][], box: [number, number, number, number] | null, mw: number, mh: number): Promise<DecodeResult> {
    const kx = S / mw, ky = S / mh;
    const pts = new Float32Array(points.length * 2);
    const labels = new BigInt64Array(points.length);
    points.forEach(([x, y, l], i) => {
      pts[i * 2] = x * kx;
      pts[i * 2 + 1] = y * ky;
      labels[i] = BigInt(l ? 1 : 0);
    });
    const boxes = box ? Float32Array.of(box[0] * kx, box[1] * ky, box[2] * kx, box[3] * ky) : new Float32Array(0);
    const T = this.ort.Tensor;
    const out = await this.decoder.run({
      input_points: new T('float32', pts, [1, 1, points.length, 2]),
      input_labels: new T('int64', labels, [1, 1, points.length]),
      input_boxes: new T('float32', boxes, [1, box ? 1 : 0, 4]),
      'image_embeddings.0': emb.e0,
      'image_embeddings.1': emb.e1,
      'image_embeddings.2': emb.e2,
    });
    const pm = out.pred_masks;
    const n = pm.dims[2];
    const masks: Uint8Array[] = [];
    for (let k = 0; k < n; k++) masks.push(logitsToAlpha(pm.data as Float32Array, k * 256 * 256, mw, mh));
    const iouData = out.iou_scores.data as Float32Array;
    const res = { masks, iou: Array.from(iouData).slice(0, n), objectScore: (out.object_score_logits.data as Float32Array)[0] };
    for (const t of Object.values(out)) t.dispose?.();
    return res;
  }
}

export function disposeEmbedding(e: Embedding): void {
  e.e0.dispose?.();
  e.e1.dispose?.();
  e.e2.dispose?.();
}

/** Pick SAM's best hypothesis for an interactive prompt and clean up stray islands. */
export function chooseInteractive(r: DecodeResult, points: [number, number, number][], mw: number, mh: number): { mask: Uint8Array; score: number } {
  let best = 0;
  for (let k = 1; k < r.masks.length; k++) if (r.iou[k] > r.iou[best]) best = k;
  const seeds: Pt[] = points.filter((p) => p[2]).map((p) => [p[0], p[1]]);
  const mask = seeds.length ? keepComponents(r.masks[best], mw, mh, seeds) : r.masks[best];
  return { mask, score: r.iou[best] };
}

// ── propagation ─────────────────────────────────────────────────────────────

export interface PropagationStep {
  points: [number, number, number][];
  box: [number, number, number, number];
  /** previous matte warped into the current frame */
  warped: Uint8Array;
}

export function grayPyramid(rgba: ArrayLike<number>, w: number, h: number): Pyramid {
  return buildPyramid(toGray(rgba, w, h), 4);
}

/** Derive prompts for frame B from the matte of frame A and the A→B flow. */
export function propagatePrompts(prevMask: Uint8Array, prev: Pyramid, cur: Pyramid, w: number, h: number, carried: [number, number, number][]): PropagationStep | null {
  const bb = maskBounds(prevMask, w, h);
  if (!bb) return null;
  const bw = bb[2] - bb[0], bh = bb[3] - bb[1];
  const mx = bw * 0.35 + 12, my = bh * 0.35 + 12;
  const region = [bb[0] - mx, bb[1] - my, bb[2] + mx, bb[3] + my];
  const area = Math.max(1, bw * bh);
  const corners = detectCorners(prev.levels[0], {
    maxCorners: 260, minDistance: Math.max(3, Math.sqrt(area / 220)), quality: 0.004, border: 4,
    mask: (x, y) => x >= region[0] && y >= region[1] && x <= region[2] && y <= region[3],
  });
  const src = new Float32Array(corners.flatMap((c) => [c.x, c.y]));
  const flow = trackFlow(prev, cur, src, { radius: 6, fbThreshold: 1.2, maxResidual: 40 });
  const inS: number[] = [], inD: number[] = [], outD: Pt[] = [];
  for (let i = 0; i < corners.length; i++) {
    if (!flow.status[i]) continue;
    const x = Math.round(src[i * 2]), y = Math.round(src[i * 2 + 1]);
    const inside = prevMask[y * w + x] >= 128;
    if (inside) {
      inS.push(src[i * 2], src[i * 2 + 1]);
      inD.push(flow.pts[i * 2], flow.pts[i * 2 + 1]);
    } else outD.push([flow.pts[i * 2], flow.pts[i * 2 + 1]]);
  }
  // object motion model: homography over interior features, else their median translation
  let H: number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const hr = inS.length >= 16 ? homographyRansac(inS, inD, { threshold: 2.5, maxIter: 300 }) : null;
  if (hr && hr.count >= 8) H = Array.from(hr.H);
  else if (inS.length >= 2) {
    const dx: number[] = [], dy: number[] = [];
    for (let i = 0; i < inS.length; i += 2) {
      dx.push(inD[i] - inS[i]);
      dy.push(inD[i + 1] - inS[i + 1]);
    }
    dx.sort((a, b) => a - b);
    dy.sort((a, b) => a - b);
    H = [1, 0, dx[dx.length >> 1], 0, 1, dy[dy.length >> 1], 0, 0, 1];
  }
  const warped = warpMask(prevMask, w, h, H);
  const wb = maskBounds(warped, w, h);
  if (!wb) return null;
  // positive points: well-separated maxima of the interior distance transform
  const dt = distanceTransform(warped, w, h);
  const pos: [number, number, number][] = [];
  const taken: Pt[] = [];
  const sep2 = Math.pow(Math.max(6, Math.sqrt(maskArea(warped)) * 0.35), 2);
  for (let k = 0; k < 3; k++) {
    let best = -1, bd = 0;
    for (let y = wb[1]; y < wb[3]; y++) for (let x = wb[0]; x < wb[2]; x++) {
      const i = y * w + x;
      if (dt[i] <= bd) continue;
      if (taken.some(([tx, ty]) => (tx - x) ** 2 + (ty - y) ** 2 < sep2)) continue;
      bd = dt[i];
      best = i;
    }
    if (best < 0 || bd < (k === 0 ? 1 : 9)) break;
    const p: Pt = [best % w, (best / w) | 0];
    taken.push(p);
    pos.push([p[0], p[1], 1]);
  }
  // carried user prompts that still land on the right side of the warped matte
  for (const [x, y, l] of warpPoints(carried.map((c) => [c[0], c[1]] as Pt), H).map((p, i) => [p[0], p[1], carried[i][2]] as [number, number, number])) {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= w || yi >= h) continue;
    const inside = warped[yi * w + xi] >= 128;
    if ((l === 1) === inside && pos.length < 6) pos.push([x, y, l]);
  }
  // negative points: tracked background features hugging the object
  const outside = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) outside[i] = warped[i] >= 128 ? 0 : 255;
  const dto = distanceTransform(outside, w, h);
  const margin = Math.max(5, Math.sqrt(maskArea(warped)) * 0.06);
  const neg = outD
    .filter(([x, y]) => x >= 0 && y >= 0 && x < w && y < h)
    .map(([x, y]) => ({ x, y, d: Math.sqrt(dto[Math.round(y) * w + Math.round(x)]) }))
    .filter((p) => p.d > margin && p.d < margin * 6)
    .sort((a, b) => a.d - b.d);
  const negSel: [number, number, number][] = [];
  for (const p of neg) {
    if (negSel.length >= 3) break;
    if (negSel.some(([x, y]) => (x - p.x) ** 2 + (y - p.y) ** 2 < sep2)) continue;
    negSel.push([p.x, p.y, 0]);
  }
  const pad = 0.06;
  const box: [number, number, number, number] = [
    Math.max(0, wb[0] - (wb[2] - wb[0]) * pad - 3), Math.max(0, wb[1] - (wb[3] - wb[1]) * pad - 3),
    Math.min(w, wb[2] + (wb[2] - wb[0]) * pad + 3), Math.min(h, wb[3] + (wb[3] - wb[1]) * pad + 3),
  ];
  return { points: [...pos, ...negSel], box, warped };
}

/** Select the hypothesis that best continues the previous matte. Returns null when the object is lost. */
export function choosePropagated(r: DecodeResult, step: PropagationStep, w: number, h: number): { mask: Uint8Array; score: number } | null {
  let best = -1, bestScore = -Infinity, bestIou = 0;
  for (let k = 0; k < r.masks.length; k++) {
    const j = iou(r.masks[k], step.warped);
    const sc = 0.65 * j + 0.35 * r.iou[k];
    if (sc > bestScore) {
      bestScore = sc;
      best = k;
      bestIou = j;
    }
  }
  if (best < 0) return null;
  if (r.objectScore < -1 && bestIou < 0.35) return null;
  if (bestIou < 0.12) return null;
  const seeds: Pt[] = step.points.filter((p) => p[2]).map((p) => [p[0], p[1]]);
  const mask = seeds.length ? keepComponents(r.masks[best], w, h, seeds) : r.masks[best];
  if (maskArea(mask) < 4) return null;
  return { mask, score: bestScore };
}
