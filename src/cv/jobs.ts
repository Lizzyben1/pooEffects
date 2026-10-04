// Job protocol between the main thread (CVHost) and the tracking worker.
// All coordinates crossing this boundary are LAYER SOURCE pixels; the worker converts to and from
// its analysis raster internally.

import type { Composition, LowConfidenceAction, TrackChannel } from '../core/types';

export interface PointJobSpec {
  id: string;
  x: number;
  y: number;
  featureW: number;
  featureH: number;
  searchOffX: number;
  searchOffY: number;
  searchW: number;
  searchH: number;
}

interface JobBase {
  jobId: string;
  /** synthetic comp rendering the layer's source */
  key: string;
  comp: Composition;
  /** comp times to analyse, in processing order (times[0] = start frame) */
  times: number[];
  /** source width/height in pixels */
  srcW: number;
  srcH: number;
}

export interface TrackPointsJob extends JobBase {
  type: 'trackPoints';
  channel: TrackChannel;
  blur: number;
  points: PointJobSpec[];
  adaptFeature: boolean;
  predictMotion: boolean;
  subpixel: boolean;
  confidenceThreshold: number;
  onLowConfidence: LowConfidenceAction;
}

export interface TrackPlanarJob extends JobBase {
  type: 'trackPlanar';
  channel: TrackChannel;
  blur: number;
  /** UL, UR, LR, LL */
  quad: number[];
}

export interface TrackCameraJob extends JobBase {
  type: 'trackCamera';
  detail: 'low' | 'medium' | 'high';
  shotType: 'auto' | 'free' | 'tripod';
  fov: number | null;
}

export type CVJob = TrackPointsJob | TrackPlanarJob | TrackCameraJob;

export type ToCV =
  | { type: 'port'; port: MessagePort }
  | { type: 'run'; job: CVJob }
  | { type: 'cancel'; jobId: string };

export interface PointSample {
  id: string;
  x: number;
  y: number;
  confidence: number;
  stopped: boolean;
}

export interface CameraSolution {
  width: number;
  height: number;
  sourceScale: number;
  mode: 'free' | 'tripod';
  f: number;
  frames: { R: number[]; t: number[] }[];
  frameError: number[];
  points: { id: number; X: number[]; error: number; first: number; last: number; color: number[] }[];
  rms: number;
}

export type FromCV =
  | { type: 'pointSample'; jobId: string; index: number; time: number; points: PointSample[] }
  | { type: 'planarSample'; jobId: string; index: number; time: number; quad: number[]; confidence: number; features: number[] }
  /** live 2D features while the camera tracker analyses (source pixels) */
  | { type: 'cameraFeatures'; jobId: string; index: number; time: number; features: number[] }
  | { type: 'progress'; jobId: string; stage: string; fraction: number }
  | { type: 'cameraSolved'; jobId: string; solution: CameraSolution }
  | { type: 'done'; jobId: string; status: 'complete' | 'stopped' | 'cancelled' | 'error'; message?: string };
