/**
 * mega.nz: public files and folders without an account. MEGA encrypts everything; the key is in
 * the link after `#`.
 *
 * References: JD's MegaConz.java (hoster, mirror 2026-09-28) and pyLoad's MegaCoNz /
 * MegaCoNzFolder (downloader 2026-09-28).
 *
 * - API: `POST https://g.api.mega.co.nz/cs?id=<seq>[&n=<folder>]` with `[{"a":…}]`; the answer is
 *   `[{…}]` or an error number (JD getError, pyLoad check_error).
 * - File key (32 bytes, base64url): AES key = first half XOR second half, counter = bytes 16..24
 *   plus a zero block counter (JD/pyLoad get_cipher_key). The name is in the attributes `at`,
 *   AES-CBC with a zero IV, `MEGA{"n":…}`.
 * - Download: `a:"g", g:1, v:1, ssl:1` gives the URL; the file comes AES-128-CTR encrypted, the
 *   core decrypts it while writing (JD and pyLoad decrypt after the download). At most 10
 *   connections (JD: "MEGA does not like much connections", -10).
 * - Limits: `tl` in the answer (pyLoad) and HTTP 509 with `X-MEGA-Time-Left` on the download
 *   URL (JD, at least 30 min) are the free transfer quota, which holds for the IP: all MEGA
 *   downloads wait. -17 over quota (JD: IP blocked, 60 min), -3/-4 congestion (5 min).
 * - Integrity: the key carries a MAC of the file (pyLoad verifies it after decrypting); it goes
 *   to the core as `hash: { type: 'mega' }` and is checked after the download.
 * - Missing or wrong key: JD asks the user ("Decryption key?"); here it is asked like a
 *   download password and kept with the download.
 * - Account (JD apiLogin / fetchAccountInfo): prelogin `us0` gives the version; v2 derives key
 *   and user hash with PBKDF2-SHA512 (100000 rounds), v1 with MEGA's old key function. `us`
 *   answers the master key (AES with the password key) and the session: `csid` decrypted with
 *   the account's RSA key (JD, pyLoad) or `tsid` (pyLoad). A Hashcash challenge (HTTP 402) is
 *   solved like pyLoad does; JD does not know it yet. The session goes along as `sid`;
 *   `uq` gives the account type, expiry and transfer quota like JD computes it.
 * - Folders (`/folder/<id>#<key>`, pyLoad MegaCoNzFolder, JD crawler): `a:"f", c:1, r:1, ca:1`
 *   with `n=<id>` lists all nodes; a file's key is `<root>:<key>` in `k`, AES-ECB encrypted with
 *   the folder key. Files become `/folder/<id>#<key>/file/<node>`; `/folder/<id>#<key>/folder/
 *   <sub>` takes only that subfolder.
 */
import { AccountError, definePlugin, HosterLimitError, memo, OfflineError, PluginError, TemporaryError, withPassword, WRONG_PASSWORD } from '@haul/plugin-sdk';
import type { AccountInfo, CrawledFile, Ctx, Resolved } from '@haul/plugin-sdk';

const API = 'https://g.api.mega.co.nz/cs';
const HOST = '(?:www\\.)?mega(?:\\.co)?\\.nz';
/** JD PATTERN_FILE_NEW and PATTERN_FILE_OLD. */
const FILE = new RegExp(`^https?://${HOST}/(?:(?:file|embed)/([a-zA-Z0-9]+)(?:#([a-zA-Z0-9_-]+))?|#!([a-zA-Z0-9]+)(?:!([a-zA-Z0-9_-]+))?)`, 'i');
/** New and old (`#F!id!key`) folder links, with a subfolder or a file inside (pyLoad, JD). */
const FOLDER = new RegExp(
  `^https?://${HOST}/(?:folder/([a-zA-Z0-9]+)(?:#([a-zA-Z0-9_,-]+))?|#F!([a-zA-Z0-9]+)(?:!([a-zA-Z0-9_-]+))?)(?:/(folder|file)/([a-zA-Z0-9]+))?`,
  'i',
);
/** JD: 5 minutes for congestion and temporary errors. */
const RETRY = 5 * 60;

