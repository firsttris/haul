import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { localize, pluginText } from './i18n';
import { bilingual } from '../../packages/plugin-sdk/src/index';

// What the Rust side's msg! produces: the key and its inputs as JSON between \u0002 and \u0003.
const rust = (key: string, inputs: Record<string, string> = {}) => `\u0002${JSON.stringify([key, inputs])}\u0003`;
// Entries stored by older versions: \u0002 de \u001f en \u0003.
const old = (de: string, en: string) => `\u0002${de}\u001f${en}\u0003`;

describe('localize', () => {
  it('renders server messages inside longer text, with messages as inputs', () => {
    const msg = `Paket 3: ${rust('server_download_offline', { status: '404' })} ${rust('server_download_afterAttempts', { attempts: '5' })}`;
    expect(localize(msg, 'de')).toBe('Paket 3: Datei offline (HTTP 404) (nach 5 Versuchen)');
    expect(localize(msg, 'en')).toBe('Paket 3: File offline (HTTP 404) (after 5 attempts)');
    const nested = rust('server_extract_failed', { detail: `7-Zip (${rust('server_extract_code', { code: '2' })}): x` });
    expect(localize(nested, 'de')).toBe('Entpacken fehlgeschlagen: 7-Zip (Code 2): x');
    expect(localize(rust('no_such_key'), 'en')).toBe('no_such_key');
  });

  it('leaves plain text alone and reads entries of older versions', () => {
    expect(localize('unrar: CRC failed', 'en')).toBe('unrar: CRC failed');
    expect(localize(null, 'en')).toBeNull();
    expect(localize(`Paket 3: ${old('Datei offline', 'File offline')}`, 'en')).toBe('Paket 3: File offline');
  });

  it('reads plugin messages and survives a cut-off message', () => {
    expect(localize(bilingual('Gofile: privater Ordner', 'Gofile: private folder'), 'en')).toBe('Gofile: private folder');
    expect(localize(old('Datei offline', 'File off').slice(0, -1), 'en')).toBe('File off');
    expect(localize('\u0002nur deutsch\u0003', 'en')).toBe('nur deutsch');
  });

  it('localizes plugin texts', () => {
    expect(pluginText({ de: 'Passwort', en: 'Password' }, 'en')).toBe('Password');
    expect(pluginText(bilingual('Passwort', 'Password'), 'de')).toBe('Passwort');
  });
});

const read = (lang: string) =>
  JSON.parse(readFileSync(new URL(`../messages/${lang}.json`, import.meta.url), 'utf8')) as Record<string, unknown>;
const de = read('de');
const en = read('en');
const keys = Object.keys(en).filter((k) => k !== '$schema');

/** Placeholders a message uses, over all variants; escaped braces are text. */
const placeholders = (v: unknown) =>
  [...new Set([...JSON.stringify(v).matchAll(/(?<!\\\\)\{(\w+)\}/g)].map((m) => m[1]))].sort().join(',');
const variants = (v: unknown): string[] =>
  typeof v === 'string' ? [v] : (v as { match: Record<string, string> }[]).flatMap((x) => Object.values(x.match));

const files = (dir: string, ext: RegExp): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return e.name === 'paraglide' ? [] : files(join(dir, e.name), ext);
    return ext.test(e.name) ? [readFileSync(join(dir, e.name), 'utf8')] : [];
  });

describe('messages/*.json', () => {
  it('has every message in both languages, none empty, with the same placeholders', () => {
    expect(Object.keys(de).sort()).toEqual(Object.keys(en).sort());
    expect(keys.filter((k) => placeholders(de[k]) !== placeholders(en[k]))).toEqual([]);
    expect(keys.filter((k) => [...variants(de[k]), ...variants(en[k])].some((t) => !t.trim()))).toEqual([]);
  });

  it('every message is used, every used key exists', () => {
    const root = new URL('../..', import.meta.url).pathname;
    // Message calls only count in files that import the Paraglide messages as m
    const ui = files(join(root, 'ui/src'), /\.tsx?$/).filter((s) => s.includes("paraglide/messages'"));
    const viaM = ui.flatMap((s) => [...s.matchAll(/\bm\.(\w+)\b/g)].map((x) => x[1]!));
    const rustKeys = files(join(root, 'crates'), /\.rs$/).flatMap((s) => [...s.matchAll(/\bmsg!\(\s*"(\w+)"/g)].map((x) => x[1]!));
    const used = new Set([...viaM, ...rustKeys]);
    expect(keys.filter((k) => !used.has(k))).toEqual([]);
    const called = [...viaM, ...rustKeys];
    expect(called.filter((k) => !(k in en))).toEqual([]);
  });
});
