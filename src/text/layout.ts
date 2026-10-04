// Text layout: line breaking, kerning, tracking, leading and justification.
// Layer space origin is the first line's baseline at the alignment point (AE point text).

import type { TextDocument } from '../core/types';

export type Measure = (text: string, font: string) => number;

export function fontString(doc: Pick<TextDocument, 'font' | 'weight' | 'italic'>, size: number): string {
  const fam = /[\s,]/.test(doc.font) && !doc.font.includes('"') ? `"${doc.font}"` : doc.font;
  return `${doc.italic ? 'italic ' : ''}${Math.round(doc.weight)} ${Math.max(0.5, size).toFixed(2)}px ${fam}, "Inter", sans-serif`;
}

export interface Glyph {
  ch: string;
  /** index among all glyphs (newlines excluded) */
  index: number;
  charIdx: number;
  /** -1 for whitespace */
  charNoSpaceIdx: number;
  /** -1 for whitespace */
  wordIdx: number;
  lineIdx: number;
  /** baseline-left position after justification */
  x: number;
  y: number;
  /** advance width without tracking */
  width: number;
  space: boolean;
}

export interface TextLayout {
  glyphs: Glyph[];
  lineWidths: number[];
  lineY: number[];
  lineHeight: number;
  ascent: number;
  descent: number;
  font: string;
  counts: { characters: number; charactersExcludingSpaces: number; words: number; lines: number };
}

const kernCache = new Map<string, number>();
const widthCache = new Map<string, number>();

export function clearTextCaches(): void {
  kernCache.clear();
  widthCache.clear();
}

function charWidth(measure: Measure, ch: string, font: string): number {
  const k = font + '\u0001' + ch;
  let w = widthCache.get(k);
  if (w === undefined) {
    w = measure(ch, font);
    if (widthCache.size > 20000) widthCache.clear();
    widthCache.set(k, w);
  }
  return w;
}

function kerning(measure: Measure, a: string, b: string, font: string): number {
  if (a === ' ' || b === ' ') return 0;
  const k = font + '\u0001' + a + b;
  let v = kernCache.get(k);
  if (v === undefined) {
    v = measure(a + b, font) - charWidth(measure, a, font) - charWidth(measure, b, font);
    if (Math.abs(v) < 0.01) v = 0;
    if (kernCache.size > 40000) kernCache.clear();
    kernCache.set(k, v);
  }
  return v;
}

const isSpace = (ch: string) => /\s/.test(ch);

/**
 * Lay out text. `extraTracking(globalIndex)` returns additional tracking (1/1000 em) applied after that
 * glyph — used by text animators.
 */
export function layoutText(
  rawText: string, doc: TextDocument, measure: Measure, extraTracking?: (index: number) => number,
): TextLayout {
  const size = Math.max(0.5, doc.size);
  const font = fontString(doc, size);
  let text = (rawText ?? '').replace(/\r\n?/g, '\n');
  if (doc.allCaps) text = text.toUpperCase();
  const lineHeight = doc.leading > 0 ? doc.leading : size * 1.2;
  const baseTrack = (doc.tracking / 1000) * size;
  const trackOf = (idx: number) => baseTrack + (extraTracking ? (extraTracking(idx) / 1000) * size : 0);

  // ── break into lines ──
  const paragraphs = text.split('\n');
  const lines: string[] = [];
  if (doc.boxWidth && doc.boxWidth > 0) {
    for (const para of paragraphs) {
      const words = para.split(/(\s+)/);
      let cur = '';
      for (const w of words) {
        if (!w) continue;
        const test = cur + w;
        const tw = measure(test, font) + baseTrack * test.length;
        if (tw > doc.boxWidth && cur.trim().length) {
          lines.push(cur.replace(/\s+$/, ''));
          cur = /^\s+$/.test(w) ? '' : w;
        } else cur = test;
      }
      lines.push(cur);
    }
  } else lines.push(...paragraphs);

  const glyphs: Glyph[] = [];
  const lineWidths: number[] = [];
  const lineY: number[] = [];
  let gIndex = 0, charNoSpace = 0, word = -1, inWord = false;
  lines.forEach((line, li) => {
    const chars = Array.from(line);
    let x = 0;
    const lineGlyphs: Glyph[] = [];
    for (let k = 0; k < chars.length; k++) {
      const ch = chars[k];
      const sp = isSpace(ch);
      if (!sp && !inWord) { word++; inWord = true; }
      if (sp) inWord = false;
      const w = charWidth(measure, ch, font);
      const kern = k > 0 ? kerning(measure, chars[k - 1], ch, font) : 0;
      x += kern;
      lineGlyphs.push({
        ch, index: gIndex, charIdx: gIndex, charNoSpaceIdx: sp ? -1 : charNoSpace, wordIdx: sp ? -1 : word,
        lineIdx: li, x, y: 0, width: w, space: sp,
      });
      x += w + trackOf(gIndex);
      gIndex++;
      if (!sp) charNoSpace++;
    }
    inWord = false;
    const width = lineGlyphs.length ? x - trackOf(gIndex - 1) : 0;
    lineWidths.push(width);
    const y = li * lineHeight - doc.baselineShift;
    lineY.push(y);
    let off = 0;
    const box = doc.boxWidth && doc.boxWidth > 0 ? doc.boxWidth : 0;
    if (box) off = doc.justify === 'left' ? -box / 2 : doc.justify === 'center' ? -width / 2 : box / 2 - width;
    else off = doc.justify === 'left' ? 0 : doc.justify === 'center' ? -width / 2 : -width;
    for (const g of lineGlyphs) {
      g.x += off;
      g.y = y;
      glyphs.push(g);
    }
  });
  return {
    glyphs, lineWidths, lineY, lineHeight,
    ascent: size * 0.8, descent: size * 0.25, font,
    counts: { characters: gIndex, charactersExcludingSpaces: charNoSpace, words: word + 1, lines: lines.length },
  };
}
