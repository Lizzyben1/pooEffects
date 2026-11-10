// ─────────────────────────────────────────────────────────────────────────────
// Incremental document sync (UI thread → render worker).
//
// The project is an immutable tree with structural sharing: an edit replaces only
// the objects on the path to the change. `diffTree` exploits that — it descends
// only where references differ — to describe an edit as a short list of patches,
// so a drag does not re-serialise the whole project on every pointer move.
// `applyPatches` replays them immutably on the worker's copy, which keeps the
// identity of untouched layers and keyframes (identity-keyed caches survive).
// ─────────────────────────────────────────────────────────────────────────────

export type PatchPath = (string | number)[];

export type Patch =
  /** set the value at path */
  | { p: PatchPath; v: unknown }
  /** delete the key at path */
  | { p: PatchPath; del: true }
  /** rebuild an array of `{id}` items: existing items are kept by id, `add` supplies new ones */
  | { p: PatchPath; ids: string[]; add: Record<string, unknown> };

type Obj = Record<string, unknown>;

const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);

/** id → item for an array whose every element is an object with a unique string id, else null. */
function byId(arr: unknown[]): Map<string, unknown> | null {
  const m = new Map<string, unknown>();
  for (const it of arr) {
    if (!isObj(it) || typeof it.id !== 'string' || m.has(it.id)) return null;
    m.set(it.id, it);
  }
  return m;
}

/**
 * Patches that turn `a` into `b`, or null when the trees are too different for patching to pay off
 * (more than `budget` nodes had to be compared) — send the whole document instead.
 */
export function diffTree(a: unknown, b: unknown, budget = 20000): Patch[] | null {
  const out: Patch[] = [];
  let visited = 0;
  const walk = (x: unknown, y: unknown, path: PatchPath): boolean => {
    if (x === y) return true;
    if (++visited > budget) return false;
    if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length === y.length) {
        // same shape: compare element-wise, but never descend into a different entity
        let sameIds = true;
        for (let i = 0; i < x.length && sameIds; i++) {
          const p = x[i], q = y[i];
          if (p !== q && isObj(p) && isObj(q) && typeof p.id === 'string' && p.id !== q.id) sameIds = false;
        }
        if (sameIds) {
          for (let i = 0; i < x.length; i++) if (!walk(x[i], y[i], [...path, i])) return false;
          return true;
        }
      }
      // items were added, removed or reordered: keep the survivors, send only the newcomers
      const old = x.length && y.length ? byId(x) : null;
      const next = old ? byId(y) : null;
      if (old && next) {
        const add: Obj = {};
        const ids: string[] = [];
        for (const it of y as Obj[]) {
          const id = it.id as string;
          ids.push(id);
          if (!old.has(id)) add[id] = it;
        }
        out.push({ p: path, ids, add });
        for (let i = 0; i < y.length; i++) {
          const prev = old.get(ids[i]);
          if (prev !== undefined && !walk(prev, y[i], [...path, i])) return false;
        }
        return true;
      }
      out.push({ p: path, v: y });
      return true;
    }
    if (isObj(x) && isObj(y)) {
      if (typeof x.id === 'string' && x.id !== y.id) {
        out.push({ p: path, v: y });
        return true;
      }
      for (const k of Object.keys(y)) {
        if (!(k in x)) out.push({ p: [...path, k], v: y[k] });
        else if (!walk(x[k], y[k], [...path, k])) return false;
      }
      for (const k of Object.keys(x)) if (!(k in y)) out.push({ p: [...path, k], del: true });
      return true;
    }
    out.push({ p: path, v: y });
    return true;
  };
  return walk(a, b, []) ? out : null;
}

/** Apply patches without mutating `root`; untouched subtrees keep their identity. */
export function applyPatches<T>(root: T, patches: Patch[]): T {
  if (!patches.length) return root;
  // nodes created during this batch may be mutated in place; everything else is copied on first write
  const fresh = new WeakSet<object>();
  const copy = (n: unknown): Obj | unknown[] => {
    const c = Array.isArray(n) ? n.slice() : { ...(n as Obj) };
    fresh.add(c);
    return c;
  };
  let top: unknown = root;
  for (const patch of patches) {
    const { p } = patch;
    if (!p.length) {
      if ('ids' in patch) top = reorder(top as unknown[], patch.ids, patch.add);
      else if ('v' in patch) top = patch.v;
      if (typeof top === 'object' && top !== null) fresh.add(top);
      continue;
    }
    if (typeof top !== 'object' || top === null) throw new Error('patch path does not exist');
    if (!fresh.has(top)) top = copy(top);
    let node = top as Obj;
    for (let i = 0; i < p.length - 1; i++) {
      let child = node[p[i] as string];
      if (typeof child !== 'object' || child === null) throw new Error(`patch path does not exist: ${p.join('.')}`);
      if (!fresh.has(child)) {
        child = copy(child);
        node[p[i] as string] = child;
      }
      node = child as Obj;
    }
    const key = p[p.length - 1] as string;
    if ('del' in patch) delete node[key];
    else if ('ids' in patch) {
      const arr = reorder(node[key] as unknown[], patch.ids, patch.add);
      fresh.add(arr);
      node[key] = arr;
    } else node[key] = patch.v;
  }
  return top as T;
}

function reorder(prev: unknown[], ids: string[], add: Record<string, unknown>): unknown[] {
  const old = new Map<string, unknown>();
  for (const it of prev ?? []) old.set((it as { id: string }).id, it);
  return ids.map((id) => {
    const it = id in add ? add[id] : old.get(id);
    if (it === undefined) throw new Error(`patch refers to a missing item: ${id}`);
    return it;
  });
}
