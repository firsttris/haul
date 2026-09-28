import type { Download } from '../api';
import { duration } from '../format';

export type Tone = 'ok' | 'run' | 'wait' | 'err';

export const toneColor: Record<Tone, { color: string; bar: string }> = {
  ok: { color: 'var(--ok)', bar: 'var(--ok)' },
  run: { color: 'var(--accent)', bar: 'var(--accent)' },
  wait: { color: 'var(--muted-2)', bar: 'var(--wait-bar)' },
  err: { color: 'var(--err)', bar: 'var(--err)' },
};

export function describe(d: Download, now = Date.now()): { label: string; tone: Tone } {
  switch (d.status) {
    case 'finished':
      return { label: 'Fertig', tone: 'ok' };
    case 'downloading':
      return { label: 'Lädt', tone: 'run' };
    case 'resolving':
      return { label: 'Verbinde …', tone: 'run' };
    case 'paused':
      return { label: 'Pausiert', tone: 'wait' };
    case 'collected':
      return d.online === 'offline'
        ? { label: 'Datei offline', tone: 'err' }
        : { label: d.online === 'online' ? 'Online' : 'Ungeprüft', tone: d.online === 'online' ? 'ok' : 'wait' };
    case 'failed':
      return { label: d.error || 'Fehler', tone: 'err' };
    case 'queued':
      if (d.retryAt && d.retryAt > now) {
        const next = `Neuer Versuch in ${duration((d.retryAt - now) / 1000)}`;
        return { label: d.error ? `${next} · ${d.error}` : next, tone: 'err' };
      }
      return { label: 'Wartend', tone: 'wait' };
  }
}

export const isActive = (d: Download) => d.status === 'downloading' || d.status === 'resolving';
export const isWaiting = (d: Download) => d.status === 'queued' || d.status === 'paused';
