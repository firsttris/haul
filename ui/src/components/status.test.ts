import { describe as group, expect, it } from 'vitest';
import type { Download } from '../api';
import * as m from '../paraglide/messages';
import { describe } from './status';

const done = { status: 'downloading', hashType: 'sha256', size: 100, bytesDone: 100, error: null, retryAt: null } as unknown as Download;

group('status after the last byte', () => {
  it('shows the phase the core reports', () => {
    expect(describe(done, undefined, { bytesDone: 100, size: 100, speed: 0, phase: 'hashWait' })).toEqual({
      label: m.status_verifyWait(),
      tone: 'wait',
    });
    expect(describe(done, undefined, { bytesDone: 100, size: 100, speed: 0, phase: 'hashing' }).label).toBe(m.status_verifying());
  });

  it('does not claim a check the core does not run (checking switched off)', () => {
    expect(describe(done, undefined, { bytesDone: 100, size: 100, speed: 0 }).label).toBe(m.status_downloading());
  });

  it('guesses from the stored state before live data arrives', () => {
    expect(describe(done).label).toBe(m.status_verifying());
  });
});
