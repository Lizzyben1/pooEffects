// Messages between the main thread (roto controller) and the SAM 2 inference worker.
// Mattes cross the boundary as transferable 8-bit alpha planes at matte resolution; prompt point
// coordinates are matte pixels.

import type { Composition } from '../../core/types';

export type SamVariant = 'fp16' | 'int8' | 'fp32';

export interface SamFrameRef {
  /** comp time to render */
  time: number;
  /** layer-time frame index */
  frame: number;
}

interface SamJobBase {
  jobId: string;
  key: string;
  comp: Composition;
  srcW: number;
  srcH: number;
  matteW: number;
  matteH: number;
}

export type ToSam =
  | { type: 'port'; port: MessagePort }
  | { type: 'load'; variant: SamVariant; baseUrl: string; local?: { encoder: ArrayBuffer; encoderData?: ArrayBuffer; decoder: ArrayBuffer; decoderData?: ArrayBuffer } }
  | (SamJobBase & { type: 'segment'; ref: SamFrameRef; points: [number, number, number][]; box: [number, number, number, number] | null })
  | (SamJobBase & { type: 'propagate'; seed: Uint8Array; seedRef: SamFrameRef; frames: SamFrameRef[]; points: [number, number, number][] })
  | { type: 'cancel'; jobId: string }
  | { type: 'clearCache' };

export type FromSam =
  | { type: 'loadProgress'; file: string; loaded: number; total: number }
  | { type: 'loaded'; provider: 'webgpu' | 'wasm'; variant: SamVariant; ms: number; cached: boolean }
  | { type: 'loadError'; message: string }
  | { type: 'mask'; jobId: string; ref: SamFrameRef; w: number; h: number; data: Uint8Array; score: number; points: [number, number, number][]; encodeMs: number; decodeMs: number }
  | { type: 'progress'; jobId: string; stage: string; fraction: number }
  | { type: 'done'; jobId: string; status: 'complete' | 'stopped' | 'cancelled' | 'error'; message?: string };

export const SAM_MODEL_BASE = 'https://huggingface.co/onnx-community/sam2.1-hiera-tiny-ONNX/resolve/main/onnx/';

export const SAM_VARIANTS: Record<SamVariant, { label: string; encoder: string; decoder: string; mb: number }> = {
  fp16: { label: 'Half precision (fp16) — best on WebGPU', encoder: 'vision_encoder_fp16', decoder: 'prompt_encoder_mask_decoder_fp16', mb: 78 },
  int8: { label: 'Quantized (int8) — smallest, best on CPU', encoder: 'vision_encoder_quantized', decoder: 'prompt_encoder_mask_decoder_quantized', mb: 62 },
  fp32: { label: 'Full precision (fp32) — reference quality', encoder: 'vision_encoder', decoder: 'prompt_encoder_mask_decoder', mb: 155 },
};

/** Matte raster for a source size: long edge ≤ 1024, rounded exactly like the renderer sizes frames. */
export function matteSize(srcW: number, srcH: number): { w: number; h: number; scale: number } {
  const scale = Math.min(1, 1024 / Math.max(srcW, srcH));
  return { w: Math.max(1, Math.round(srcW * scale)), h: Math.max(1, Math.round(srcH * scale)), scale };
}