// ---- bytes -------------------------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** MEGA's base64 (url alphabet, no padding); standard `+/=` is accepted too. */
export function b64(s: string): number[] {
  const out: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const c of s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')) {
    const v = B64.indexOf(c);
    if (v < 0) throw new Error(`bad base64 character ${c}`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return out;
}

const hex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h: string) => (h.match(/../g) ?? []).map((x) => parseInt(x, 16));

/** UTF-8 bytes to a string (QuickJS has no TextDecoder). */
function utf8(b: number[]): string {
  try {
    return decodeURIComponent(b.map((x) => `%${x.toString(16).padStart(2, '0')}`).join(''));
  } catch {
    return String.fromCharCode(...b);
  }
}

/** JD/pyLoad get_cipher_key: AES key (a XOR b) and counter block (bytes 16..24, then zeros). */
export function fileCipher(key: number[]): { k: number[]; iv: number[] } {
  const k = key.slice(0, 16).map((x, i) => x ^ key[16 + i]);
  return { k, iv: [...key.slice(16, 24), 0, 0, 0, 0, 0, 0, 0, 0] };
}

/** pyLoad decrypt_attr: CBC with a zero IV; the plain text starts with `MEGA{"`. */
export function decryptAttr(ctx: Ctx, at: string, k: number[]): { n?: string } | undefined {
  let data = b64(at);
  if (data.length % 16) data = data.concat(new Array(16 - (data.length % 16)).fill(0));
  const plain = unhex(ctx.crypto.aesDecrypt({ mode: 'cbc', key: hex(k), data: hex(data) }));
  if (utf8(plain.slice(0, 6)) !== 'MEGA{"') return undefined;
  const end = plain.lastIndexOf(0x7d);
  try {
    return JSON.parse(utf8(plain.slice(4, end + 1)));
  } catch {
    return undefined;
  }
}

/** pyLoad decrypt_key: a node key, AES-ECB with the folder key. */
function decryptKey(ctx: Ctx, data: string, key: number[]): number[] {
  return unhex(ctx.crypto.aesDecrypt({ mode: 'ecb', key: hex(key), data: hex(b64(data)) }));
}

// ---- API -----------------------------------------------------------------------------------

type ApiAnswer = Record<string, unknown> | number;

/** Negative MEGA error codes (JD getError, pyLoad check_error), as plugin errors. */
function apiError(code: number, when: 'check' | 'download'): Error {
  const c = Math.abs(code);
  if (c === 9 || c === 2) return new OfflineError({ de: 'MEGA: Datei oder Ordner existiert nicht', en: 'MEGA: file or folder does not exist' });
  if (c === 16) return new OfflineError({ de: 'MEGA: vom Betreiber gesperrt', en: 'MEGA: blocked by MEGA' });
  if (c === 3) return new HosterLimitError({ de: 'MEGA: vorübergehende Störung', en: 'MEGA: temporary congestion' }, RETRY);
  if (c === 4) return new HosterLimitError({ de: 'MEGA: zu viele Anfragen', en: 'MEGA: too many requests' }, RETRY);
  if (c === 17) return new HosterLimitError({ de: 'MEGA: Kontingent überschritten', en: 'MEGA: over quota' }, 60 * 60);
  if (c === 18) return new TemporaryError({ de: 'MEGA: vorübergehend nicht verfügbar', en: 'MEGA: temporarily unavailable' }, RETRY);
  if (c === 6 || c === 11) {
    // JD: offline in the link check, "retry later" when downloading.
    if (when === 'check') return new OfflineError(`MEGA: error ${code}`);
    return new TemporaryError({ de: `MEGA: Fehler ${code}, später erneut`, en: `MEGA: error ${code}, trying later` }, RETRY);
  }
  if (c === 7 || c === 8) return new OfflineError(`MEGA: error ${code}`);
  return new PluginError('fatal', { de: `MEGA: unbekannter Fehlercode ${code}`, en: `MEGA: unknown error code ${code}` });
}

let seq = Math.floor(Math.random() * 1e9);

/** One API request as sent (JD apiRequest: `id`, `sid` when logged in, `n` for folder nodes). */
function apiPost(ctx: Ctx, cmd: Record<string, unknown>, opts: { node?: string; sid?: string; headers?: Record<string, string> } = {}) {
  const url = `${API}?id=${seq++}${opts.sid ? `&sid=${encodeURIComponent(opts.sid)}` : ''}${opts.node ? `&n=${encodeURIComponent(opts.node)}` : ''}`;
  return ctx.http.post(url, JSON.stringify([cmd]), { headers: { 'Content-Type': 'text/plain;charset=UTF-8', ...(opts.headers ?? {}) } });
}

