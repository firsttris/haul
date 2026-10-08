import { createCipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fakeCtx } from '@haul/plugin-sdk/testing';
import type { HttpRequest } from '@haul/plugin-sdk';
import plugin, { b64, fileCipher, parseLink } from '../src/index';

// MEGA's crypto, built with Node the way MEGA's clients do it (pyLoad MegaCrypto).
const enc64 = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const aes = (mode: 'cbc' | 'ecb', key: Buffer, data: Buffer) => {
  const c = createCipheriv(`aes-128-${mode}`, key, mode === 'cbc' ? Buffer.alloc(16) : null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(data), c.final()]);
};
const attr = (name: string, k: Buffer) => {
  const plain = Buffer.from(`MEGA${JSON.stringify({ n: name, c: 'xyz' })}`, 'utf8');
  return enc64(aes('cbc', k, Buffer.concat([plain, Buffer.alloc((16 - (plain.length % 16)) % 16)])));
};
const FILE_KEY = Buffer.from([...Array(32).keys()].map((i) => (i * 7 + 3) & 0xff));
const K = Buffer.from(fileCipher([...FILE_KEY]).k);
const ID = 'AbCdEfGh';
const LINK = `https://mega.nz/file/${ID}#${enc64(FILE_KEY)}`;
const DL = 'https://gfs270n123.userstorage.mega.co.nz/dl/TOKEN';

type Cmd = Record<string, unknown>;
const api = (answer: (cmd: Cmd, req: HttpRequest) => unknown) => (req: HttpRequest) => {
  expect(req.headers?.['Content-Type']).toBe('text/plain;charset=UTF-8');
  const [cmd] = JSON.parse(req.body!) as Cmd[];
  return { body: JSON.stringify([answer(cmd, req)]), headers: { 'content-type': 'application/json' } };
};

describe('mega links', () => {
  it('knows JD’s file and folder forms', () => {
    expect(parseLink(LINK)).toEqual({ id: ID, key: enc64(FILE_KEY) });
    expect(parseLink(`https://mega.co.nz/#!${ID}!${enc64(FILE_KEY)}`)).toEqual({ id: ID, key: enc64(FILE_KEY) });
    expect(parseLink(`https://mega.nz/file/${ID}`)).toEqual({ id: ID, key: undefined });
    expect(parseLink('https://mega.nz/folder/F0lder12#a2V5a2V5a2V5a2V5a2V5aw/file/N0de1234')).toEqual({
      id: 'N0de1234',
      key: 'a2V5a2V5a2V5a2V5a2V5aw',
      folder: 'F0lder12',
    });
    expect(parseLink('https://mega.nz/folder/F0lder12#key')).toBeUndefined();
    for (const l of [LINK, 'https://mega.nz/folder/F0lder12#k', 'https://mega.nz/#F!F0lder12!k', `https://www.mega.nz/embed/${ID}`]) {
      expect(plugin.matches.some((re) => re.test(l))).toBe(true);
    }
    expect(b64('AQID')).toEqual([1, 2, 3]);
  });
});

