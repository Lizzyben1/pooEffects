// HSV color picker popover with alpha, hex entry and the EyeDropper API when available.

import { useEffect, useRef, useState } from 'react';
import { Pipette } from 'lucide-react';
import { hsvToRgb, rgbToHsv, rgbaToCss, rgbaToHex, hexToRgba } from '../../math/color';
import type { RGBA } from '../../core/types';
import { Popover } from './Popover';
import { beginTx, endTx } from '../../state/store';

const SWATCHES = ['#ffffff', '#000000', '#ff9b3f', '#ff5d6c', '#ffd34d', '#3ddc84', '#4f9dff', '#b48cff', '#ff6ad5', '#2ee6d6', '#7a4a2a', '#1d2433'];

function dragOn(el: HTMLElement, e: React.PointerEvent, fn: (fx: number, fy: number) => void, onEnd: () => void) {
  const r = el.getBoundingClientRect();
  const apply = (cx: number, cy: number) => fn(Math.min(1, Math.max(0, (cx - r.left) / r.width)), Math.min(1, Math.max(0, (cy - r.top) / r.height)));
  apply(e.clientX, e.clientY);
  const move = (ev: PointerEvent) => apply(ev.clientX, ev.clientY);
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    onEnd();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

export function ColorPickerPanel({ value, onChange, alpha = true }: { value: RGBA; onChange: (c: RGBA) => void; alpha?: boolean }) {
  const [hsv, setHsv] = useState(() => rgbToHsv(value[0], value[1], value[2]));
  const [a, setA] = useState(value[3] ?? 1);
  const [hex, setHex] = useState(rgbaToHex(value));
  const sv = useRef<HTMLDivElement>(null);
  const hue = useRef<HTMLDivElement>(null);
  const al = useRef<HTMLDivElement>(null);
  const lastSent = useRef<string>('');
  useEffect(() => {
    // external updates (e.g. undo) — only resync when the value differs from what we last sent
    const key = value.map((x) => x.toFixed(4)).join(',');
    if (key === lastSent.current) return;
    setHsv((prev) => {
      const n = rgbToHsv(value[0], value[1], value[2]);
      // keep hue when desaturated
      return n[1] < 1e-4 || n[2] < 1e-4 ? [prev[0], n[1], n[2]] : n;
    });
    setA(value[3] ?? 1);
    setHex(rgbaToHex(value));
  }, [value]);
  const emit = (h: [number, number, number], alphaV: number) => {
    const [r, g, b] = hsvToRgb(h[0], h[1], h[2]);
    const c: RGBA = [r, g, b, alphaV];
    lastSent.current = c.map((x) => x.toFixed(4)).join(',');
    setHex(rgbaToHex(c));
    onChange(c);
  };
  const [hr, hg, hb] = hsvToRgb(hsv[0], 1, 1);
  const cur = hsvToRgb(hsv[0], hsv[1], hsv[2]);
  return (
    <div className="cpicker">
      <div
        ref={sv}
        className="cp-sv"
        style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, rgb(${hr * 255},${hg * 255},${hb * 255}))` }}
        onPointerDown={(e) => {
          beginTx();
          dragOn(sv.current!, e, (fx, fy) => {
            const n: [number, number, number] = [hsv[0], fx, 1 - fy];
            setHsv(n);
            emit(n, a);
          }, endTx);
        }}
      >
        <div className="cp-knob" style={{ left: `${hsv[1] * 100}%`, top: `${(1 - hsv[2]) * 100}%`, background: rgbaToCss([...cur, 1]) }} />
      </div>
      <div
        ref={hue}
        className="cp-bar cp-hue"
        onPointerDown={(e) => {
          beginTx();
          dragOn(hue.current!, e, (fx) => {
            const n: [number, number, number] = [fx * 360, hsv[1], hsv[2]];
            setHsv(n);
            emit(n, a);
          }, endTx);
        }}
      >
        <div className="cp-bar-knob" style={{ left: `${(hsv[0] / 360) * 100}%` }} />
      </div>
      {alpha && (
        <div
          ref={al}
          className="cp-bar cp-alpha"
          onPointerDown={(e) => {
            beginTx();
            dragOn(al.current!, e, (fx) => {
              setA(fx);
              emit(hsv, fx);
            }, endTx);
          }}
        >
          <div className="cp-alpha-fill" style={{ background: `linear-gradient(to right, transparent, ${rgbaToCss([...cur, 1])})` }} />
          <div className="cp-bar-knob" style={{ left: `${a * 100}%` }} />
        </div>
      )}
      <div className="cp-row">
        <div className="cp-preview"><span style={{ background: rgbaToCss([...cur, a]) }} /></div>
        <input
          className="input mono"
          value={hex}
          onChange={(e) => setHex(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              const c = hexToRgba(hex, a);
              const n = rgbToHsv(c[0], c[1], c[2]);
              setHsv(n);
              emit(n, a);
            }
          }}
          onBlur={() => {
            const c = hexToRgba(hex, a);
            const n = rgbToHsv(c[0], c[1], c[2]);
            setHsv(n);
            emit(n, a);
          }}
          style={{ width: 86 }}
        />
        <span className="cp-rgb mono">{cur.map((x) => Math.round(x * 255)).join(' ')}</span>
        {'EyeDropper' in window && (
          <button
            className="icon-btn"
            title="Sample color from screen"
            onClick={async () => {
              try {
                const ED = (window as unknown as { EyeDropper: new () => { open(): Promise<{ sRGBHex: string }> } }).EyeDropper;
                const res = await new ED().open();
                const c = hexToRgba(res.sRGBHex, a);
                const n = rgbToHsv(c[0], c[1], c[2]);
                setHsv(n);
                emit(n, a);
              } catch {
                /* cancelled */
              }
            }}
          >
            <Pipette size={14} />
          </button>
        )}
      </div>
      <div className="cp-swatches">
        {SWATCHES.map((h) => (
          <button
            key={h}
            className="cp-sw"
            style={{ background: h }}
            onClick={() => {
              const c = hexToRgba(h, a);
              const n = rgbToHsv(c[0], c[1], c[2]);
              setHsv(n);
              emit(n, a);
            }}
          />
        ))}
      </div>
    </div>
  );
}

export function ColorSwatch({ value, onChange, alpha = true, title }: { value: RGBA; onChange: (c: RGBA) => void; alpha?: boolean; title?: string }) {
  const [open, setOpen] = useState<DOMRect | null>(null);
  return (
    <>
      <span
        className="swatch"
        title={title ?? rgbaToHex(value, alpha)}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => setOpen((e.currentTarget as HTMLElement).getBoundingClientRect())}
      >
        <span style={{ background: rgbaToCss(value) }} />
      </span>
      {open && (
        <Popover x={open.left} y={open.bottom + 4} anchorRect={open} onClose={() => setOpen(null)}>
          <ColorPickerPanel value={value} onChange={onChange} alpha={alpha} />
        </Popover>
      )}
    </>
  );
}