/** One API command; `node` is the folder a node belongs to (`n=`), `sid` the account session. */
async function api(ctx: Ctx, cmd: Record<string, unknown>, when: 'check' | 'download', node?: string, sid?: string): Promise<Record<string, unknown>> {
  const res = await apiPost(ctx, cmd, { node, sid });
  if (res.status >= 500) {
    // JD checkServerBusy.
    throw new HosterLimitError({ de: `MEGA: Server ausgelastet (HTTP ${res.status})`, en: `MEGA: server busy (HTTP ${res.status})` }, 60);
  }
  let body: unknown;
  try {
    body = res.json();
  } catch {
    throw new TemporaryError({ de: `MEGA: unerwartete Antwort (HTTP ${res.status})`, en: `MEGA: unexpected answer (HTTP ${res.status})` });
  }
  const answer = (Array.isArray(body) ? body[0] : body) as ApiAnswer;
  if (typeof answer === 'number') throw apiError(answer, when);
  if (!answer || typeof answer !== 'object') throw new TemporaryError({ de: 'MEGA: leere Antwort', en: 'MEGA: empty answer' });
  if (typeof answer.e === 'number' && answer.e < 0) throw apiError(answer.e, when);
  return answer;
}

// ---- account (JD MegaConz.apiLogin / fetchAccountInfo) ------------------------------------

const b64url = (b: number[]) => {
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    const chars = [(n >> 18) & 63, (n >> 12) & 63, (n >> 6) & 63, n & 63].map((x) => B64[x]);
    out += chars.slice(0, i + 2 < b.length ? 4 : i + 1 < b.length ? 3 : 2).join('');
  }
  return out;
};

/** pyLoad mpi_to_int: a PGP MPI (2 bytes bit length, then the number), as hex. */
function mpis(bytes: number[], count: number): string[] | undefined {
  const out: string[] = [];
  let i = 0;
  for (let n = 0; n < count; n++) {
    if (i + 2 > bytes.length) return undefined;
    const len = Math.floor(((bytes[i] << 8) + bytes[i + 1] + 7) / 8);
    if (i + 2 + len > bytes.length) return undefined;
    out.push(hex(bytes.slice(i + 2, i + 2 + len)) || '0');
    i += 2 + len;
  }
  return out;
}

const SESSION = 'https://mega.nz';

const loginFailed = () => new AccountError({ de: 'MEGA: E-Mail oder Passwort falsch', en: 'MEGA: wrong e-mail or password' });

/** A login command; answers MEGA's Hashcash challenge (HTTP 402, pyLoad; JD does not know it yet). */
async function loginCommand(ctx: Ctx, cmd: Record<string, unknown>): Promise<ApiAnswer> {
  let headers: Record<string, string> | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await apiPost(ctx, cmd, { headers });
    if (res.status === 402) {
      const challenge = res.header('x-hashcash') ?? '';
      const parts = challenge.split(':');
      const easiness = Number(parts[1]);
      if (attempt > 0 || parts.length !== 4 || parts[0] !== '1' || !(easiness >= 0 && easiness <= 255)) {
        throw new AccountError({ de: `MEGA: Hashcash-Aufgabe nicht lösbar (${challenge})`, en: `MEGA: hashcash challenge not solvable (${challenge})` });
      }
      const nonce = await ctx.crypto.run('megaHashcash', { challenge: parts[3], easiness });
      headers = { 'X-Hashcash': `1:${parts[3]}:${nonce}` };
      continue;
    }
    if (res.status >= 500) throw new HosterLimitError({ de: `MEGA: Server ausgelastet (HTTP ${res.status})`, en: `MEGA: server busy (HTTP ${res.status})` }, 60);
    try {
      const body = res.json<unknown>();
      return (Array.isArray(body) ? body[0] : body) as ApiAnswer;
    } catch {
      throw new TemporaryError({ de: `MEGA: unerwartete Antwort (HTTP ${res.status})`, en: `MEGA: unexpected answer (HTTP ${res.status})` });
    }
  }
  throw loginFailed();
}

