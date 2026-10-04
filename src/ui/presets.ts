// Animation presets (text animators + motion recipes) applied to the selected layers.

import type { Draft } from 'immer';
import type { AnimProp, Keyframe, Layer, Project, PropValue, RangeSelector } from '../core/types';
import { doc, getApp, toast } from '../state/store';
import { getTime } from '../state/time';
import { createTextAnimator, createWigglySelector } from '../core/factory';
import { makeKeyframe } from '../state/actions';
import { toLayerTime } from '../core/evaluate';
import { EASY_EASE_INFLUENCE } from '../anim/interpolate';

export interface Preset {
  id: string;
  name: string;
  group: 'Text' | 'Motion';
  description: string;
  textOnly?: boolean;
  apply: (d: Draft<Layer>, t0: number, project: Project) => void;
}

function ease(k: Keyframe, inf = EASY_EASE_INFLUENCE, speedOut = 0, speedIn = 0): Keyframe {
  k.inType = 'bezier';
  k.outType = 'bezier';
  k.easeIn = k.easeIn.map(() => ({ speed: speedIn, influence: inf }));
  k.easeOut = k.easeOut.map(() => ({ speed: speedOut, influence: inf }));
  return k;
}

function kfs<V extends PropValue>(p: Draft<AnimProp<V>>, pairs: [number, V][], spatial = false, inf = 0.6): void {
  p.keyframes = pairs.map(([t, v]) => ease(makeKeyframe(t, v as PropValue, spatial), inf)) as never;
}

function textAnim(d: Draft<Layer>, name: string, props: Parameters<typeof createTextAnimator>[0], sel: Partial<RangeSelector>, offsetKeys: [number, number][] | null, startKeys?: [number, number][]) {
  if (!d.text) return null;
  const a = createTextAnimator(props, d.text.animators.length + 1);
  a.name = name;
  const s = a.selectors[0] as RangeSelector;
  Object.assign(s, sel);
  if (offsetKeys) s.offset.keyframes = offsetKeys.map(([t, v]) => ease(makeKeyframe(t, v, false), 0.55)) as never;
  if (startKeys) s.start.keyframes = startKeys.map(([t, v]) => makeKeyframe(t, v, false)) as never;
  d.text.animators.push(a as never);
  return a;
}

