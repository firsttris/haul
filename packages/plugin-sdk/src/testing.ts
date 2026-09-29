/**
 * A fake `ctx` for unit-testing plugins in Node without the Rust core.
 * Routes are matched by `METHOD url` prefix; unmatched requests fail the test.
 */
import { createHash } from 'node:crypto';
import type { Account, CaptchaRequest, Ctx, HttpRequest, HttpResponse } from './index';

export interface FakeRoute {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  /** Simulates a file response (attachment). */
  file?: boolean;
  /** Final URL after redirects; default the request URL. */
  url?: string;
}

export type Handler = (req: HttpRequest) => FakeRoute;

export interface FakeCtx extends Ctx {
  requests: HttpRequest[];
  /** The fake cookie jar: one jar for all hosts, name → value, in insertion order. */
  jar: Map<string, string>;
  /** Seconds of every `ctx.wait` (which returns at once). */
  waits: number[];
  /** Every `ctx.captcha.solve` request; answered with `captchaToken` (default "CAPTCHA-TOKEN"). */
  captchas: CaptchaRequest[];
  captchaToken: string | null;
  /** The download's saved password (`ctx.password`); updated like the core does. */
  savedPassword: string | null;
  /** What the user types when asked, in order; none left plays a user who cancels. */
  passwordAnswers: string[];
  /** Every time the user was asked: after a wrong password or not. */
  passwordAsks: Array<{ wrong: boolean }>;
}

function response(req: HttpRequest, r: FakeRoute): HttpResponse {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers ?? {})) headers[k.toLowerCase()] = v;
  const body = r.body ?? '';
  return {
    status: r.status ?? 200,
    url: r.url ?? req.url,
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
  const waits: number[] = [];
  const captchas: CaptchaRequest[] = [];
  const passwordAsks: Array<{ wrong: boolean }> = [];
  const ctx: FakeCtx = {
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
    wait: async (seconds: number) => {
      waits.push(seconds);
    },
    waits,
    captchas,
    captchaToken: 'CAPTCHA-TOKEN',
    captcha: {
      async solve(req) {
        captchas.push(req);
        // `captchaToken = null` plays a user who does not solve it.
        if (ctx.captchaToken === null) {
          throw Object.assign(new Error('Captcha not solved in time'), { haulKind: 'temporary', haulWait: 1800 });
        }
        return ctx.captchaToken;
      },
    },
    savedPassword: null,
    passwordAnswers: [],
    passwordAsks,
    // Like prelude.js and the host: the saved password, else ask; `wrong` forgets it first.
    password: {
      async get(opts) {
        const wrong = !!opts?.wrong;
        if (wrong) ctx.savedPassword = null;
        else if (ctx.savedPassword !== null) return ctx.savedPassword;
        passwordAsks.push({ wrong });
        const answer = ctx.passwordAnswers.shift();
        if (answer === undefined) {
          throw Object.assign(new Error('Password entry cancelled'), { haulKind: 'fatal' });
        }
        ctx.savedPassword = answer;
        return answer;
      },
      async forget() {
        ctx.savedPassword = null;
      },
      async saved() {
        return ctx.savedPassword;
      },
    },
    log,
    account: { get: () => account },
    hash: { sha256: (text: string) => createHash('sha256').update(text, 'utf8').digest('hex') },
    cookies: {
      get: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
      set: (_url, cookie) => setCookie(cookie),
    },
    jar,
  };
  return ctx;
}