/** JD apiLogin: the saved session if MEGA still accepts it, else a fresh login. Returns the sid. */
async function login(ctx: Ctx): Promise<string> {
  const acc = ctx.account.get()!;
  const email = acc.user.trim().toLowerCase();
  if (!/^.+?@.+?\.[^.]+$/.test(email)) {
    throw new AccountError({ de: 'MEGA: als Benutzer die E-Mail-Adresse eintragen', en: 'MEGA: enter the e-mail address as user' });
  }
  if (!acc.secret) throw loginFailed();
  const saved = memo.get(ctx, SESSION, 'mega_sid');
  if (saved) {
    // JD: "login via sid", valid when the answer carries the private key.
    const check = await apiPost(ctx, { a: 'us' }, { sid: saved });
    try {
      const body = check.json<unknown>();
      const a = (Array.isArray(body) ? body[0] : body) as ApiAnswer;
      if (a && typeof a === 'object' && 'privk' in a) return saved;
    } catch {
      /* log in again */
    }
  }
  // JD: prelogin "us0" gives the account version and, for v2, the salt.
  const pre = await loginCommand(ctx, { a: 'us0', user: email });
  if (typeof pre !== 'object' || !pre) throw loginFailed();
  let pwKey: number[];
  let uh: string;
  if (Number(pre.v) === 2) {
    const salt = typeof pre.s === 'string' ? pre.s : '';
    if (!salt) throw new TemporaryError({ de: 'MEGA: Login ohne Salt', en: 'MEGA: login without salt' });
    const dk = unhex(await ctx.crypto.run('pbkdf2Sha512', { password: acc.secret, salt: hex(b64(salt)), iterations: 100000, length: 32 }));
    pwKey = dk.slice(0, 16);
    uh = b64url(dk.slice(16, 32));
  } else if (Number(pre.v) === 1) {
    pwKey = unhex(await ctx.crypto.run('megaPrepareKey', { password: acc.secret }));
    uh = await ctx.crypto.run('megaUserHashV1', { email, key: hex(pwKey) });
  } else {
    throw new PluginError('fatal', `MEGA: unknown account version ${String(pre.v)}`);
  }
  const res = await loginCommand(ctx, { a: 'us', user: email, uh });
  if (typeof res === 'number' || (res && typeof res.e === 'number')) {
    const code = typeof res === 'number' ? res : Number(res.e);
    // JD: -26 multi-factor authentication required, -16 user blocked, -9 user not found.
    if (code === -26) {
      throw new AccountError({ de: 'MEGA: Zwei-Faktor-Anmeldung ist aktiv, das kann Haul noch nicht', en: 'MEGA: two-factor login is on, Haul cannot do that yet' });
    }
    if (code === -16) throw new AccountError({ de: 'MEGA: Account gesperrt', en: 'MEGA: account blocked' });
    if (code === -3 || code === -4) throw new TemporaryError({ de: `MEGA: Login später erneut (${code})`, en: `MEGA: login later again (${code})` }, RETRY);
    throw loginFailed();
  }
  if (!res || typeof res.k !== 'string') throw loginFailed();
  const master = unhex(ctx.crypto.aesDecrypt({ mode: 'ecb', key: hex(pwKey), data: hex(b64(res.k)) }));
  let sid: string | undefined;
  if (typeof res.tsid === 'string') {
    // pyLoad: a temporary session, proven by encrypting its first half with the master key.
    const tsid = b64(res.tsid);
    const check = unhex(await ctx.crypto.run('aesEncrypt', { mode: 'ecb', key: hex(master), data: hex(tsid.slice(0, 16)) }));
    if (hex(check) !== hex(tsid.slice(-16))) throw loginFailed();
    sid = res.tsid;
  } else if (typeof res.csid === 'string' && typeof res.privk === 'string') {
    // JD/pyLoad: the RSA private key (p, q, d, u as MPIs) decrypts the session id.
    let privk = b64(res.privk);
    if (privk.length % 16) privk = privk.concat(new Array(16 - (privk.length % 16)).fill(0));
    const rsa = mpis(unhex(ctx.crypto.aesDecrypt({ mode: 'ecb', key: hex(master), data: hex(privk) })), 4);
    const csid = mpis(b64(res.csid), 1);
    if (!rsa || !csid) throw loginFailed();
    let sidHex = await ctx.crypto.run('modPow', { base: csid[0], exp: rsa[2], mod: [rsa[0], rsa[1]] });
    if (sidHex.length % 2) sidHex = '0' + sidHex;
    sid = b64url(unhex(sidHex).slice(0, 43));
  }
  if (!sid) throw loginFailed();
  memo.set(ctx, SESSION, 'mega_sid', sid, 30 * 86400);
  return sid;
}