describe('mega download', () => {
  const routes = (extra: Cmd = {}) => ({
    'POST https://g.api.mega.co.nz/cs?id=': api((cmd) => {
      expect(cmd).toMatchObject({ a: 'g', g: 1, v: 1, ssl: 1, p: ID });
      return { s: 1234, at: attr('Film ä.part1.rar', K), g: DL, ...extra };
    }),
    [`GET ${DL}`]: (req: HttpRequest) => {
      expect(req.headers?.Range).toBe('bytes=0-0');
      return { status: 206, file: true };
    },
  });

  it('decrypts the name and hands the key to the core', async () => {
    const r = await plugin.resolve(LINK, fakeCtx(routes()));
    expect(r).toEqual({
      url: DL,
      name: 'Film ä.part1.rar',
      size: 1234,
      maxConnections: 10,
      decrypt: { cipher: 'aes-128-ctr', key: K.toString('hex'), iv: FILE_KEY.subarray(16, 24).toString('hex') + '0000000000000000' },
      // The core checks the meta MAC in the key after the download.
      hash: { type: 'mega', value: FILE_KEY.toString('hex') },
    });
  });

  it('asks for a missing key like JD and keeps it', async () => {
    const ctx = fakeCtx(routes());
    ctx.passwordAnswers = ['wrongkey', `#${enc64(FILE_KEY)}`];
    expect((await plugin.resolve(`https://mega.nz/file/${ID}`, ctx)).name).toBe('Film ä.part1.rar');
    expect(ctx.passwordAsks).toEqual([{ wrong: false }, { wrong: true }]);
  });

  it('waits out the free transfer quota for all MEGA downloads', async () => {
    await expect(plugin.resolve(LINK, fakeCtx(routes({ tl: 1800 })))).rejects.toMatchObject({ haulWait: 1800, haulScope: 'hoster' });
    const ctx = fakeCtx({ ...routes(), [`GET ${DL}`]: { status: 509, headers: { 'X-MEGA-Time-Left': '4000' } } });
    await expect(plugin.resolve(LINK, ctx)).rejects.toMatchObject({ haulWait: 4000, haulScope: 'hoster' });
    const short = fakeCtx({ ...routes(), [`GET ${DL}`]: { status: 509, headers: { 'X-MEGA-Time-Left': '60' } } });
    // JD: at least 30 minutes.
    await expect(plugin.resolve(LINK, short)).rejects.toMatchObject({ haulWait: 1800 });
  });

  it('maps MEGA’s error codes like JD', async () => {
    const err = (code: number) => fakeCtx({ 'POST https://g.api.mega.co.nz/cs?id=': { body: JSON.stringify([code]) } });
    await expect(plugin.resolve(LINK, err(-9))).rejects.toMatchObject({ haulKind: 'offline' });
    await expect(plugin.resolve(LINK, err(-16))).rejects.toMatchObject({ haulKind: 'offline' });
    await expect(plugin.resolve(LINK, err(-17))).rejects.toMatchObject({ haulWait: 3600, haulScope: 'hoster' });
    await expect(plugin.resolve(LINK, err(-3))).rejects.toMatchObject({ haulWait: 300, haulScope: 'hoster' });
    await expect(plugin.resolve(LINK, err(-18))).rejects.toMatchObject({ haulKind: 'temporary', haulWait: 300 });
    await expect(plugin.check!(LINK, err(-11))).rejects.toMatchObject({ haulKind: 'offline' });
  });

  it('checks name and size without downloading', async () => {
    const ctx = fakeCtx({
      'POST https://g.api.mega.co.nz/cs?id=': api((cmd) => {
        expect(cmd).toEqual({ a: 'g', p: ID });
        return { s: 1234, at: attr('Film ä.part1.rar', K) };
      }),
    });
    expect(await plugin.check!(LINK, ctx)).toEqual({ online: true, name: 'Film ä.part1.rar', size: 1234 });
    expect(await plugin.crawl!(LINK, ctx)).toEqual({ files: [{ url: LINK }] });
  });
});

