// Color utilities. Colors in the document model are straight (non-premultiplied) RGBA in [0,1].

export type RGBA = [number, number, number, number];

export function hexToRgba(hex: string, alpha = 1): RGBA {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length === 4) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : alpha;
  if (Number.isNaN(n)) return [1, 1, 1, alpha];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a];
}

const to2 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');

export function rgbaToHex(c: number[], withAlpha = false): string {
  return '#' + to2(c[0]) + to2(c[1]) + to2(c[2]) + (withAlpha ? to2(c[3] ?? 1) : '');
}

export function rgbaToCss(c: number[], alphaMul = 1): string {
  const r = Math.round(Math.max(0, Math.min(1, c[0])) * 255);
  const g = Math.round(Math.max(0, Math.min(1, c[1])) * 255);
  const b = Math.round(Math.max(0, Math.min(1, c[2])) * 255);
  const a = Math.max(0, Math.min(1, (c[3] ?? 1) * alphaMul));
  return `rgba(${r},${g},${b},${a.toFixed(4)})`;
}

export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 1e-9) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max <= 0 ? 0 : d / max;
  return [h, s, max];
}

export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const hh = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hh < 1) [r, g, b] = [c, x, 0];
  else if (hh < 2) [r, g, b] = [x, c, 0];
  else if (hh < 3) [r, g, b] = [0, c, x];
  else if (hh < 4) [r, g, b] = [0, x, c];
  else if (hh < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = v - c;
  return [r + m, g + m, b + m];
}

export function luminance(c: number[]): number {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** After Effects label colors (index 0 = None). */
export const LABEL_COLORS: { name: string; hex: string }[] = [
  { name: 'None', hex: '#4a4f5a' },
  { name: 'Red', hex: '#e2535c' },
  { name: 'Yellow', hex: '#e4d84c' },
  { name: 'Aqua', hex: '#a9cbc7' },
  { name: 'Pink', hex: '#e5bcc9' },
  { name: 'Lavender', hex: '#a9a9ca' },
  { name: 'Peach', hex: '#e7c19e' },
  { name: 'Sea Foam', hex: '#b3c7b3' },
  { name: 'Blue', hex: '#677de0' },
  { name: 'Green', hex: '#4aa44c' },
  { name: 'Purple', hex: '#8e2c9a' },
  { name: 'Orange', hex: '#e8920d' },
  { name: 'Brown', hex: '#7f452a' },
  { name: 'Fuchsia', hex: '#f46dd6' },
  { name: 'Cyan', hex: '#3da2a5' },
  { name: 'Sandstone', hex: '#a89677' },
  { name: 'Dark Green', hex: '#1e401e' },
];
