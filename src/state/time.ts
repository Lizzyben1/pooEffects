// High-frequency time state (current time per composition, playback flag) kept OUT of the main
// document store so that 60 fps playback only re-renders the handful of components that show time.

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { useEffect, useState } from 'react';

export interface TimeState {
  times: Record<string, number>;
  playing: boolean;
  playCompId: string | null;
  /** user is dragging the CTI */
  scrubbing: boolean;
  /** frames/sec actually achieved during playback */
  playFps: number;
  /** real-time playback (cache complete) vs. render-as-you-go */
  realtime: boolean;
}

export const timeStore = createStore<TimeState>(() => ({
  times: {},
  playing: false,
  playCompId: null,
  scrubbing: false,
  playFps: 0,
  realtime: false,
}));

export function getTime(compId: string | null | undefined): number {
  if (!compId) return 0;
  return timeStore.getState().times[compId] ?? 0;
}

export function setTime(compId: string, t: number): void {
  const s = timeStore.getState();
  if (s.times[compId] === t) return;
  timeStore.setState({ times: { ...s.times, [compId]: t } });
}

export function useTime(compId: string | null | undefined): number {
  return useStore(timeStore, (s) => (compId ? s.times[compId] ?? 0 : 0));
}

export function usePlaying(): boolean {
  return useStore(timeStore, (s) => s.playing);
}

export function useTimeState<T>(sel: (s: TimeState) => T): T {
  return useStore(timeStore, sel);
}

/**
 * Time for heavier UI (property values, inspectors): exact while paused/scrubbing, throttled to
 * `hz` while playing. Subscribes directly to the store so the component only re-renders when the
 * throttled value changes.
 */
export function useThrottledTime(compId: string | null | undefined, hz = 12): number {
  const [t, setT] = useState(() => getTime(compId));
  useEffect(() => {
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const update = () => {
      last = performance.now();
      timer = null;
      setT(getTime(compId));
    };
    update();
    const unsub = timeStore.subscribe((s, prev) => {
      const key = compId ?? '';
      if (prev.times[key] === s.times[key] && s.playing === prev.playing) return;
      if (!s.playing) {
        if (timer) clearTimeout(timer);
        update();
        return;
      }
      const wait = 1000 / hz - (performance.now() - last);
      if (wait <= 0) {
        if (timer) clearTimeout(timer);
        update();
      } else if (!timer) timer = setTimeout(update, wait);
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [compId, hz]);
  return t;
}