describe('mega folders (pyLoad MegaCoNzFolder)', () => {
  const FOLDER_KEY = Buffer.from('0123456789abcdef');
  const FK = enc64(FOLDER_KEY);
  const key2 = Buffer.from([...Array(32).keys()].map((i) => (i * 13 + 1) & 0xff));
  // Nodes as `a:"f"` lists them: keys `<root>:<ECB(folder key)>`, attributes CBC with the key.
  const nodes = [
    { h: 'R00t0000', p: 'Own3r000', t: 1, a: attr('Meine Filme', FOLDER_KEY), k: `R00t0000:${enc64(aes('ecb', FOLDER_KEY, FOLDER_KEY))}` },
    { h: 'N0de0001', p: 'R00t0000', t: 0, s: 10, a: attr('a.rar', K), k: `R00t0000:${enc64(aes('ecb', FOLDER_KEY, FILE_KEY))}` },
    { h: 'Sub00000', p: 'R00t0000', t: 1, a: attr('Extras', FOLDER_KEY), k: `R00t0000:${enc64(aes('ecb', FOLDER_KEY, FOLDER_KEY))}` },
    {
      h: 'N0de0002',
      p: 'Sub00000',
      t: 0,
      s: 20,
      a: attr('b.nfo', Buffer.from(fileCipher([...key2]).k)),
      k: `R00t0000:${enc64(aes('ecb', FOLDER_KEY, key2))}`,
    },
  ];
  const listing = (req: HttpRequest, cmd: Cmd) => {
    expect(req.url).toContain('&n=F0lder12');
    return cmd.a === 'f' ? { f: nodes } : { s: 10, at: attr('a.rar', K), g: DL };
  };

  it('lists all files with names, and one subfolder on request', async () => {
    const ctx = fakeCtx({ 'POST https://g.api.mega.co.nz/cs?id=': api((cmd, req) => listing(req, cmd)) });
    const url = (n: string) => `https://mega.nz/folder/F0lder12#${FK}/file/${n}`;
    expect(await plugin.crawl!(`https://mega.nz/folder/F0lder12#${FK}`, ctx)).toEqual({
      packageName: 'Meine Filme',
      files: [
        { url: url('N0de0001'), name: 'a.rar', size: 10 },
        { url: url('N0de0002'), name: 'b.nfo', size: 20 },
      ],
    });
    expect(await plugin.crawl!(`https://mega.nz/folder/F0lder12#${FK}/folder/Sub00000`, ctx)).toEqual({
      packageName: 'Extras',
      files: [{ url: url('N0de0002'), name: 'b.nfo', size: 20 }],
    });
  });

  it('downloads a file of a folder with its node key', async () => {
    const ctx = fakeCtx({
      'POST https://g.api.mega.co.nz/cs?id=': api((cmd, req) => {
        if (cmd.a === 'g') expect(cmd).toMatchObject({ n: 'N0de0001', g: 1 });
        return listing(req, cmd);
      }),
      [`GET ${DL}`]: { status: 206, file: true },
    });
    const r = await plugin.resolve(`https://mega.nz/folder/F0lder12#${FK}/file/N0de0001`, ctx);
    expect(r).toMatchObject({ url: DL, name: 'a.rar', decrypt: { key: K.toString('hex') } });
  });

  it('takes a failed folder listing during a download as temporary (JD: -11 offline only in the check)', async () => {
    const ctx = fakeCtx({
      'POST https://g.api.mega.co.nz/cs?id=': api((cmd, req) => (cmd.a === 'f' ? -11 : listing(req, cmd))),
    });
    await expect(plugin.resolve(`https://mega.nz/folder/F0lder12#${FK}/file/N0de0001`, ctx)).rejects.toMatchObject({ haulKind: 'temporary' });
    await expect(plugin.crawl!(`https://mega.nz/folder/F0lder12#${FK}`, ctx)).rejects.toMatchObject({ haulKind: 'offline' });
  });
});

