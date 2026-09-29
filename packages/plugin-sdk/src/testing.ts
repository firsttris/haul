/**
 * A fake `ctx` for unit-testing plugins in Node without the Rust core.
 * Routes are matched by `METHOD url` prefix; unmatched requests fail the test.
 */
import { createHash } from 'node:crypto';
import type { Account, Ctx, HttpRequest, HttpResponse } from './index';

export interface FakeRoute {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  /** Simulates a file response (attachment). */
  file?: boolean;
}

export type Handler = (req: HttpRequest) => FakeRoute;

export interface FakeCtx extends Ctx {
  requests: HttpRequest[];
  /** The fake cookie jar: one jar for all hosts, name → value, in insertion order. */
  jar: Map<string, string>;
}

function response(req: HttpRequest, r: FakeRoute): HttpResponse {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers ?? {})) headers[k.toLowerCase()] = v;
  const body = r.body ?? '';
  return {
    status: r.status ?? 200,
    url: req.url,
    headers,
    body,
    file: !!r.file,
    ok() {
      return this.status >= 200 && this.status < 300;
    },
    text: () => body,
    json: () => JSON.parse(body),
    header: (n) => headers[n.toLowerCase()] ?? null,
  };
}

export function fakeCtx(routes: Record<string, FakeRoute | Handler>, account: Account | null = null): FakeCtx {
  const requests: HttpRequest[] = [];
  const jar = new Map<string, string>();
  const setCookie = (line: string) => {
    const [pair] = line.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  };
  const request = async (input: HttpRequest) => {
    // Like the real client: the jar's cookies go along unless a Cookie header is given.
    const req =
      jar.size && !input.headers?.Cookie
        ? { ...input, headers: { ...(input.headers ?? {}), Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } }
        : input;
    requests.push(req);
    const key = `${(req.method || 'GET').toUpperCase()} ${req.url}`;
    const hit = Object.keys(routes)
      .filter((k) => key.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (!hit) throw new Error(`unexpected request: ${key}`);
    const route = routes[hit];
    const res = response(req, typeof route === 'function' ? route(req) : route);
    for (const line of (res.header('set-cookie') ?? '').split('\n')) if (line) setCookie(line);
    return res;
  };
  const log = Object.assign(() => {}, { info() {}, warn() {}, error() {}, debug() {} });
  return {
    pluginId: 'test',
    requests,
    http: {
      request,
      get: (url, opts) => request({ ...opts, method: 'GET', url }),
      post: (url, body, opts) =>
        request({
          ...opts,
          method: 'POST',
          url,
          ...(typeof body === 'string' ? { body } : body ? { form: body } : {}),
        }),
    },
    wait: async () => {},
    log,
    account: { get: () => account },
    hash: { sha256: (text: string) => createHash('sha256').update(text, 'utf8').digest('hex') },
    cookies: {
      get: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
      set: (_url, cookie) => setCookie(cookie),
    },
    jar,
  };
}
