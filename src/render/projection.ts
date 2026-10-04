// View/projection math shared by the GPU renderer and the viewport overlay (no WebGL here).

import type { Composition } from '../core/types';
import { FrameEval, defaultCameraZoom, type CameraEval } from '../core/evaluate';
import * as M from '../math/mat4';

export type ViewKind = 'active' | 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'custom';

export interface ViewSpec {
  kind: ViewKind;
  /** world-space target for ortho/custom views */
  center?: number[];
  /** ortho: screen px per world unit (before render scale) */
  zoom?: number;
  yaw?: number;
  pitch?: number;
  distance?: number;
}

export interface Projection {
  viewProj: M.Mat4;
  view: M.Mat4;
  ortho2D: M.Mat4;
  camPos: number[];
  cam: CameraEval | null;
  active: boolean;
  /** perspective zoom (px) for perspective views; null for ortho */
  zoom: number | null;
}

export const NEAR = 1;
export const FAR = 200000;

const AXES: Record<string, [number[], number[], number[]]> = {
  front: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  back: [[-1, 0, 0], [0, 1, 0], [0, 0, -1]],
  left: [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  right: [[0, 0, 1], [0, 1, 0], [-1, 0, 0]],
  top: [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
  bottom: [[1, 0, 0], [0, 0, 1], [0, -1, 0]],
};

export function customEye(comp: Composition, view: ViewSpec): { eye: number[]; center: number[] } {
  const center = view.center ?? [comp.width / 2, comp.height / 2, 0];
  const yaw = ((view.yaw ?? 35) * Math.PI) / 180, pitch = ((view.pitch ?? -22) * Math.PI) / 180;
  const dist = view.distance ?? defaultCameraZoom(comp) * 1.8;
  return {
    eye: [
      center[0] - Math.sin(yaw) * Math.cos(pitch) * dist,
      center[1] + Math.sin(pitch) * dist,
      center[2] - Math.cos(yaw) * Math.cos(pitch) * dist,
    ],
    center,
  };
}

export function computeProjection(comp: Composition, fe: FrameEval, view: ViewSpec): Projection {
  const ortho2D = M.orthoComp(comp.width, comp.height);
  if (view.kind === 'active') {
    const cam = fe.camera();
    const P = M.perspectiveAE(comp.width, comp.height, cam.zoom, NEAR, FAR);
    return { viewProj: M.multiply(P, cam.view), view: cam.view, ortho2D, camPos: cam.position, cam, active: true, zoom: cam.zoom };
  }
  if (view.kind === 'custom') {
    const { eye, center } = customEye(comp, view);
    const camToWorld = M.multiply(M.translation(eye[0], eye[1], eye[2]), M.lookAtRotation(eye, center));
    const V = M.invert(camToWorld) ?? M.identity();
    const z = defaultCameraZoom(comp);
    const P = M.perspectiveAE(comp.width, comp.height, z, NEAR, FAR);
    return { viewProj: M.multiply(P, V), view: V, ortho2D, camPos: eye, cam: null, active: false, zoom: z };
  }
  const center = view.center ?? [comp.width / 2, comp.height / 2, 0];
  const [r, d, f] = AXES[view.kind] ?? AXES.front;
  const rot = M.identity();
  rot.set([r[0], r[1], r[2], 0, d[0], d[1], d[2], 0, f[0], f[1], f[2], 0, 0, 0, 0, 1]);
  const dist = 100000;
  const eye = [center[0] - f[0] * dist, center[1] - f[1] * dist, center[2] - f[2] * dist];
  const camToWorld = M.multiply(M.translation(eye[0], eye[1], eye[2]), rot);
  const V = M.invert(camToWorld) ?? M.identity();
  const P = M.orthoCentered(comp.width, comp.height, view.zoom ?? 0.5, NEAR, FAR);
  return { viewProj: M.multiply(P, V), view: V, ortho2D, camPos: eye, cam: null, active: false, zoom: null };
}

/** Project a world point to composition pixels through a projection (null when behind the camera). */
export function worldToComp(proj: Projection, comp: Composition, p: number[]): [number, number] | null {
  const c = M.transformVec4(proj.viewProj, [p[0], p[1], p[2] ?? 0, 1]);
  if (c[3] <= 1e-6) return null;
  return [((c[0] / c[3] + 1) / 2) * comp.width, ((c[1] / c[3] + 1) / 2) * comp.height];
}
