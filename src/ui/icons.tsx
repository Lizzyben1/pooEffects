// Custom glyphs (brand + AE-style switches) alongside lucide icons.
import { useId, type CSSProperties } from 'react';

interface P {
  size?: number;
  className?: string;
  style?: CSSProperties;
}

/** The pooEffects mark: a glossy soft-serve swirl. */
export function Logo({ size = 22, className, style, animated = false }: P & { animated?: boolean }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} style={style} aria-label="pooEffects">
      <defs>
        <linearGradient id={`${id}g`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffd27a" />
          <stop offset="0.45" stopColor="#ff9b3f" />
          <stop offset="1" stopColor="#e2552c" />
        </linearGradient>
        <linearGradient id={`${id}h`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.7" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <filter id={`${id}f`} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="1.4" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <g filter={animated ? `url(#${id}f)` : undefined} fill={`url(#${id}g)`}>
        <path d="M3.5 24.2c0-3.6 25-3.6 25 0 0 3.4-25 3.4-25 0z">
          {animated && <animate attributeName="opacity" values="0;1" dur="0.35s" begin="0s" fill="freeze" />}
        </path>
        <path d="M6.6 18.6c0-3.2 18.8-3.2 18.8 0 0 3-18.8 3-18.8 0z">
          {animated && <animate attributeName="opacity" values="0;0;1" dur="0.55s" begin="0s" fill="freeze" />}
        </path>
        <path d="M9.6 13.3c0-2.7 12.8-2.7 12.8 0 0 2.5-12.8 2.5-12.8 0z">
          {animated && <animate attributeName="opacity" values="0;0;0;1" dur="0.75s" begin="0s" fill="freeze" />}
        </path>
        <path d="M16.2 4.2c2.6 1.4 3.5 3.8 1.6 6-1.9.6-3.6-.2-3.9-1.4 1.7.2 2.8-.8 2.3-2.1-.2-.8-.2-1.7 0-2.5z">
          {animated && <animate attributeName="opacity" values="0;0;0;0;1" dur="0.95s" begin="0s" fill="freeze" />}
        </path>
      </g>
      <g fill="none" stroke={`url(#${id}h)`} strokeWidth="1.1" strokeLinecap="round" opacity="0.9">
        <path d="M7 22.6c4-1.3 12-1.3 16.5.2" />
        <path d="M9.6 17.2c3.4-1.1 9.4-1.1 12.6.2" />
        <path d="M12.2 12.1c2.2-.8 5.6-.8 7.6.1" />
      </g>
    </svg>
  );
}

export function StopwatchIcon({ size = 14, on = false }: P & { on?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <circle cx="8" cy="9.2" r="5.3" fill={on ? 'currentColor' : 'none'} fillOpacity={on ? 0.22 : 0} />
      <path d="M8 9.2V6.4" />
      <path d="M6.6 2.2h2.8M8 2.2v1.6" />
      <path d="M12.3 4.4l1 -1" />
    </svg>
  );
}

export function KeyframeIcon({ size = 9, type = 'linear', selected = false, color }: P & { type?: string; selected?: boolean; color?: string }) {
  const fill = selected ? 'var(--accent-2)' : color ?? 'var(--kf)';
  const stroke = selected ? '#fff8' : '#0008';
  const s = size;
  if (type === 'hold') return <svg width={s} height={s} viewBox="0 0 10 10"><rect x="1.2" y="1.2" width="7.6" height="7.6" fill={fill} stroke={stroke} strokeWidth="0.8" /></svg>;
  if (type === 'auto') return <svg width={s} height={s} viewBox="0 0 10 10"><circle cx="5" cy="5" r="3.8" fill={fill} stroke={stroke} strokeWidth="0.8" /></svg>;
  if (type === 'bezier') return <svg width={s} height={s} viewBox="0 0 10 10"><path d="M1 1 L5 5 L1 9 Z M9 1 L5 5 L9 9 Z" fill={fill} stroke={stroke} strokeWidth="0.7" strokeLinejoin="round" /></svg>;
  return <svg width={s} height={s} viewBox="0 0 10 10"><path d="M5 0.6 L9.4 5 L5 9.4 L0.6 5 Z" fill={fill} stroke={stroke} strokeWidth="0.8" /></svg>;
}

export function ShyIcon({ size = 14 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
      <circle cx="8" cy="8" r="5.6" />
      <path d="M5.6 6.8h.01M10.4 6.8h.01" strokeWidth="2" />
      <path d="M5.8 10.2c1.3-.6 3.1-.6 4.4 0" />
    </svg>
  );
}