/** JD fetchAccountInfo: `uq` with xfer and pro; utype 0 = free. */
async function accountInfo(ctx: Ctx): Promise<AccountInfo> {
  const sid = await login(ctx);
  const uq = await api(ctx, { a: 'uq', xfer: 1, pro: 1 }, 'check', undefined, sid);
  const n = (k: string) => (typeof uq[k] === 'number' ? (uq[k] as number) : 0);
  const utype = n('utype');
  const names: Record<number, string> = {
    1: 'Pro I', 2: 'Pro II', 3: 'Pro III', 4: 'Lite', 11: 'Starter', 12: 'Basic', 13: 'Essential', 100: 'Business', 101: 'Pro Flexi',
  };
  let premium = utype in names;
  const info: AccountInfo = { valid: true, message: names[utype] ?? (utype === 0 ? 'Free' : `Type ${utype}`) };
  if (premium && typeof uq.suntil === 'number') {
    info.validUntil = uq.suntil * 1000;
    if (info.validUntil < Date.now()) premium = false;
  }
  if (typeof uq.mxfer === 'number') {
    // JD: used by the owner and served to others, each with what is not committed yet.
    info.trafficLeft = uq.mxfer - (n('caxfer') + n('tuo') + n('csxfer') + n('tua'));
    if (info.trafficLeft > 0 && !premium) premium = true;
  }
  info.premium = premium;
  return info;
}

/** The session for downloads with an account (JD getSID). */
const sidFor = async (ctx: Ctx) => (ctx.account.get() ? login(ctx) : undefined);

// ---- links ---------------------------------------------------------------------------------

interface Target {
  /** Public file id, or the node id of a file in a folder. */
  id: string;
  /** The key from the link (file: 32 bytes; folder file: the folder's 16). */
  key?: string;
  folder?: string;
}

export function parseLink(link: string): Target | undefined {
  const f = FILE.exec(link);
  if (f) return { id: f[1] ?? f[3], key: f[2] ?? f[4] };
  const d = FOLDER.exec(link);
  if (d && d[5]?.toLowerCase() === 'file') return { id: d[6], key: d[2] ?? d[4], folder: d[1] ?? d[3] };
  return undefined;
}

