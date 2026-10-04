// Frame-accurate time math. All document times are seconds; frame rates are nominal
// (29.97) and mapped to exact NTSC rationals (30000/1001) for frame <-> time conversion.

export function exactFps(fps: number): number {
  const ntsc: [number, number][] = [
    [23.976, 24000 / 1001],
    [29.97, 30000 / 1001],
    [47.952, 48000 / 1001],
    [59.94, 60000 / 1001],
    [119.88, 120000 / 1001],
  ];
  for (const [nominal, exact] of ntsc) if (Math.abs(fps - nominal) < 0.005) return exact;
  return fps;
}

/** Frame index displayed at time t (frames start at 0). */
export function timeToFrame(t: number, fps: number): number {
  return Math.floor(t * exactFps(fps) + 1e-4);
}

export function frameToTime(f: number, fps: number): number {
  return f / exactFps(fps);
}

export function snapToFrame(t: number, fps: number): number {
  return frameToTime(Math.round(t * exactFps(fps)), fps);
}

export function frameDuration(fps: number): number {
  return 1 / exactFps(fps);
}

const pad = (n: number, w = 2) => String(Math.max(0, Math.floor(n))).padStart(w, '0');

/** Drop-frame timecode supports 29.97 and 59.94 (and multiples of 29.97). */
export function supportsDropFrame(fps: number): boolean {
  return Math.abs(fps - 29.97) < 0.005 || Math.abs(fps - 59.94) < 0.005 || Math.abs(fps - 119.88) < 0.005;
}

export function frameToTimecode(frame: number, fps: number, dropFrame: boolean): string {
  const neg = frame < 0;
  let f = Math.abs(Math.round(frame));
  const rfps = Math.round(fps);
  if (dropFrame && supportsDropFrame(fps)) {
    const dropFrames = Math.round(fps * 0.066666);
    const framesPer10Min = Math.round(fps * 600);
    const framesPerMin = rfps * 60 - dropFrames;
    const d = Math.floor(f / framesPer10Min);
    const m = f % framesPer10Min;
    if (m > dropFrames) f += dropFrames * 9 * d + dropFrames * Math.floor((m - dropFrames) / framesPerMin);
    else f += dropFrames * 9 * d;
    const ff = f % rfps;
    const ss = Math.floor(f / rfps) % 60;
    const mm = Math.floor(f / (rfps * 60)) % 60;
    const hh = Math.floor(f / (rfps * 3600));
    return `${neg ? '-' : ''}${pad(hh)};${pad(mm)};${pad(ss)};${pad(ff)}`;
  }
  const ff = f % rfps;
  const ss = Math.floor(f / rfps) % 60;
  const mm = Math.floor(f / (rfps * 60)) % 60;
  const hh = Math.floor(f / (rfps * 3600));
  return `${neg ? '-' : ''}${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff, rfps > 99 ? 3 : 2)}`;
}

export function timecodeToFrame(tc: string, fps: number, dropFrame: boolean): number | null {
  const parts = tc.trim().split(/[:;.]/).map((p) => p.trim());
  if (parts.some((p) => p === '' || Number.isNaN(Number(p)))) return null;
  const nums = parts.map(Number);
  while (nums.length < 4) nums.unshift(0);
  const [hh, mm, ss, ff] = nums.slice(-4);
  const rfps = Math.round(fps);
  let frame = rfps * 3600 * hh + rfps * 60 * mm + rfps * ss + ff;
  if (dropFrame && supportsDropFrame(fps)) {
    const dropFrames = Math.round(fps * 0.066666);
    const totalMinutes = 60 * hh + mm;
    frame -= dropFrames * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  return frame;
}

export function formatTime(t: number, fps: number, dropFrame: boolean, mode: 'timecode' | 'frames' = 'timecode', frameStart = 0): string {
  const f = timeToFrame(t, fps);
  if (mode === 'frames') return String(f + frameStart).padStart(5, '0');
  return frameToTimecode(f, fps, dropFrame);
}

/**
 * Parse user input for a time field. Accepts timecode ("0:00:02:15", "2:15", "215" → 2s 15f),
 * explicit frames ("f120" or "120f"), seconds ("1.5s") and relative offsets ("+10", "-5").
 */
export function parseTimeInput(input: string, fps: number, dropFrame: boolean, current = 0): number | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  const rel = s.startsWith('+') || (s.startsWith('-') && s.length > 1);
  if (rel) {
    const body = s.slice(1);
    const delta = parseTimeInput(body, fps, dropFrame, 0);
    if (delta === null) return null;
    return current + (s[0] === '+' ? delta : -delta);
  }
  if (s.endsWith('s') && !Number.isNaN(Number(s.slice(0, -1)))) return Number(s.slice(0, -1));
  if (s.startsWith('f') && !Number.isNaN(Number(s.slice(1)))) return frameToTime(Number(s.slice(1)), fps);
  if (s.endsWith('f') && !Number.isNaN(Number(s.slice(0, -1)))) return frameToTime(Number(s.slice(0, -1)), fps);
  if (/^\d+$/.test(s)) {
    // AE style: digits are read right-to-left as FF, SS, MM, HH
    const digits = s.padStart(8, '0');
    const hh = Number(digits.slice(0, digits.length - 6));
    const mm = Number(digits.slice(-6, -4));
    const ss = Number(digits.slice(-4, -2));
    const ff = Number(digits.slice(-2));
    const f = timecodeToFrame(`${hh}:${mm}:${ss}:${ff}`, fps, dropFrame);
    return f === null ? null : frameToTime(f, fps);
  }
  const f = timecodeToFrame(s, fps, dropFrame);
  return f === null ? null : frameToTime(f, fps);
}

export const FRAME_RATE_PRESETS = [8, 12, 15, 23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120];
