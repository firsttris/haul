/**
 * The Linksammler's unchecked files per package, kept in this browser so a reload does not
 * check everything again. Everything else about the Linksammler lives on the server; this is
 * only a view setting, so browser storage is enough (and it may be missing: private windows,
 * blocked storage).
 */
export type Unchecked = Map<number, Set<number>>;

const KEY = 'haul.collector.unchecked';

export function parseUnchecked(raw: string | null): Unchecked {
  const out: Unchecked = new Map();
  if (!raw) return out;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    for (const [pkg, ids] of Object.entries(data)) {
      const id = Number(pkg);
      if (!Number.isInteger(id) || !Array.isArray(ids)) continue;
      const set = new Set(ids.filter((n): n is number => Number.isInteger(n)));
      if (set.size) out.set(id, set);
    }
  } catch {
    /* broken value: start over */
  }
  return out;
}

export function serializeUnchecked(m: Unchecked): string | null {
  const data: Record<string, number[]> = {};
  for (const [pkg, ids] of m) if (ids.size) data[pkg] = [...ids];
  return Object.keys(data).length ? JSON.stringify(data) : null;
}

export function loadUnchecked(): Unchecked {
  try {
    return parseUnchecked(localStorage.getItem(KEY));
  } catch {
    return new Map();
  }
}

export function saveUnchecked(m: Unchecked) {
  try {
    const value = serializeUnchecked(m);
    if (value) localStorage.setItem(KEY, value);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked: the checkboxes last for this page */
  }
}

/** Drops packages and files that are gone (started, discarded, deleted); the same map if nothing changed. */
export function pruneUnchecked(m: Unchecked, packages: { id: number; downloads: { id: number }[] }[]): Unchecked {
  const next: Unchecked = new Map();
  let changed = false;
  for (const [pkg, ids] of m) {
    const p = packages.find((x) => x.id === pkg);
    const present = new Set(p?.downloads.map((d) => d.id) ?? []);
    const kept = new Set([...ids].filter((id) => present.has(id)));
    if (kept.size !== ids.size) changed = true;
    if (kept.size) next.set(pkg, kept);
  }
  return changed ? next : m;
}