/** A key the user typed: MEGA's keys, sometimes pasted with `#` or `!` in front. */
const cleanKey = (s: string) => s.trim().replace(/^[#!]+/, '');

const validFileKey = (key: string | undefined) => {
  try {
    return !!key && b64(key).length === 32;
  } catch {
    return false;
  }
};

interface FolderNode {
  h: string;
  p: string;
  t: number;
  a?: string;
  k?: string;
  s?: number;
}

/** pyLoad find_root_node: the folder whose parent is not in the listing. */
function rootOf(nodes: FolderNode[]): string | undefined {
  const folders = new Map(nodes.filter((n) => n.t === 1 && n.h && n.p).map((n) => [n.h, n.p]));
  for (const [h, p] of folders) if (!folders.has(p)) return h;
  return nodes.find((n) => n.t === 1)?.h;
}

/** A node's key, decrypted with the folder key (pyLoad build_key_dict + decrypt_key). */
function nodeKey(ctx: Ctx, node: FolderNode, root: string | undefined, folderKey: number[]): number[] | undefined {
  if (!node.k || !node.k.includes(':')) return undefined;
  const keys = new Map(
    node.k.split('/').map((part) => [part.slice(0, part.indexOf(':')), part.slice(part.indexOf(':') + 1)] as const),
  );
  const enc = (root && keys.get(root)) ?? (keys.size === 1 ? [...keys.values()][0] : undefined);
  if (!enc) return undefined;
  try {
    return decryptKey(ctx, enc, folderKey);
  } catch {
    return undefined;
  }
}

async function listFolder(ctx: Ctx, folder: string): Promise<FolderNode[]> {
  const r = await api(ctx, { a: 'f', c: 1, r: 1, ca: 1 }, 'check', folder);
  return Array.isArray(r.f) ? (r.f as FolderNode[]) : [];
}

function folderKeyOf(key: string | undefined): number[] {
  let k: number[] = [];
  try {
    k = key ? b64(key) : [];
  } catch {
    /* invalid */
  }
  if (k.length !== 16) {
    throw new PluginError('fatal', { de: 'MEGA: Ordner-Link ohne gültigen Schlüssel', en: 'MEGA: folder link without a valid key' });
  }
  return k;
}

// ---- download ------------------------------------------------------------------------------

/** JD: 509 "Bandwidth Limit Exceeded" with X-MEGA-Time-Left (at least 30 min); 503 too many connections. */
async function probe(ctx: Ctx, url: string): Promise<void> {
  const res = await ctx.http.get(url, { headers: { Range: 'bytes=0-0' } });
  if (res.status === 509) {
    const left = Number(res.header('x-mega-time-left'));
    throw new HosterLimitError(
      { de: 'MEGA: Transfer-Kontingent erschöpft (509)', en: 'MEGA: transfer quota exceeded (509)' },
      Math.max(30 * 60, Number.isFinite(left) ? left : 0),
    );
  }
  if (res.status === 503) throw new TemporaryError({ de: 'MEGA: zu viele Verbindungen', en: 'MEGA: too many connections' }, RETRY);
  if (!res.file && /html/i.test(res.header('content-type') ?? '')) {
    throw new TemporaryError({ de: 'MEGA: Webseite statt Datei', en: 'MEGA: web page instead of the file' });
  }
}

async function resolveFile(ctx: Ctx, t: Target): Promise<Resolved> {
  const cmd = { a: 'g', g: 1, v: 1, ssl: 1, ...(t.folder ? { n: t.id } : { p: t.id }) };
  // JD: with an account the request carries its session, so its transfer quota counts.
  const sid = await sidFor(ctx);
  const info = await api(ctx, cmd, 'download', t.folder, sid);
  const at = typeof info.at === 'string' ? info.at : undefined;
  if (typeof info.s !== 'number' || !at) throw new OfflineError();

  let key: number[];
  let name: string | undefined;
  if (t.folder) {
    const folderKey = folderKeyOf(t.key);
    const nodes = await listFolder(ctx, t.folder);
    const node = nodes.find((n) => n.h === t.id && n.t === 0);
    if (!node) throw new OfflineError({ de: 'MEGA: Datei nicht mehr im Ordner', en: 'MEGA: the file is no longer in the folder' });
    const k = nodeKey(ctx, node, rootOf(nodes), folderKey);
    if (!k || k.length !== 32) throw new PluginError('fatal', { de: 'MEGA: Schlüssel der Datei nicht lesbar', en: 'MEGA: file key not readable' });
    key = k;
    name = decryptAttr(ctx, at, fileCipher(key).k)?.n;
  } else {
    // JD: the key from the link; missing or wrong, the user is asked (up to 3 times).
    const fromLink = validFileKey(t.key) ? b64(t.key!) : undefined;
    const attr = fromLink && decryptAttr(ctx, at, fileCipher(fromLink).k);
    if (fromLink && attr) {
      key = fromLink;
      name = attr.n;
    } else {
      [key, name] = await withPassword(ctx, 'MEGA', async (typed) => {
        const k = cleanKey(typed);
        if (!validFileKey(k)) return WRONG_PASSWORD;
        const a = decryptAttr(ctx, at, fileCipher(b64(k)).k);
        return a ? ([b64(k), a.n] as [number[], string | undefined]) : WRONG_PASSWORD;
      });
    }
  }
  if (!name) throw new PluginError('fatal', { de: 'MEGA: Dateiname nicht entschlüsselbar', en: 'MEGA: file name could not be decrypted' });
  // pyLoad: `tl` is the time left of the free transfer quota.
  const tl = Number(info.tl ?? 0);
  if (tl > 0) {
    throw new HosterLimitError({ de: 'MEGA: Transfer-Kontingent erschöpft', en: 'MEGA: transfer quota exceeded' }, tl);
  }
  const g = Array.isArray(info.g) ? (info.g.length === 1 ? info.g[0] : undefined) : info.g;
  if (typeof g !== 'string' || !g) {
    throw new PluginError('fatal', { de: 'MEGA: kein Download-Link (geteilter RAID-Download?)', en: 'MEGA: no download link (split raid download?)' });
  }
  await probe(ctx, g);
  const { k, iv } = fileCipher(key);
  return {
    url: g,
    name: name.replace(/\\/g, ''),
    size: info.s,
    maxConnections: 10,
    decrypt: { cipher: 'aes-128-ctr', key: hex(k), iv: hex(iv) },
    // pyLoad MegaCrypto.Checksum: the core checks the meta MAC in the key after the download.
    hash: { type: 'mega', value: hex(key) },
  };
}

async function crawlFolder(ctx: Ctx, link: string) {
  const m = FOLDER.exec(link)!;
  const folder = m[1] ?? m[3];
  const keyText = m[2] ?? m[4];
  const folderKey = folderKeyOf(keyText);
  const only = m[5]?.toLowerCase() === 'folder' ? m[6] : undefined;
  const nodes = await listFolder(ctx, folder);
  if (!nodes.length) throw new OfflineError({ de: 'MEGA: Ordner leer oder gelöscht', en: 'MEGA: folder empty or deleted' });
  const root = rootOf(nodes);
  const parent = new Map(nodes.map((n) => [n.h, n.p]));
  // A subfolder link takes the files below that folder, at any depth.
  const inside = (n: FolderNode) => {
    for (let p: string | undefined = n.p, i = 0; p && i < 100; p = parent.get(p), i++) if (p === only) return true;
    return false;
  };
  const top = nodes.find((n) => n.h === (only ?? root));
  let packageName: string | undefined;
  if (top?.a) {
    const k = nodeKey(ctx, top, root, folderKey) ?? (top.h === root ? folderKey : undefined);
    if (k) packageName = decryptAttr(ctx, top.a, k.length === 32 ? fileCipher(k).k : k)?.n;
  }
  const files: CrawledFile[] = [];
  for (const n of nodes) {
    if (n.t !== 0 || (only && !inside(n))) continue;
    const k = nodeKey(ctx, n, root, folderKey);
    if (!k || k.length !== 32) continue;
    const name = n.a ? decryptAttr(ctx, n.a, fileCipher(k).k)?.n : undefined;
    files.push({ url: `https://mega.nz/folder/${folder}#${keyText}/file/${n.h}`, name, size: typeof n.s === 'number' ? n.s : undefined });
  }
  return { packageName, files };
}

export default definePlugin({
  id: 'mega',
  name: 'MEGA',
  version: 4,
  domains: ['mega.nz', 'mega.co.nz'],
  matches: [FILE, FOLDER],
  accountRequired: false,
  account: {
    userLabel: { de: 'E-Mail', en: 'E-mail' },
    secretLabel: { de: 'Passwort', en: 'Password' },
    help: {
      de: 'Wie bei JDownloader: E-Mail und Passwort des MEGA-Accounts. Mit Pro-Account zählt dessen Transfer-Kontingent statt des freien pro IP. Zwei-Faktor-Anmeldung geht noch nicht.',
      en: 'Like JDownloader: the MEGA account\'s e-mail and password. With a Pro account its transfer quota counts instead of the free one per IP. Two-factor login does not work yet.',
    },
  },

  async checkAccount(ctx) {
    return accountInfo(ctx);
  },

  async crawl(link, ctx) {
    const d = FOLDER.exec(link);
    if (d && d[5]?.toLowerCase() !== 'file') return crawlFolder(ctx, link);
    return { files: [{ url: link }] };
  },

  async check(link, ctx) {
    const t = parseLink(link);
    if (!t) return { online: true };
    const info = await api(ctx, { a: 'g', ...(t.folder ? { n: t.id } : { p: t.id }) }, 'check', t.folder);
    const size = typeof info.s === 'number' ? info.s : undefined;
    let name: string | undefined;
    if (!t.folder && validFileKey(t.key) && typeof info.at === 'string') name = decryptAttr(ctx, info.at, fileCipher(b64(t.key!)).k)?.n;
    return { online: true, name, size };
  },

  async resolve(link, ctx) {
    const t = parseLink(link);
    if (!t) throw new PluginError('fatal', { de: 'MEGA: Ordner-Link, bitte neu hinzufügen', en: 'MEGA: folder link, please add it again' });
    return resolveFile(ctx, t);
  },
});
