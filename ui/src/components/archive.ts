/**
 * The multi-part archive a file belongs to, like `set_key` in the core's extract.rs:
 * `x.part3.rar`, `x.r01` + `x.rar`, `x.7z.002` all belong to `x`. `null` for anything else.
 */
export function archiveSet(name: string): { key: string; label: string } | null {
  const rules: [RegExp, string][] = [
    [/^(.*)\.part0*\d+\.rar$/i, 'part'],
    [/^(.*\.(?:7z|zip|rar))\.0*\d+$/i, 'split'],
    [/^(.*)\.r\d{2}$/i, 'rar'],
    [/^(.*)\.rar$/i, 'rar'],
  ];
  for (const [re, kind] of rules) {
    const m = re.exec(name);
    if (m) return { key: `${m[1].toLowerCase()}|${kind}`, label: m[1] };
  }
  return null;
}

export interface PartialArchive {
  label: string;
  checked: number;
  total: number;
  /** All parts, to check them together. */
  ids: number[];
}

/** Multi-part archives of which some parts are checked and some are not: extracting will fail. */
export function partialArchives(files: { id: number; name: string }[], unchecked: Set<number>): PartialArchive[] {
  const sets = new Map<string, PartialArchive>();
  for (const f of files) {
    const set = archiveSet(f.name);
    if (!set) continue;
    const s = sets.get(set.key) ?? { label: set.label, checked: 0, total: 0, ids: [] };
    s.total += 1;
    if (!unchecked.has(f.id)) s.checked += 1;
    s.ids.push(f.id);
    sets.set(set.key, s);
  }
  return [...sets.values()].filter((s) => s.total > 1 && s.checked > 0 && s.checked < s.total);
}