export function MotionBlurIcon({ size = 14 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor">
      <circle cx="11" cy="8" r="3.4" />
      <circle cx="6.6" cy="8" r="2.8" opacity="0.55" />
      <circle cx="3" cy="8" r="2.2" opacity="0.28" />
    </svg>
  );
}

export function CubeIcon({ size = 14 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round">
      <path d="M8 1.8l5.4 3v6.4L8 14.2l-5.4-3V4.8z" />
      <path d="M2.6 4.8L8 7.8l5.4-3M8 7.8v6.4" />
    </svg>
  );
}

export function AdjustmentIcon({ size = 14 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 2.4a5.6 5.6 0 010 11.2z" fill="currentColor" />
    </svg>
  );
}

export function CollapseIcon({ size = 14 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
      <circle cx="8" cy="8" r="2.4" fill="currentColor" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
    </svg>
  );
}

export function FxIcon({ size = 14 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor">
      <text x="1.2" y="12.4" fontSize="11" fontStyle="italic" fontWeight="700" fontFamily="Georgia, serif">fx</text>
    </svg>
  );
}

export function PickWhipIcon({ size = 14 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
      <path d="M8 8m-1 0a1 1 0 102 0a2.2 2.2 0 00-4.4 0a3.4 3.4 0 006.8 0a4.6 4.6 0 00-9.2 0" />
    </svg>
  );
}

export function GraphIcon({ size = 14 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <path d="M1.8 13.2C6 13.2 5 2.8 9 2.8s3.4 6 5.2 6" />
      <circle cx="9" cy="2.8" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function QualityIcon({ size = 14, best = true }: P & { best?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      {best ? <path d="M3 12.5L12.5 3" /> : <path d="M3 12.5h3v-3h3v-3h3v-3" />}
    </svg>
  );
}

export function SoloIcon({ size = 14 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="8" cy="8" r="2.4" fill="currentColor" />
    </svg>
  );
}

export function LayerTypeIcon({ type, size = 13 }: P & { type: string }) {
  const common = { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round' as const, strokeLinecap: 'round' as const };
  switch (type) {
    case 'solid': return <svg {...common}><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" fill="currentColor" fillOpacity="0.35" /></svg>;
    case 'null': return <svg {...common}><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" strokeDasharray="2 1.6" /></svg>;
    case 'shape': return <svg {...common}><path d="M8 2l5.7 4.1-2.2 6.7H4.5L2.3 6.1z" fill="currentColor" fillOpacity="0.25" /></svg>;
    case 'text': return <svg {...common}><path d="M3 3.5h10M8 3.5v9.5M6 13h4" /></svg>;
    case 'image': return <svg {...common}><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M2.5 11.5l3.5-3.5 3 3 2-2 2.5 2.5" /><circle cx="10.8" cy="6" r="1" /></svg>;
    case 'video': return <svg {...common}><rect x="1.8" y="3.5" width="9" height="9" rx="1.5" /><path d="M10.8 7l3.4-2v6l-3.4-2" /></svg>;
    case 'audio': return <svg {...common}><path d="M2.5 9.5h2l3 3v-9l-3 3h-2z" /><path d="M10 5.5a3.5 3.5 0 010 5M12 3.8a6 6 0 010 8.4" /></svg>;
    case 'precomp': return <svg {...common}><rect x="1.8" y="4.2" width="9" height="9" rx="1.3" /><path d="M4.6 4.2V2.6h9v9h-1.6" /></svg>;
    case 'camera': return <svg {...common}><rect x="1.8" y="4.5" width="9" height="7" rx="1.3" /><path d="M10.8 7.2l3.4-1.6v4.8l-3.4-1.6" /></svg>;
    case 'light': return <svg {...common}><path d="M8 2.2a4 4 0 012.4 7.2c-.5.4-.7.9-.7 1.5v.6H6.3v-.6c0-.6-.2-1.1-.7-1.5A4 4 0 018 2.2zM6.5 13.8h3" /></svg>;
    case 'adjustment': return <svg {...common}><circle cx="8" cy="8" r="5.5" /><path d="M8 2.5a5.5 5.5 0 010 11z" fill="currentColor" /></svg>;
    default: return <svg {...common}><rect x="2.5" y="2.5" width="11" height="11" rx="2" /></svg>;
  }
}
