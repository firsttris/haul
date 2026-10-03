import { localeOf } from './i18n';

const formats = new Map<string, { nf0: Intl.NumberFormat; nf1: Intl.NumberFormat }>();
/** Number formats of the current language. */
function nf() {
  const locale = localeOf();
  let f = formats.get(locale);
  if (!f) {
    f = {
      nf0: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }),
      nf1: new Intl.NumberFormat(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 }),
    };
    formats.set(locale, f);
  }
  return f;
}

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined || n < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? nf().nf0.format(v) : nf().nf1.format(v)} ${units[i]}`;
}

export function speed(bps: number | undefined): string {
  if (!bps) return '—';
  return `${bytes(bps)}/s`;
}

export function duration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !isFinite(sec) || sec < 0) return '—';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (x: number) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

export function percent(done: number, size: number | null | undefined): number {
  if (!size || size <= 0) return 0;
  return Math.min(100, Math.floor((done / size) * 100));
}

export function date(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString(localeOf(), { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function dateTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(localeOf());
}
