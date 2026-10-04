// Demo project entry points: the scene builder and regeneration of its procedural media.

import type { Project } from '../core/types';
import { getMedia, registerProcedural } from '../state/media';
import { DEMO_MUSIC_KEY, generateDemoMusic } from './music';

export { buildDemoProject, type DemoBuild } from './project';

const generators: Record<string, () => Promise<Blob>> = {
  [DEMO_MUSIC_KEY]: generateDemoMusic,
};

const inflight = new Map<string, Promise<void>>();

/**
 * Procedural footage is not stored in IndexedDB or project files; it is regenerated on load
 * (deterministically) whenever a project references it.
 */
export async function ensureProceduralMedia(project: Project): Promise<void> {
  await Promise.all(
    Object.values(project.footage).map((f) => {
      if (!f.procedural || getMedia(f.id)) return Promise.resolve();
      const gen = generators[f.procedural];
      if (!gen) return Promise.resolve();
      let p = inflight.get(f.id);
      if (!p) {
        p = gen()
          .then((blob) => registerProcedural(f.id, blob))
          .catch((e) => console.warn(`[demo] could not generate ${f.name}:`, e))
          .finally(() => inflight.delete(f.id));
        inflight.set(f.id, p);
      }
      return p;
    }),
  );
}
