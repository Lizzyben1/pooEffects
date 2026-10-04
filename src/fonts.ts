// Bundled typefaces available to text layers (loaded into both the UI document and the render worker).
import interVar from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url';
import interVarItalic from '@fontsource-variable/inter/files/inter-latin-wght-italic.woff2?url';
import jbm400 from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2?url';
import jbm700 from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff2?url';
import bebas from '@fontsource/bebas-neue/files/bebas-neue-latin-400-normal.woff2?url';
import playfair400 from '@fontsource/playfair-display/files/playfair-display-latin-400-normal.woff2?url';
import playfair900 from '@fontsource/playfair-display/files/playfair-display-latin-900-normal.woff2?url';
import mont400 from '@fontsource/montserrat/files/montserrat-latin-400-normal.woff2?url';
import mont800 from '@fontsource/montserrat/files/montserrat-latin-800-normal.woff2?url';
import mont900 from '@fontsource/montserrat/files/montserrat-latin-900-normal.woff2?url';
import grotesk400 from '@fontsource/space-grotesk/files/space-grotesk-latin-400-normal.woff2?url';
import grotesk700 from '@fontsource/space-grotesk/files/space-grotesk-latin-700-normal.woff2?url';
import orbitron400 from '@fontsource/orbitron/files/orbitron-latin-400-normal.woff2?url';
import orbitron900 from '@fontsource/orbitron/files/orbitron-latin-900-normal.woff2?url';
import pacifico from '@fontsource/pacifico/files/pacifico-latin-400-normal.woff2?url';
import anton from '@fontsource/anton/files/anton-latin-400-normal.woff2?url';
import type { FontSpec } from './render/protocol';

const abs = (u: string) => new URL(u, globalThis.location?.href ?? 'http://localhost/').href;

export const BUNDLED_FONTS: FontSpec[] = [
  { family: 'Inter', url: abs(interVar), weight: '100 900', style: 'normal' },
  { family: 'Inter', url: abs(interVarItalic), weight: '100 900', style: 'italic' },
  { family: 'JetBrains Mono', url: abs(jbm400), weight: '400' },
  { family: 'JetBrains Mono', url: abs(jbm700), weight: '700' },
  { family: 'Bebas Neue', url: abs(bebas), weight: '400' },
  { family: 'Playfair Display', url: abs(playfair400), weight: '400' },
  { family: 'Playfair Display', url: abs(playfair900), weight: '900' },
  { family: 'Montserrat', url: abs(mont400), weight: '400' },
  { family: 'Montserrat', url: abs(mont800), weight: '800' },
  { family: 'Montserrat', url: abs(mont900), weight: '900' },
  { family: 'Space Grotesk', url: abs(grotesk400), weight: '400' },
  { family: 'Space Grotesk', url: abs(grotesk700), weight: '700' },
  { family: 'Orbitron', url: abs(orbitron400), weight: '400' },
  { family: 'Orbitron', url: abs(orbitron900), weight: '900' },
  { family: 'Pacifico', url: abs(pacifico), weight: '400' },
  { family: 'Anton', url: abs(anton), weight: '400' },
];

export const FONT_FAMILIES = [...new Set(BUNDLED_FONTS.map((f) => f.family)), 'Arial', 'Helvetica', 'Georgia', 'Times New Roman', 'Courier New', 'Impact', 'Verdana', 'Trebuchet MS'];

/** Load bundled fonts into the UI document (used for measuring overlays and the font menu). */
export async function loadDocumentFonts(): Promise<void> {
  if (typeof document === 'undefined' || typeof FontFace === 'undefined') return;
  await Promise.all(
    BUNDLED_FONTS.map(async (f) => {
      try {
        const face = new FontFace(f.family, `url(${f.url})`, { weight: f.weight ?? 'normal', style: f.style ?? 'normal' });
        await face.load();
        document.fonts.add(face);
      } catch {
        /* ignore */
      }
    }),
  );
}
