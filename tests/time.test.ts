import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameToTimecode, timecodeToFrame, timeToFrame, frameToTime, parseTimeInput, exactFps } from '../src/core/time';

test('NTSC rates map to exact rationals', () => {
  assert.equal(exactFps(29.97), 30000 / 1001);
  assert.equal(exactFps(23.976), 24000 / 1001);
  assert.equal(exactFps(25), 25);
});

test('non-drop timecode', () => {
  assert.equal(frameToTimecode(0, 24, false), '00:00:00:00');
  assert.equal(frameToTimecode(24 * 61 + 5, 24, false), '00:01:01:05');
});

test('drop-frame timecode skips frame numbers 0 and 1 except every 10th minute', () => {
  assert.equal(frameToTimecode(1799, 29.97, true), '00;00;59;29');
  assert.equal(frameToTimecode(1800, 29.97, true), '00;01;00;02');
  assert.equal(frameToTimecode(17982, 29.97, true), '00;10;00;00');
  assert.equal(frameToTimecode(107892, 29.97, true), '01;00;00;00');
});

test('drop-frame timecode round-trips', () => {
  for (const f of [0, 1, 1799, 1800, 1801, 17981, 17982, 35964, 100000, 107892]) {
    assert.equal(timecodeToFrame(frameToTimecode(f, 29.97, true), 29.97, true), f);
    assert.equal(timecodeToFrame(frameToTimecode(f, 59.94, true), 59.94, true), f);
  }
});

test('frame/time conversion is stable at frame boundaries', () => {
  for (const fps of [23.976, 24, 25, 29.97, 30, 59.94, 60]) {
    for (let f = 0; f < 5000; f += 37) assert.equal(timeToFrame(frameToTime(f, fps), fps), f);
  }
});

test('time input parsing', () => {
  assert.equal(parseTimeInput('215', 30, false), 2 + 15 / 30);
  assert.equal(parseTimeInput('1.5s', 30, false), 1.5);
  assert.equal(parseTimeInput('f60', 30, false), 2);
  assert.equal(parseTimeInput('+10', 30, false, 1), 1 + 10 / 30);
  assert.equal(parseTimeInput('0:00:01:00', 24, false), 1);
});
