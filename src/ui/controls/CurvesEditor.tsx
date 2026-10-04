// Curves editor for the Curves effect: per-channel monotone spline with draggable control points.

import { useEffect, useRef, useState } from 'react';
import type { CurvesValue, Vec2 } from '../../core/types';
import { sampleCurve } from '../../render/effects/kit';
import { beginTx, endTx } from '../../state/store';

type Ch = keyof CurvesValue;
const CH_COLORS: Record<Ch, string> = { rgb: '#e8ecf3', r: '#ff5d6c', g: '#3ddc84', b: '#4f9dff', a: '#a0a8b8' };

export function CurvesEditor({ value, onChange }: { value: CurvesValue; onChange: (v: CurvesValue) => void }) {
  const [ch, setCh] = useState<Ch>('rgb');
  const canvas = useRef<HTMLCanvasElement>(null);
  const size = 180;
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = size * dpr;
    c.height = size * dpr;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = '#0c0e12';
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = '#ffffff10';
    for (let i = 1; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo((i * size) / 4, 0);
      ctx.lineTo((i * size) / 4, size);
      ctx.moveTo(0, (i * size) / 4);
      ctx.lineTo(size, (i * size) / 4);
      ctx.stroke();
    }
    ctx.strokeStyle = '#ffffff22';
    ctx.beginPath();
    ctx.moveTo(0, size);
    ctx.lineTo(size, 0);
    ctx.stroke();
    const drawCurve = (k: Ch, alpha: number) => {
      const lut = sampleCurve(value[k], 128);
      ctx.strokeStyle = CH_COLORS[k];
      ctx.globalAlpha = alpha;
      ctx.lineWidth = k === ch ? 1.8 : 1;
      ctx.beginPath();
      for (let i = 0; i < lut.length; i++) {
        const x = (i / (lut.length - 1)) * size, y = (1 - Math.max(0, Math.min(1, lut[i]))) * size;
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    };
    (['r', 'g', 'b', 'rgb'] as Ch[]).forEach((k) => k !== ch && drawCurve(k, 0.25));
    drawCurve(ch, 1);
    for (const p of value[ch]) {
      ctx.fillStyle = '#0c0e12';
      ctx.strokeStyle = CH_COLORS[ch];
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p[0] * size, (1 - p[1]) * size, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }, [value, ch]);

  const toPt = (e: { clientX: number; clientY: number }): Vec2 => {
    const r = canvas.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height))];
  };

  return (
    <div className="curves-ed">
      <div className="curves-ch">
        {(['rgb', 'r', 'g', 'b', 'a'] as Ch[]).map((k) => (
          <button key={k} className={`btn sm${ch === k ? ' primary' : ' ghost'}`} onClick={() => setCh(k)} style={ch === k ? undefined : { color: CH_COLORS[k] }}>
            {k.toUpperCase()}
          </button>
        ))}
        <button
          className="btn sm ghost"
          onClick={() => onChange({ ...value, [ch]: [[0, 0], [1, 1]] })}
          title="Reset this channel"
        >
          Reset
        </button>
      </div>
      <canvas
        ref={canvas}
        style={{ width: size, height: size, borderRadius: 6, border: '1px solid var(--line-2)' }}
        onPointerDown={(e) => {
          e.stopPropagation();
          const pts = value[ch].map((p) => [p[0], p[1]] as Vec2);
          const q = toPt(e);
          let idx = pts.findIndex((p) => Math.hypot((p[0] - q[0]) * size, (p[1] - q[1]) * size) < 8);
          if (idx < 0) {
            pts.push(q);
            pts.sort((a, b) => a[0] - b[0]);
            idx = pts.findIndex((p) => p === q);
          }
          beginTx();
          onChange({ ...value, [ch]: pts });
          const move = (ev: PointerEvent) => {
            const np = toPt(ev);
            const lo = idx > 0 ? pts[idx - 1][0] + 0.01 : 0;
            const hi = idx < pts.length - 1 ? pts[idx + 1][0] - 0.01 : 1;
            pts[idx] = [Math.min(hi, Math.max(lo, np[0])), np[1]];
            onChange({ ...value, [ch]: pts.map((p) => [p[0], p[1]] as Vec2) });
          };
          const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            endTx();
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        }}
        onDoubleClick={(e) => {
          const q = toPt(e);
          const pts = value[ch];
          const idx = pts.findIndex((p) => Math.hypot((p[0] - q[0]) * size, (p[1] - q[1]) * size) < 8);
          if (idx > 0 && idx < pts.length - 1) onChange({ ...value, [ch]: pts.filter((_, i) => i !== idx) });
        }}
      />
    </div>
  );
}
