/** What the user sets on the options page, kept in `chrome.storage.local`. */
export interface Settings {
  /** Haul's address, e.g. `http://server.local:8080`. */
  server: string;
  /** The API token from Haul's Settings → Click'n'Load from the desktop. */
  token: string;
  /** Take over Click'n'Load buttons on web pages. */
  cnl: boolean;
  /** Queue sent links right away instead of keeping them in the link grabber. */
  start: boolean;
}

export const DEFAULTS: Settings = { server: '', token: '', cnl: true, start: false };

export async function loadSettings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get(Object.keys(DEFAULTS) as (keyof Settings)[])) as Partial<Settings>;
  return { ...DEFAULTS, ...stored };
}

export async function saveSettings(s: Partial<Settings>): Promise<void> {
  await chrome.storage.local.set(s);
}

/** `http://server:8080/` → `http://server:8080`; adds `http://` when the scheme is missing. */
export function normalizeServer(input: string): string {
  let s = input.trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  const u = new URL(s);
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

/** The host permission pattern for the server, e.g. `http://server.local:8080/*`. */
export function originPattern(server: string): string {
  const u = new URL(server);
  return `${u.protocol}//${u.hostname}/*`;
}
