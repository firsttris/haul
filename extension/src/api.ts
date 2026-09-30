import type { Settings } from './settings';

/** A failure with a key into `_locales` (and details for the log). */
export class HaulError extends Error {
  constructor(
    readonly key: 'notConfigured' | 'unauthorized' | 'unreachable' | 'serverError' | 'noLinks' | 'noPermission',
    detail?: string,
  ) {
    super(detail ?? key);
  }
}

async function call(s: Settings, path: string, init: RequestInit = {}): Promise<Response> {
  if (!s.server || !s.token) throw new HaulError('notConfigured');
  let res: Response;
  try {
    res = await fetch(`${s.server}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${s.token}` },
    });
  } catch (e) {
    throw new HaulError('unreachable', String(e));
  }
  if (res.status === 401) throw new HaulError('unauthorized');
  if (!res.ok) throw new HaulError('serverError', `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

export interface Stats {
  active: number;
  queued: number;
}

/** Checks address and token; also used for the popup's status line. */
export async function stats(s: Settings): Promise<Stats> {
  const res = await call(s, '/api/stats');
  return (await res.json()) as Stats;
}

/** Adds links to Haul, into the link grabber unless `start` is set. */
export async function sendLinks(s: Settings, links: string[], sourcePage?: string): Promise<number> {
  if (links.length === 0) throw new HaulError('noLinks');
  const res = await call(s, '/api/links', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ links: links.join('\n'), start: s.start, source: 'extension', sourcePage }),
  });
  return ((await res.json()) as { packageId: number }).packageId;
}

/**
 * Passes a Click'n'Load request on, like haul-cnl: the same form body to `/api/cnl/flash/<action>`.
 * The page's address goes along as `source`, since the extension cannot send its Referer.
 */
export async function forwardCnl(s: Settings, action: 'add' | 'addcrypted2', body: string, page: string): Promise<void> {
  const form = new URLSearchParams(body);
  if (!form.get('source')) form.set('source', page);
  await call(s, `/api/cnl/flash/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
}
