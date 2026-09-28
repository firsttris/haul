export type Status = 'collected' | 'queued' | 'resolving' | 'downloading' | 'paused' | 'finished' | 'failed';

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
  hasCheck: boolean;
  hasCheckAccount: boolean;
  builtin: boolean;
  file: string;
}

export interface PluginList {
  plugins: Plugin[];
  errors: { file: string; error: string }[];
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
}

export interface AuthState {
  setupRequired: boolean;
  loggedIn: boolean;
  user: string | null;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
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
