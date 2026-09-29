import type { Captcha, Download } from '../api';
import { duration } from '../format';
import { localize, type Messages } from '../i18n';

export type Tone = 'ok' | 'run' | 'wait' | 'err';

export const toneColor: Record<Tone, { color: string; bar: string }> = {
  ok: { color: 'var(--ok)', bar: 'var(--ok)' },
  run: { color: 'var(--accent)', bar: 'var(--accent)' },
  wait: { color: 'var(--muted-2)', bar: 'var(--wait-bar)' },
  err: { color: 'var(--err)', bar: 'var(--err)' },
};

/** `waiting`: links whose plugin call waits for the user, and for what (see useCaptchas). */
export function describe(d: Download, t: Messages, waiting?: Map<string, Captcha['kind']>, now = Date.now()): { label: string; tone: Tone } {
  const s = t.status;
  const asks = (d.status === 'resolving' || d.status === 'crawling') && waiting?.get(d.url);
  if (asks) return { label: asks === 'password' ? s.password : s.captcha, tone: 'run' };
  const error = localize(d.error);
  switch (d.status) {
    case 'finished':
      return { label: s.finished, tone: 'ok' };
    case 'downloading':
      // All bytes are there and the hoster published a checksum: the core is verifying.
      if (d.hashType && d.size !== null && d.size > 0 && d.bytesDone >= d.size) return { label: s.verifying, tone: 'run' };
      return { label: s.downloading, tone: 'run' };
    case 'resolving':
      return { label: s.resolving, tone: 'run' };
    case 'paused':
      return { label: s.paused, tone: 'wait' };
    case 'crawling':
      return { label: s.crawling, tone: 'run' };
    case 'collected':
      return d.online === 'offline'
        ? { label: s.offline, tone: 'err' }
        : { label: d.online === 'online' ? s.online : s.unchecked, tone: d.online === 'online' ? 'ok' : 'wait' };
    case 'failed':
      return { label: error || s.error, tone: 'err' };
    case 'queued':
      if (d.retryAt && d.retryAt > now) {
        const next = s.retryIn(duration((d.retryAt - now) / 1000));
        return { label: error ? `${next} · ${error}` : next, tone: 'err' };
      }
      return { label: s.waiting, tone: 'wait' };
  }
}

export const isActive = (d: Download) => d.status === 'downloading' || d.status === 'resolving';
export const isWaiting = (d: Download) => d.status === 'queued' || d.status === 'paused' || d.status === 'crawling';
