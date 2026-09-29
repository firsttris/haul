import { describe, expect, it } from 'vitest';
import { archiveSet, partialArchives } from './archive';

describe('archive sets', () => {
  it('groups volumes like the core', () => {
    expect(archiveSet('Film.2026.part03.rar')).toEqual({ key: 'film.2026|part', label: 'Film.2026' });
    expect(archiveSet('a.r01')?.key).toBe(archiveSet('a.rar')?.key);
    expect(archiveSet('b.7z.002')?.key).toBe('b.7z|split');
    expect(archiveSet('movie.mkv')).toBeNull();
  });

  it('warns only about sets that are partly checked', () => {
    const files = [
      { id: 1, name: 'Film.part1.rar' },
      { id: 2, name: 'Film.part2.rar' },
      { id: 3, name: 'Film.part3.rar' },
      { id: 4, name: 'Other.part1.rar' },
      { id: 5, name: 'Other.part2.rar' },
      { id: 6, name: 'single.rar' },
      { id: 7, name: 'readme.txt' },
    ];
    // Film: one of three unchecked; Other: all unchecked (fine); single.rar and readme alone.
    expect(partialArchives(files, new Set([2, 4, 5, 6, 7]))).toEqual([{ label: 'Film', checked: 2, total: 3, ids: [1, 2, 3] }]);
    expect(partialArchives(files, new Set())).toEqual([]);
  });
});
