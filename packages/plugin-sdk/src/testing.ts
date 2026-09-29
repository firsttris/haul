/**
 * A fake `ctx` for unit-testing plugins in Node without the Rust core.
 * Routes are matched by `METHOD url` prefix; unmatched requests fail the test.
 */
import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto';
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
    crypto: {
      aesDecrypt({ mode, key, iv, data }) {
        const d = createDecipheriv(`aes-128-${mode}`, Buffer.from(key, 'hex'), mode === 'cbc' ? Buffer.from(iv ?? '0'.repeat(32), 'hex') : null);
        d.setAutoPadding(false);
        return Buffer.concat([d.update(Buffer.from(data, 'hex')), d.final()]).toString('hex');
      },
      // Node's crypto doing what plugins/crypto.rs does.
      async run(op, a) {
        const s = (k: string) => String(a[k]);
        if (op === 'pbkdf2Sha512') return pbkdf2Sync(s('password'), Buffer.from(s('salt'), 'hex'), Number(a.iterations), Number(a.length), 'sha512').toString('hex');
        if (op === 'aesEncrypt') {
          const c = createCipheriv(`aes-128-${s('mode')}`, Buffer.from(s('key'), 'hex'), s('mode') === 'cbc' ? Buffer.from(a.iv ? s('iv') : '0'.repeat(32), 'hex') : null);
          c.setAutoPadding(false);
          return Buffer.concat([c.update(Buffer.from(s('data'), 'hex')), c.final()]).toString('hex');
        }
        if (op === 'modPow') {
          let base = BigInt('0x' + s('base'));
          let exp = BigInt('0x' + s('exp'));
          // The modulus as hex or as factors (RSA p and q), like plugins/crypto.rs.
          const mod = Array.isArray(a.mod) ? a.mod.reduce((acc: bigint, f) => acc * BigInt('0x' + String(f)), 1n) : BigInt('0x' + s('mod'));
          let r = 1n;
          base %= mod;
          while (exp > 0n) {
            if (exp & 1n) r = (r * base) % mod;
            base = (base * base) % mod;
            exp >>= 1n;
          }
          return r.toString(16);
        }
        if (op === 'megaHashcash') {
          // pyLoad solve_hashcash.
          let token = Buffer.from(s('challenge').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
          token = Buffer.concat([token, Buffer.alloc((16 - (token.length % 16)) % 16)]);
          const buf = Buffer.alloc(4 + 48 * 0x40000);
          for (let i = 0; i < 0x40000; i++) token.copy(buf, 4 + 48 * i);
          const e = Number(a.easiness);
          const threshold = (((e & 63) << 1) + 1) * 2 ** ((e >> 6) * 7 + 3);
          for (let n = 1; ; n++) {
            buf.writeUInt32LE(n >>> 0, 0);
            if (createHash('sha256').update(buf).digest().readUInt32BE(0) <= threshold) {
              return buf.subarray(0, 4).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            }
          }
        }
        throw new Error(`fake crypto: ${op} not available in tests`);
      },
    },
    cookies: {
      get: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
      set: (_url, cookie) => setCookie(cookie),
    },
    jar,
  };
  return ctx;
}