export const PRESETS: Preset[] = [
  {
    id: 'typewriter', name: 'Typewriter', group: 'Text', textOnly: true, description: 'Characters appear one at a time.',
    apply: (d, t0) => {
      const a = textAnim(d, 'Typewriter', ['opacity'], { shape: 'square', smoothness: prop0(0) }, null, [[t0, 0], [t0 + 2, 100]]);
      if (a) a.props.opacity!.value = 0;
    },
  },
  {
    id: 'fadeUp', name: 'Fade Up Characters', group: 'Text', textOnly: true, description: 'Staggered rise and fade, left to right.',
    apply: (d, t0) => {
      const a = textAnim(d, 'Fade Up', ['position', 'opacity'], { shape: 'rampUp', end: prop0(35) }, [[t0, -35], [t0 + 1.8, 100]]);
      if (a) {
        a.props.position!.value = [0, 90, 0];
        a.props.opacity!.value = 0;
      }
    },
  },
  {
    id: 'blurIn', name: 'Blur In', group: 'Text', textOnly: true, description: 'Characters resolve from a soft blur.',
    apply: (d, t0) => {
      const a = textAnim(d, 'Blur In', ['blur', 'opacity', 'scale'], { shape: 'rampUp', end: prop0(40) }, [[t0, -40], [t0 + 2, 100]]);
      if (a) {
        a.props.blur!.value = [40, 40];
        a.props.opacity!.value = 0;
        a.props.scale!.value = [140, 140];
      }
    },
  },
  {
    id: 'popIn', name: 'Pop In', group: 'Text', textOnly: true, description: 'Characters scale up from nothing.',
    apply: (d, t0) => {
      const a = textAnim(d, 'Pop In', ['scale', 'opacity', 'rotation'], { shape: 'rampUp', end: prop0(25) }, [[t0, -25], [t0 + 1.4, 100]]);
      if (a) {
        a.props.scale!.value = [0, 0];
        a.props.opacity!.value = 0;
        a.props.rotation!.value = -35;
      }
    },
  },
  {
    id: 'randomFade', name: 'Random Fade', group: 'Text', textOnly: true, description: 'Characters fade in in random order.',
    apply: (d, t0) => {
      const a = textAnim(d, 'Random Fade', ['opacity'], { shape: 'square', randomize: true, seed: Math.floor(Math.random() * 999) }, null, [[t0, 0], [t0 + 2, 100]]);
      if (a) a.props.opacity!.value = 0;
    },
  },
  {
    id: 'wave', name: 'Wave', group: 'Text', textOnly: true, description: 'A looping wave travels through the text.',
    apply: (d, t0) => {
      const a = textAnim(d, 'Wave', ['position', 'fillColor'], { shape: 'smooth', end: prop0(30) }, null);
      if (a) {
        a.props.position!.value = [0, -45, 0];
        a.props.fillColor!.value = [1, 0.72, 0.3, 1];
        const s = a.selectors[0] as RangeSelector;
        s.offset.keyframes = [makeKeyframe(t0, -30, false), makeKeyframe(t0 + 1.6, 100, false)] as never;
        s.offset.expression = "loopOut('cycle')";
        s.offset.expressionEnabled = true;
      }
    },
  },
  {
    id: 'trackingIn', name: 'Tracking In', group: 'Text', textOnly: true, description: 'Letters condense from wide tracking.',
    apply: (d, t0) => {
      if (!d.text) return;
      const a = createTextAnimator(['tracking', 'opacity'], d.text.animators.length + 1);
      a.name = 'Tracking In';
      kfs(a.props.tracking!, [[t0, 600], [t0 + 1.6, 0]]);
      kfs(a.props.opacity!, [[t0, 0], [t0 + 1, 100]]);
      d.text.animators.push(a as never);
    },
  },
  {
    id: 'jitter', name: 'Glitch Jitter', group: 'Text', textOnly: true, description: 'Wiggly selector shakes characters.',
    apply: (d) => {
      if (!d.text) return;
      const a = createTextAnimator(['position', 'rotation'], d.text.animators.length + 1);
      a.name = 'Jitter';
      a.props.position!.value = [18, 14, 0];
      a.props.rotation!.value = 8;
      const w = createWigglySelector();
      w.wigglesPerSecond.value = 6;
      w.correlation.value = 20;
      a.selectors.push(w);
      d.text.animators.push(a as never);
    },
  },
  {
    id: 'wiggle', name: 'Wiggle Position', group: 'Motion', description: 'Organic random drift via expression.',
    apply: (d) => {
      d.transform.position.expression = 'wiggle(2.5, 24)';
      d.transform.position.expressionEnabled = true;
    },
  },
  {
    id: 'spin', name: 'Spin Forever', group: 'Motion', description: 'Continuous rotation at 90°/s.',
    apply: (d) => {
      d.transform.rotation.expression = 'value + time * 90';
      d.transform.rotation.expressionEnabled = true;
    },
  },
  {
    id: 'pulse', name: 'Pulse', group: 'Motion', description: 'Breathing scale with a sine expression.',
    apply: (d) => {
      d.transform.scale.expression = 's = 1 + Math.sin(time * Math.PI * 2) * 0.06;\n[value[0] * s, value[1] * s, value[2]]';
      d.transform.scale.expressionEnabled = true;
    },
  },
  {
    id: 'fadeIn', name: 'Fade In', group: 'Motion', description: 'Opacity 0 → 100 over half a second.',
    apply: (d, t0) => kfs(d.transform.opacity, [[t0, 0], [t0 + 0.5, 100]], false, 0.33),
  },
  {
    id: 'fadeOut', name: 'Fade Out', group: 'Motion', description: 'Opacity 100 → 0 ending at the out point.',
    apply: (d) => {
      const end = toLayerTime(d as Layer, Math.max(d.inPoint, d.outPoint));
      kfs(d.transform.opacity, [[end - 0.5, 100], [end - 1 / 60, 0]], false, 0.33);
    },
  },
  {
    id: 'popScale', name: 'Pop In (Overshoot)', group: 'Motion', description: 'Scale 0 → 112% → 100% with easing.',
    apply: (d, t0) => kfs(d.transform.scale, [[t0, [0, 0, 100]], [t0 + 0.33, [112, 112, 100]], [t0 + 0.55, [100, 100, 100]]], false, 0.5),
  },
  {
    id: 'slideLeft', name: 'Slide In From Left', group: 'Motion', description: 'Glides in from off-screen left.',
    apply: (d, t0, project) => {
      const comp = Object.values(project.comps).find((c) => c.layers.some((l) => l.id === d.id));
      const p = (d.transform.position.keyframes.length ? d.transform.position.keyframes[0].v : d.transform.position.value) as number[];
      const w = comp?.width ?? 1920;
      kfs(d.transform.position, [[t0, [p[0] - w * 0.75, p[1], p[2] ?? 0]], [t0 + 0.9, [p[0], p[1], p[2] ?? 0]]], true, 0.8);
      const k0 = d.transform.position.keyframes[0];
      k0.easeOut = [{ speed: 0, influence: 0.1 }] as never;
    },
  },
  {
    id: 'loop', name: 'Loop Keyframes', group: 'Motion', description: "Adds loopOut('cycle') to animated transform properties.",
    apply: (d) => {
      for (const k of ['position', 'scale', 'rotation', 'opacity', 'anchor'] as const) {
        const p = d.transform[k];
        if (p.keyframes.length > 1) {
          p.expression = "loopOut('cycle')";
          p.expressionEnabled = true;
        }
      }
    },
  },
];

function prop0<V extends PropValue>(v: V): AnimProp<V> {
  return { value: v, keyframes: [] };
}

export function applyPreset(id: string): void {
  const preset = PRESETS.find((p) => p.id === id);
  const s = getApp();
  const comp = s.activeCompId ? s.project.comps[s.activeCompId] : undefined;
  if (!preset || !comp) return;
  const targets = comp.layers.filter((l) => s.selLayers.includes(l.id) && (!preset.textOnly || l.type === 'text'));
  if (!targets.length) {
    toast(preset.textOnly ? 'Select a text layer first' : 'Select a layer first', 'warn');
    return;
  }
  const t = getTime(comp.id);
  doc((d) => {
    const c = d.comps[comp.id];
    for (const l of c.layers) {
      if (!targets.some((x) => x.id === l.id)) continue;
      preset.apply(l, toLayerTime(l as Layer, t), d as Project);
    }
  });
  toast(`Applied preset “${preset.name}”`, 'success', 1800);
}
