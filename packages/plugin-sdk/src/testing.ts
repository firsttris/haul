/**
 * A fake `ctx` for unit-testing plugins in Node without the Rust core.
 * Routes are matched by `METHOD url` prefix; unmatched requests fail the test.
 */
import type { Account, Ctx, HttpRequest, HttpResponse } from './index';

export interface FakeRoute {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}

export type Handler = (req: HttpRequest) => FakeRoute;

export interface FakeCtx extends Ctx {
  requests: HttpRequest[];
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
  const request = async (req: HttpRequest) => {
    requests.push(req);
    const key = `${(req.method || 'GET').toUpperCase()} ${req.url}`;
    const hit = Object.keys(routes)
      .filter((k) => key.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (!hit) throw new Error(`unexpected request: ${key}`);
    const route = routes[hit];
    return response(req, typeof route === 'function' ? route(req) : route);
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
  };
}
