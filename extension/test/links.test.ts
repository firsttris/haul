import { describe, expect, it } from 'vitest';
import { cnlAction, linksInText } from '../src/links';
import { normalizeServer, originPattern } from '../src/settings';

describe('linksInText', () => {
  it('finds links in free text, without duplicates and trailing punctuation', () => {
    const text = 'Teil 1: https://a.example/f/1, Teil 2 (https://a.example/f/2).\nhttps://a.example/f/1 nochmal; ftp://x';
    expect(linksInText(text)).toEqual(['https://a.example/f/1', 'https://a.example/f/2']);
  });

  it('returns nothing for text without links', () => {
    expect(linksInText('nur Text')).toEqual([]);
  });
});

describe('cnlAction', () => {
  it.each([
    ['http://127.0.0.1:9666/flash/addcrypted2', 'addcrypted2'],
    ['http://localhost:9666/flash/add', 'add'],
    ['http://[::1]:9666/flash/add/', 'add'],
    ['http://127.0.0.1:9666/flash/addcrypted2?x=1', 'addcrypted2'],
  ])('%s → %s', (url, action) => {
    expect(cnlAction(url)).toBe(action);
  });

  it.each([
    'http://127.0.0.1:9666/jdcheck.js',
    'http://127.0.0.1:9666/flash/addcrypted',
    'http://127.0.0.1:9667/flash/add',
    'http://example.com:9666/flash/add',
    'http://127.0.0.1:9666/flash/addx',
  ])('ignores %s', (url) => {
    expect(cnlAction(url)).toBeUndefined();
  });
});

describe('settings', () => {
  it('normalizes the server address', () => {
    expect(normalizeServer(' server.local:8080/ ')).toBe('http://server.local:8080');
    expect(normalizeServer('https://haul.example/sub/')).toBe('https://haul.example/sub');
    expect(normalizeServer('')).toBe('');
  });

  it('builds the host permission pattern without the port', () => {
    expect(originPattern('http://server.local:8080')).toBe('http://server.local/*');
  });
});
