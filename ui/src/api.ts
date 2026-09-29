import { localize, type PluginText } from './i18n';

export type Status = 'collected' | 'crawling' | 'queued' | 'resolving' | 'downloading' | 'paused' | 'finished' | 'failed';

export interface Download {
  id: number;
  packageId: number;
  url: string;
  pluginId: string | null;
  status: Status;
  online: 'unknown' | 'online' | 'offline';
  name: string;
  size: number | null;
  bytesDone: number;
  error: string | null;
  attempts: number;
  retryAt: number | null;
  createdAt: number;
  finishedAt: number | null;
  /** The hoster's checksum type, if it published one. */
  hashType: 'md5' | 'sha1' | 'sha256' | 'mega' | null;
  /** Checked after the download: matched, did not match, or not checked. */
  hashOk: boolean | null;
}

export interface Package {
  id: number;
  name: string;
  targetDir: string;
  source: string;
  sourcePage: string | null;
  collector: boolean;
  extract: 'pending' | 'running' | 'done' | 'failed' | null;
  extractError: string | null;
  createdAt: number;
  hasPasswords: boolean;
  downloads: Download[];
}

export interface Stats {
  active: number;
  slots: number;
  connectionsPerFile: number;
  queued: number;
  queuedBytes: number;
  finishedToday: number;
  finishedTodayBytes: number;
  speedLimitKib: number;
  storage: { label: string; path: string; total: number; free: number }[];
  premium: { pluginId: string; trafficLeft: number | null; validUntil: number | null }[];
}

export interface Account {
  id: number;
  pluginId: string;
  pluginName: string | null;
  user: string;
  enabled: boolean;
  status: 'unchecked' | 'checking' | 'valid' | 'invalid' | 'error';
  premium: boolean | null;
  trafficLeft: number | null;
  validUntil: number | null;
  error: string | null;
  checkedAt: number | null;
}

export interface Plugin {
  id: string;
  name: string;
  version: string;
  matches: { source: string; flags: string }[];
  accountRequired: boolean;
  /** Plugin texts: plain or one per language. */
  account: { userLabel?: PluginText; secretLabel?: PluginText; help?: PluginText } | null;
  hasCheck: boolean;
  hasCheckAccount: boolean;
  builtin: boolean;
  file: string;
  /** A custom plugin that hides the built-in one; `newer`: the built-in version is higher. */
  replaces: { version: string; file: string; newer: boolean } | null;
}

export interface PluginList {
  plugins: Plugin[];
  errors: { file: string; error: string }[];
}

export interface FileEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  modified: number | null;
  kind: 'archive' | 'video' | 'other' | null;
  package: { id: number; name: string; extract: Package['extract']; extractError: string | null } | null;
  archives: number;
  extracting: number | null;
  error: string | null;
}

export interface FolderView {
  path: string;
  root: string;
  entries: FileEntry[];
  extracting: number | null;
  error: string | null;
}

export interface Settings {
  maxParallel: number;
  connectionsPerFile: number;
  speedLimitKib: number;
  maxRetries: number;
  autoExtract: boolean;
  deleteArchives: boolean;
}

export interface SettingsView extends Settings {
  tmpDir: string;
  doneDir: string;
  pluginDir: string;
  apiTokenSet: boolean;
  version: string;
  extractors: string[];
}

/** A captcha or download password waiting for the user (see captcha.rs). */
export interface Captcha {
  id: string;
  secret: string;
  pluginId: string;
  pluginName: string;
  kind: 'recaptcha' | 'hcaptcha' | 'turnstile' | 'image' | 'password';
  siteKey: string;
  pageUrl: string;
  host: string;
  enterprise: boolean;
  /** Image captchas: the picture as a data: URL. */
  image: string | null;
  link: string | null;
  /** Password questions: the download's name, and whether the last password was wrong. */
  name: string | null;
  wrong: boolean;
  createdAt: number;
  expiresAt: number;
}

export interface AuthState {
  setupRequired: boolean;
  loggedIn: boolean;
  user: string | null;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    /** As sent by the server, possibly in both languages. */
    public raw: string,
  ) {
    super(raw);
    // Always in the language shown right now, also for errors kept in the query cache.
    Object.defineProperty(this, 'message', { get: () => localize(this.raw) });
  }
}

export async function api<T = void>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init?.method ?? 'GET',
    headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: 'same-origin',
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      if (data?.error) msg = data.error;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204 || res.status === 202) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const post = <T = void>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body });
