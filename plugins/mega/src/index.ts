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
 * - Folders (`/folder/<id>#<key>`, pyLoad MegaCoNzFolder, JD crawler): `a:"f", c:1, r:1, ca:1`
 *   with `n=<id>` lists all nodes; a file's key is `<root>:<key>` in `k`, AES-ECB encrypted with
 *   the folder key. Files become `/folder/<id>#<key>/file/<node>`; `/folder/<id>#<key>/folder/
 *   <sub>` takes only that subfolder.
 */
import { definePlugin, HosterLimitError, OfflineError, PluginError, TemporaryError, withPassword, WRONG_PASSWORD } from '@haul/plugin-sdk';
import type { CrawledFile, Ctx, Resolved } from '@haul/plugin-sdk';

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

/** One API command; `node` is the folder a node belongs to (`n=`). */
async function api(ctx: Ctx, cmd: Record<string, unknown>, when: 'check' | 'download', node?: string): Promise<Record<string, unknown>> {
  const url = `${API}?id=${seq++}${node ? `&n=${encodeURIComponent(node)}` : ''}`;
  const res = await ctx.http.post(url, JSON.stringify([cmd]), { headers: { 'Content-Type': 'text/plain;charset=UTF-8' } });
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
  const info = await api(ctx, cmd, 'download', t.folder);
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
  version: 2,
  matches: [FILE, FOLDER],
  accountRequired: false,

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
