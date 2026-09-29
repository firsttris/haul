import { describe as group, expect, it } from 'vitest';
import type { Download } from '../api';
import { messages } from '../i18n';
import { describe } from './status';

const t = messages.de;
const done = { status: 'downloading', hashType: 'sha256', size: 100, bytesDone: 100, error: null, retryAt: null } as unknown as Download;

group('status after the last byte', () => {
  it('shows the phase the core reports', () => {
    expect(describe(done, t, undefined, { bytesDone: 100, size: 100, speed: 0, phase: 'hashWait' })).toEqual({
      label: 'Wartet auf Prüfung',
      tone: 'wait',
    });
    expect(describe(done, t, undefined, { bytesDone: 100, size: 100, speed: 0, phase: 'hashing' }).label).toBe('Prüfe Datei …');
  });

  it('does not claim a check the core does not run (checking switched off)', () => {
    expect(describe(done, t, undefined, { bytesDone: 100, size: 100, speed: 0 }).label).toBe('Lädt');
  });

  it('guesses from the stored state before live data arrives', () => {
    expect(describe(done, t).label).toBe('Prüfe Datei …');
  });
});
