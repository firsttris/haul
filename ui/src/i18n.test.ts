import { describe, expect, it } from 'vitest';
import { localize, pluginText } from './i18n';
import { t } from '../../packages/plugin-sdk/src/index';

// What the Rust side's tr! produces: \u0002 de \u001f en \u0003.
const rust = (de: string, en: string) => `\u0002${de}\u001f${en}\u0003`;

describe('localize', () => {
  it('picks the language inside longer text', () => {
    const msg = `Paket 3: ${rust('Datei offline', 'File offline')} (HTTP 404) ${rust('(nach 5 Versuchen)', '(after 5 attempts)')}`;
    expect(localize(msg, 'de')).toBe('Paket 3: Datei offline (HTTP 404) (nach 5 Versuchen)');
    expect(localize(msg, 'en')).toBe('Paket 3: File offline (HTTP 404) (after 5 attempts)');
  });

  it('leaves plain text and old entries alone', () => {
    expect(localize('unrar: CRC failed', 'en')).toBe('unrar: CRC failed');
    expect(localize(null, 'en')).toBeNull();
  });

  it('reads plugin messages and survives a cut-off message', () => {
    expect(localize(t('Gofile: privater Ordner', 'Gofile: private folder'), 'en')).toBe('Gofile: private folder');
    expect(localize(rust('Datei offline', 'File off').slice(0, -1), 'en')).toBe('File off');
    expect(localize('\u0002nur deutsch\u0003', 'en')).toBe('nur deutsch');
  });

  it('localizes plugin texts', () => {
    expect(pluginText({ de: 'Passwort', en: 'Password' }, 'en')).toBe('Password');
    expect(pluginText(t('Passwort', 'Password'), 'de')).toBe('Passwort');
  });
});
