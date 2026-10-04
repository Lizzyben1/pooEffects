// ─────────────────────────────────────────────────────────────────────────────
// After Effects-style point tracker: each track point owns a feature region
// (the template) and a search region (where it may move between frames).
// The template comes from the frame where tracking starts and, depending on
// the options, is refreshed every frame ("Adapt Feature") or only when the
// confidence drops below the threshold.
// ─────────────────────────────────────────────────────────────────────────────

import type { Pyramid } from './image';
import type { Integral } from './image';
import { makeTemplate, trackFeature, type FeatureTemplate } from './klt';
import type { LowConfidenceAction } from '../core/types';

export interface PointSpec {
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

export interface PointTrackOptions {
  adaptFeature: boolean;
  predictMotion: boolean;
  subpixel: boolean;
  /** 0..100 */
  confidenceThreshold: number;
  onLowConfidence: LowConfidenceAction;
}

export interface PointResult {
  id: string;
  x: number;
  y: number;
  /** 0..100 */
  confidence: number;
  /** tracking stopped for this point (low confidence with action 'stop', or left the frame) */
  stopped: boolean;
}

interface State {
  spec: PointSpec;
  tpl: FeatureTemplate;
  x: number;
  y: number;
  vx: number;
  vy: number;
  stopped: boolean;
}

export class PointTracker {
  private pts: State[];
  private o: PointTrackOptions;

  constructor(start: Pyramid, specs: PointSpec[], o: PointTrackOptions) {
    this.o = o;
    this.pts = specs.map((spec) => ({
      spec,
      tpl: makeTemplate(start, spec.x, spec.y, spec.featureW, spec.featureH),
      x: spec.x,
      y: spec.y,
      vx: 0,
      vy: 0,
      stopped: false,
    }));
  }

  get active(): boolean {
    return this.pts.some((p) => !p.stopped);
  }

  step(frame: Pyramid): PointResult[] {
    const cache = new Map<number, Integral>();
    const W = frame.levels[0].w, H = frame.levels[0].h;
    return this.pts.map((p) => {
      if (p.stopped) return { id: p.spec.id, x: p.x, y: p.y, confidence: 0, stopped: true };
      const px = p.x + (this.o.predictMotion ? p.vx : 0), py = p.y + (this.o.predictMotion ? p.vy : 0);
      const m = trackFeature(p.tpl, frame, {
        cx: px, cy: py, offX: p.spec.searchOffX, offY: p.spec.searchOffY, searchW: p.spec.searchW, searchH: p.spec.searchH,
        noSubpixel: !this.o.subpixel,
      }, cache);
      const conf = Math.max(0, m.ncc) * 100;
      let x = m.x, y = m.y;
      if (conf < this.o.confidenceThreshold) {
        switch (this.o.onLowConfidence) {
          case 'stop':
            p.stopped = true;
            return { id: p.spec.id, x: p.x, y: p.y, confidence: conf, stopped: true };
          case 'extrapolate':
            x = p.x + p.vx;
            y = p.y + p.vy;
            break;
          case 'adapt':
            p.tpl = makeTemplate(frame, x, y, p.spec.featureW, p.spec.featureH);
            break;
          default:
            break;
        }
      } else if (this.o.adaptFeature) {
        p.tpl = makeTemplate(frame, x, y, p.spec.featureW, p.spec.featureH);
      }
      p.vx = x - p.x;
      p.vy = y - p.y;
      p.x = x;
      p.y = y;
      if (x < -p.spec.featureW || y < -p.spec.featureH || x > W + p.spec.featureW || y > H + p.spec.featureH) p.stopped = true;
      return { id: p.spec.id, x, y, confidence: conf, stopped: p.stopped };
    });
  }
}