describe('mega account (JD apiLogin, pyLoad hashcash)', async () => {
  const { generateKeyPairSync, pbkdf2Sync, randomBytes } = await import('node:crypto');
  const EMAIL = 'me@example.org';
  const PASSWORD = 'geheim';
  const salt = randomBytes(16);
  const dk = pbkdf2Sync(PASSWORD, salt, 100000, 32, 'sha512');
  const master = randomBytes(16);
  // The account's RSA key as MEGA stores it: p, q, d, u as MPIs, AES-ECB with the master key.
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = privateKey.export({ format: 'jwk' }) as Record<string, string>;
  const big = (b64u: string) => Buffer.from(b64u, 'base64url');
  const mpi = (b: Buffer) => {
    const bits = b.length * 8 - Math.clz32(b[0]) + 24;
    return Buffer.concat([Buffer.from([bits >> 8, bits & 255]), b]);
  };
  let privk = Buffer.concat([mpi(big(jwk.p)), mpi(big(jwk.q)), mpi(big(jwk.d)), mpi(big(jwk.qi))]);
  privk = Buffer.concat([privk, Buffer.alloc((16 - (privk.length % 16)) % 16)]);
  // The session id: 43 bytes, encrypted with the public key (m^e mod n).
  const sid = Buffer.concat([Buffer.from([0x42]), randomBytes(42)]);
  const m = BigInt('0x' + Buffer.concat([sid, randomBytes(20)]).toString('hex'));
  const n = BigInt('0x' + big(jwk.n).toString('hex'));
  let c = 1n;
  let b = m % n;
  for (let e = BigInt('0x' + big(jwk.e).toString('hex')); e > 0n; e >>= 1n) {
    if (e & 1n) c = (c * b) % n;
    b = (b * b) % n;
  }
  let cHex = c.toString(16);
  if (cHex.length % 2) cHex = '0' + cHex;
  const csid = mpi(Buffer.from(cHex, 'hex'));
  const SID = enc64(sid);

  const server = (opts: { hashcash?: boolean; utype?: number } = {}) => {
    let challenged = false;
    const seen: Cmd[] = [];
    const route = (req: HttpRequest) => {
      const [cmd] = JSON.parse(req.body!) as Cmd[];
      seen.push(cmd);
      const reply = (body: unknown) => ({ body: JSON.stringify([body]), headers: { 'content-type': 'application/json' } });
      if (cmd.a === 'us0') return reply({ v: 2, s: enc64(salt) });
      if (cmd.a === 'us' && cmd.user) {
        if (opts.hashcash && !challenged) {
          challenged = true;
          return { status: 402, headers: { 'X-Hashcash': `1:180:1700000000:${enc64(Buffer.from([...Array(48).keys()]))}` } };
        }
        if (opts.hashcash) expect(req.headers?.['X-Hashcash']).toMatch(/^1:[\w-]+:[\w-]+$/);
        if (cmd.uh !== enc64(dk.subarray(16))) return reply(-9);
        return reply({ k: enc64(aes('ecb', dk.subarray(0, 16), master)), privk: enc64(aes('ecb', master, privk)), csid: enc64(csid) });
      }
      // JD "login via sid": a valid session answers with the private key.
      if (cmd.a === 'us' && !cmd.user) return req.url.includes(`&sid=${SID}`) ? reply({ privk: 'x', k: 'y' }) : reply(-15);
      if (cmd.a === 'uq') {
        expect(req.url).toContain(`&sid=${SID}`);
        return reply({ utype: opts.utype ?? 1, suntil: 4102444800, mxfer: 1000, caxfer: 100, tuo: 5, csxfer: 20, tua: 5 });
      }
      if (cmd.a === 'g') {
        expect(req.url).toContain(`&sid=${SID}`);
        return reply({ s: 1234, at: attr('Film ä.part1.rar', K), g: DL });
      }
      throw new Error(`unexpected ${JSON.stringify(cmd)}`);
    };
    return { seen, routes: { 'POST https://g.api.mega.co.nz/cs?id=': route, [`GET ${DL}`]: { status: 206, file: true } } };
  };

  it('logs in with PBKDF2 and the RSA session, then reads the quota like JD', async () => {
    const s = server();
    const ctx = fakeCtx(s.routes, { id: 1, user: 'Me@Example.org', secret: PASSWORD });
    expect(await plugin.checkAccount!(ctx)).toEqual({ valid: true, premium: true, validUntil: 4102444800000, trafficLeft: 870, message: 'Pro I' });
    expect(s.seen[0]).toEqual({ a: 'us0', user: EMAIL });
    // Downloads carry the session; the saved one is reused without a new login.
    const logins = s.seen.filter((c) => c.a === 'us0').length;
    expect((await plugin.resolve(LINK, ctx)).url).toBe(DL);
    expect(s.seen.filter((c) => c.a === 'us0')).toHaveLength(logins);
  });

  it('solves the hashcash challenge (HTTP 402) like pyLoad', async () => {
    const s = server({ hashcash: true });
    const ctx = fakeCtx(s.routes, { id: 1, user: EMAIL, secret: PASSWORD });
    expect(await plugin.checkAccount!(ctx)).toMatchObject({ premium: true });
  }, 20000);

  it('reports a wrong password and free accounts', async () => {
    await expect(plugin.checkAccount!(fakeCtx(server().routes, { id: 1, user: EMAIL, secret: 'falsch' }))).rejects.toMatchObject({ haulKind: 'account' });
    // Free, but traffic left: JD counts it as premium ("but still premium?"); none left: free.
    const free = server({ utype: 0 });
    expect(await plugin.checkAccount!(fakeCtx(free.routes, { id: 1, user: EMAIL, secret: PASSWORD }))).toMatchObject({ premium: true, message: 'Free' });
  });
});
