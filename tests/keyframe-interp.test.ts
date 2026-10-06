import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, setApp, keyOf } from '../src/state/store';
import { createComp, createShapeLayer } from '../src/core/factory';
import * as A from '../src/state/actions';

test('setKeyframeInterpolation updates keyframe types and synchronizes spatial interpolation', () => {
  const comp = createComp({ name: 'Test Comp', width: 1920, height: 1080, duration: 5, frameRate: 30 });
  const layer = createShapeLayer('Shape', 1920, 1080);
  comp.layers.push(layer);

  setApp({
    project: {
      id: 'proj',
      name: 'Project',
      settings: { timeDisplay: 'timecode', startFrame: 0, motionBlurSamples: 8, motionBlurAngle: 180 },
      comps: { [comp.id]: comp },
      footages: {},
      folders: {},
      renderQueue: [],
    },
    activeCompId: comp.id,
    selKeys: [],
  });

  // Add 2 position keyframes (spatial property)
  A.upsertKeyframe(layer.transform.position as any, 0, [100, 100, 0], true, 0.01);
  A.upsertKeyframe(layer.transform.position as any, 2, [500, 500, 0], true, 0.01);

  const p = getApp().project.comps[comp.id].layers[0].transform.position;
  assert.equal(p.keyframes.length, 2);
  const k0 = p.keyframes[0];
  const k1 = p.keyframes[1];
  const key0 = keyOf({ layerId: layer.id, path: 'transform.position', kfId: k0.id });

  // Convert to Hold
  A.setKeyframeInterpolation([key0], 'hold');
  let kf0 = getApp().project.comps[comp.id].layers[0].transform.position.keyframes[0];
  assert.equal(kf0.outType, 'hold');

  // Convert to Auto Bezier (should update temporal and spatial)
  A.setKeyframeInterpolation([key0], 'auto');
  kf0 = getApp().project.comps[comp.id].layers[0].transform.position.keyframes[0];
  assert.equal(kf0.inType, 'auto');
  assert.equal(kf0.outType, 'auto');
  assert.equal(kf0.spatial, 'auto');

  // Convert to Linear (should update temporal and synchronize spatial to linear)
  A.setKeyframeInterpolation([key0], 'linear');
  kf0 = getApp().project.comps[comp.id].layers[0].transform.position.keyframes[0];
  assert.equal(kf0.inType, 'linear');
  assert.equal(kf0.outType, 'linear');
  assert.equal(kf0.spatial, 'linear');

  // Easy ease
  A.easyEase([key0], 'both');
  kf0 = getApp().project.comps[comp.id].layers[0].transform.position.keyframes[0];
  assert.equal(kf0.inType, 'bezier');
  assert.equal(kf0.outType, 'bezier');
});
