// AE-style "scrubby" number: drag horizontally to change, click to type.
// Shift = 10× faster, Ctrl/Cmd = 10× finer. The whole drag is one undo step.

import { useEffect, useRef, useState } from 'react';
import { beginTx, endTx } from '../../state/store';

export interface ScrubProps {
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  precision?: number;
  unit?: string;
  format?: (v: number) => string;
  parse?: (s: string, current: number) => number | null;
  className?: string;
  title?: string;
  width?: number;
  /** do not wrap edits in an undo transaction (caller manages it) */
  noTx?: boolean;
}

export function formatNumber(v: number, precision = 1): string {
  if (!Number.isFinite(v)) return '—';
  const s = v.toFixed(precision);
  return s === '-0' || /^-0\.0*$/.test(s) ? s.slice(1) : s;
}

/**
 * Parse typed input. Supports plain numbers, arithmetic ("1920/2"), relative edits
 * ("+=10", "-=10", "*=2", "/=2") and AE-style "+10" (add to the current value).
 */
function defaultParse(s: string, current: number): number | null {
  const t = s.trim().replace(/[°%]/g, '').replace(/px$/i, '');
  if (!t) return null;
  const rel = t.match(/^([+\-*/])=\s*(-?[\d.]+)$/);
  if (rel) {
    const n = Number(rel[2]);
    if (!Number.isFinite(n)) return null;
    switch (rel[1]) {
      case '+': return current + n;
      case '-': return current - n;
      case '*': return current * n;
      default: return n !== 0 ? current / n : current;
    }
  }
  const plus = t.match(/^\+\s*([\d.]+)$/);
  if (plus) return current + Number(plus[1]);
  if (/^[\d.+\-*/()\s]+$/.test(t)) {
    try {
      // arithmetic only (characters validated above)
      // eslint-disable-next-line no-new-func
      const v = Function(`"use strict"; return (${t});`)() as number;
      return Number.isFinite(v) ? v : null;
    } catch {
      return null;
    }
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function Scrub({
  value, onChange, step = 1, min = -Infinity, max = Infinity, precision = 1, unit, format, parse = defaultParse, className = '', title, width, noTx,
}: ScrubProps) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const drag = useRef<{ x: number; v: number; moved: boolean; pid: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  if (editing) {
    const commit = () => {
      const v = parse(text, value);
      if (v !== null) onChange(clamp(v));
      setEditing(false);
    };
    return (
      <input
        ref={inputRef}
        className="scrub-edit"
        style={width ? { width } : undefined}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') setEditing(false);
          else if (e.key === 'Tab') commit();
        }}
        onBlur={commit}
        onPointerDown={(e) => e.stopPropagation()}
      />
    );
  }

  return (
    <span
      className={`scrub ${className}`}
      title={title}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, v: value, moved: false, pid: e.pointerId };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        if (!d.moved && Math.abs(dx) < 3) return;
        if (!d.moved) {
          d.moved = true;
          if (!noTx) beginTx();
          document.body.style.cursor = 'ew-resize';
        }
        const mul = e.shiftKey ? 10 : e.ctrlKey || e.metaKey ? 0.1 : 1;
        onChange(clamp(d.v + dx * step * mul));
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
        document.body.style.cursor = '';
        if (!d) return;
        if (d.moved) {
          if (!noTx) endTx();
        } else {
          setText(formatNumber(value, precision));
          setEditing(true);
        }
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {format ? format(value) : formatNumber(value, precision)}
      {unit && <span className="scrub-unit">{unit}</span>}
    </span>
  );
}

/** AE angle display: "1x+45.0°" */
export function formatAngle(v: number): string {
  const rev = v < 0 ? Math.ceil(v / 360) : Math.floor(v / 360);
  const rest = v - rev * 360;
  return `${rev}x${rest >= 0 ? '+' : ''}${rest.toFixed(1)}°`;
}

export function parseAngle(s: string, current: number): number | null {
  const m = s.trim().match(/^(-?\d+)\s*x\s*([+-]?[\d.]+)°?$/i);
  if (m) return Number(m[1]) * 360 + Number(m[2]);
  return defaultParse(s, current);
}
