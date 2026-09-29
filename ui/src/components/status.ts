import type { Download } from '../api';
import { duration } from '../format';
import type { Messages } from '../i18n';

export type Tone = 'ok' | 'run' | 'wait' | 'err';

export const toneColor: Record<Tone, { color: string; bar: string }> = {
  ok: { color: 'var(--ok)', bar: 'var(--ok)' },
  run: { color: 'var(--accent)', bar: 'var(--accent)' },
  wait: { color: 'var(--muted-2)', bar: 'var(--wait-bar)' },
  err: { color: 'var(--err)', bar: 'var(--err)' },
};

export function describe(d: Download, t: Messages, now = Date.now()): { label: string; tone: Tone } {
  const s = t.status;
  switch (d.status) {
    case 'finished':
      return { label: s.finished, tone: 'ok' };
    case 'downloading':
      return { label: s.downloading, tone: 'run' };
    case 'resolving':
      return { label: s.resolving, tone: 'run' };
    case 'paused':
      return { label: s.paused, tone: 'wait' };
    case 'collected':
      return d.online === 'offline'
        ? { label: s.offline, tone: 'err' }
        : { label: d.online === 'online' ? s.online : s.unchecked, tone: d.online === 'online' ? 'ok' : 'wait' };
    case 'failed':
      return { label: d.error || s.error, tone: 'err' };
    case 'queued':
      if (d.retryAt && d.retryAt > now) {
        const next = s.retryIn(duration((d.retryAt - now) / 1000));
        return { label: d.error ? `${next} · ${d.error}` : next, tone: 'err' };
      }
      return { label: s.waiting, tone: 'wait' };
  }
}

export const isActive = (d: Download) => d.status === 'downloading' || d.status === 'resolving';
export const isWaiting = (d: Download) => d.status === 'queued' || d.status === 'paused';
