// Message protocol between the UI thread (RenderHost) and the render worker (RenderServer).

import type { Project, RGBA } from '../core/types';
import type { RenderOptions } from './renderer';

export type RenderPurpose = 'view' | 'cache' | 'thumb' | 'analysis';

export interface FontSpec {
  family: string;
  url: string;
  weight?: string;
  style?: string;
}

export type ExportFormat = 'mp4' | 'webm' | 'webm-alpha' | 'gif' | 'png';

export interface ExportJob {
  jobId: string;
  compId: string;
  format: ExportFormat;
  start: number;
  end: number;
  scale: number;
  quality: 'low' | 'medium' | 'high' | 'very-high';
  motionBlur: boolean;
  filename: string;
  /** pre-mixed audio (main thread OfflineAudioContext) */
  audio?: { channels: Float32Array[]; sampleRate: number } | null;
  gifFps?: number;
}

export type ToWorker =
  | { type: 'init'; fonts: FontSpec[] }
  | { type: 'project'; project: Project }
  | { type: 'image'; id: string; bitmap: ImageBitmap }
  | { type: 'video'; id: string; blob: Blob }
  | { type: 'audio'; id: string; channels: Float32Array[]; sampleRate: number }
  | { type: 'font'; family: string; buffer: ArrayBuffer; descriptors?: { weight?: string; style?: string } }
  | { type: 'removeAsset'; id: string }
  | { type: 'render'; id: number; key: string; purpose: RenderPurpose; opts: RenderOptions; bg: RGBA | null; maxSize?: number }
  | { type: 'cancel'; purpose: RenderPurpose; keepIds?: number[] }
  | { type: 'export'; job: ExportJob }
  | { type: 'cancelExport'; jobId: string }
  | { type: 'videoFrameReply'; reqId: number; bitmap: ImageBitmap | null }
  /** a MessagePort over which a CV worker requests analysis frames (see cv/protocol.ts) */
  | { type: 'analysisPort'; port: MessagePort }
  /** roto matte revision, deflate-compressed 8-bit alpha */
  | { type: 'matte'; id: string; rev: number; w: number; h: number; data: Uint8Array }
  | { type: 'dropMatte'; id: string; revs?: number[] }
  /** decode every video with the software decoder (works around hardware-decoder stalls) */
  | { type: 'videoDecodePrefs'; preferSoftware: boolean };

export interface WorkerCaps {
  webgl2: boolean;
  floatRender: boolean;
  maxTex: number;
  webcodecs: boolean;
  offscreen: boolean;
}

/** Per-footage video decode statistics (worker → UI, throttled). */
export interface VideoDecodeStats {
  /** 'pending' until the demuxer has opened the file */
  path: 'pending' | 'webcodecs' | 'fallback' | 'failed';
  codec: string | null;
  /** frames decoded (WebCodecs) or grabbed (fallback) */
  decoded: number;
  /** total decode time for those frames, ms */
  decodeMs: number;
  /** iterator restarts (each costs a decode from the previous keyframe) */
  seeks: number;
  /** requests served from the decoded-frame cache */
  hits: number;
  reason: string | null;
  /** 'auto' lets the browser use the GPU decoder; 'software' after a hardware stall or by preference */
  accel: 'auto' | 'software';
}

export type FromWorker =
  | { type: 'ready'; caps: WorkerCaps }
  | { type: 'fatal'; message: string }
  | { type: 'frame'; id: number; key: string; purpose: RenderPurpose; bitmap: ImageBitmap; ms: number; layers: number; errors: [string, string][]; time: number; compId: string }
  | { type: 'renderError'; id: number; key: string; message: string }
  | { type: 'cancelled'; ids: number[] }
  | { type: 'needVideoFrame'; reqId: number; footageId: string; time: number; fps: number }
  | { type: 'exportProgress'; jobId: string; frame: number; total: number; preview: ImageBitmap | null; fps: number }
  | { type: 'exportDone'; jobId: string; blob: Blob; filename: string }
  | { type: 'exportError'; jobId: string; message: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'mediaStats'; stats: Record<string, VideoDecodeStats> };
