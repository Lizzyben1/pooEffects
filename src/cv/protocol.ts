// Messages exchanged over the dedicated MessageChannel between computer-vision workers (point,
// planar and camera trackers; SAM 2) and the render worker, which renders analysis frames.
// Pixels travel as transferable ArrayBuffers, never through the main thread.

import type { Composition } from '../core/types';

export type AnalysisRequest =
  /** register (or replace) a synthetic single-layer comp used to render a layer's source */
  | { type: 'comp'; key: string; comp: Composition }
  | { type: 'dropComp'; key: string }
  /** render `key` at comp time `time`, scaled by `scale` (≤ 1), and return RGBA8 pixels */
  | { type: 'frame'; reqId: number; key: string; time: number; scale: number };

export type AnalysisReply =
  | { type: 'frame'; reqId: number; width: number; height: number; pixels: ArrayBuffer }
  | { type: 'frameError'; reqId: number; message: string };
