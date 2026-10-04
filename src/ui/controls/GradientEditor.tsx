// Gradient stops editor: click the bar to add a stop, drag stops, double-click to remove, pick colors.

import { useRef, useState } from 'react';
import type { GradientStop, RGBA } from '../../core/types';
import { rgbaToCss } from '../../math/color';
import { ColorPickerPanel } from './ColorPicker';
import { Popover } from './Popover';
import { beginTx, endTx } from '../../state/store';
import { GRADIENT_PRESETS } from '../../effects/catalog';

export function gradientCss(stops: GradientStop[]): string {
  const s = [...stops].sort((a, b) => a.p - b.p);
  return `linear-gradient(90deg, ${s.map((x) => `${rgbaToCss(x.c)} ${(x.p * 100).toFixed(1)}%`).join(', ')})`;
}

export function GradientEditor({ value, onChange }: { value: GradientStop[]; onChange: (v: GradientStop[]) => void }) {
  const bar = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [pick, setPick] = useState<DOMRect | null>(null);
  const stops = value;
  const colorAt = (p: number): RGBA => {
    const s = [...stops].sort((a, b) => a.p - b.p);
    if (p <= s[0].p) return [...s[0].c] as RGBA;
    for (let i = 0; i < s.length - 1; i++) {
      if (p <= s[i + 1].p) {
        const f = (p - s[i].p) / Math.max(1e-6, s[i + 1].p - s[i].p);
        return s[i].c.map((x, j) => x + (s[i + 1].c[j] - x) * f) as RGBA;
      }
    }
    return [...s[s.length - 1].c] as RGBA;
  };
  return (
    <div className="grad-ed">
      <div
        ref={bar}
        className="grad-bar"
        style={{ background: gradientCss(stops) }}
        onPointerDown={(e) => {
          if (e.target !== bar.current) return;
          const r = bar.current!.getBoundingClientRect();
          const p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
          const next = [...stops, { p, c: colorAt(p) }];
          onChange(next);
          setSel(next.length - 1);
        }}
      >
        {stops.map((s, i) => (
          <div
            key={i}
            className={`grad-stop${sel === i ? ' sel' : ''}`}
            style={{ left: `${s.p * 100}%`, background: rgbaToCss(s.c) }}
            onPointerDown={(e) => {
              e.stopPropagation();
              setSel(i);
              const r = bar.current!.getBoundingClientRect();
              const startX = e.clientX;
              let moved = false;
              const move = (ev: PointerEvent) => {
                if (!moved && Math.abs(ev.clientX - startX) < 3) return;
                if (!moved) {
                  moved = true;
                  beginTx();
                }
                const p = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
                onChange(stops.map((x, j) => (j === i ? { ...x, p } : x)));
              };
              const up = (ev: PointerEvent) => {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', up);
                if (moved) endTx();
                else setPick((ev.target as HTMLElement).getBoundingClientRect());
              };
              window.addEventListener('pointermove', move);
              window.addEventListener('pointerup', up);
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (stops.length > 2) {
                onChange(stops.filter((_, j) => j !== i));
                setSel(null);
              }
            }}
            title="Drag to move · click to recolor · double-click to delete"
          />
        ))}
      </div>
      <select
        className="mini-select"
        value=""
        onChange={(e) => {
          const pr = GRADIENT_PRESETS[e.target.value];
          if (pr) onChange(pr.map((s) => ({ p: s.p, c: [...s.c] as RGBA })));
        }}
      >
        <option value="" disabled>Presets…</option>
        {Object.keys(GRADIENT_PRESETS).map((k) => <option key={k} value={k}>{k}</option>)}
      </select>
      {pick && sel !== null && stops[sel] && (
        <Popover x={pick.left} y={pick.bottom + 6} anchorRect={pick} onClose={() => setPick(null)}>
          <ColorPickerPanel value={stops[sel].c} onChange={(c) => onChange(stops.map((x, j) => (j === sel ? { ...x, c } : x)))} />
        </Popover>
      )}
    </div>
  );
}
