import { describe, expect, it } from 'vitest';
import { loadUnchecked, parseUnchecked, pruneUnchecked, saveUnchecked, serializeUnchecked } from './unchecked';

describe('unchecked files in the Linksammler', () => {
  it('survives a round trip and ignores broken values', () => {
    const m = new Map([
      [3, new Set([10, 11])],
      [4, new Set<number>()],
    ]);
    const raw = serializeUnchecked(m);
    expect(raw).toBe('{"3":[10,11]}');
    expect(parseUnchecked(raw)).toEqual(new Map([[3, new Set([10, 11])]]));
    expect(serializeUnchecked(new Map())).toBeNull();
    expect(parseUnchecked('not json')).toEqual(new Map());
    expect(parseUnchecked('{"x":[1],"5":"no","6":[1.5,"a",7]}')).toEqual(new Map([[6, new Set([7])]]));
  });

  it('drops started, discarded and deleted files, and keeps the map when nothing changed', () => {
    const m = new Map([
      [1, new Set([10, 11])],
      [2, new Set([20])],
    ]);
    const packages = [{ id: 1, downloads: [{ id: 10 }, { id: 12 }] }];
    expect(pruneUnchecked(m, packages)).toEqual(new Map([[1, new Set([10])]]));
    const same = new Map([[1, new Set([10])]]);
    expect(pruneUnchecked(same, packages)).toBe(same);
  });

  it('works without browser storage (tests, blocked storage)', () => {
    expect(loadUnchecked()).toEqual(new Map());
    expect(() => saveUnchecked(new Map([[1, new Set([2])]]))).not.toThrow();
  });
});
