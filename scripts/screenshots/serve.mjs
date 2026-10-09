// The server behind the README picture (pnpm screenshots): a fresh haul with its own data
// directory, whose downloads go to a stand-in for the internet on 127.0.0.1:8899. haul's HTTP
// client honors HTTP_PROXY, so every http:// link it fetches ends up here, where the files of
// FILES are served with their real sizes, each at its own speed, with HEAD and Range like a
// download server. No hoster accounts and no internet needed.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DATA = path.join(os.tmpdir(), 'haul-screenshots');
const PROXY_PORT = 8899;
export const LISTEN = '127.0.0.1:8437';
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** url → size and speed (bytes per second); `file` is served from disk instead of zeros */
const FILES = {
  'http://nas.example.com/Holiday-Photos-2025.7z': { file: path.join(DATA, 'Holiday-Photos-2025.7z'), rate: 40 * MiB },
  'http://download.blender.org/demo/movies/Sintel.2010.4K.HDR.mkv': { size: 6.4 * GiB, rate: 14.6 * MiB },
  'http://download.blender.org/demo/movies/Tears.of.Steel.2012.2160p.mkv': { size: 4.9 * GiB, rate: 11.1 * MiB },
  'http://releases.ubuntu.com/24.04.1/ubuntu-24.04.1-desktop-amd64.iso': { size: 5.7 * GiB, rate: 11.4 * MiB },
  'http://cdimage.debian.org/debian-cd/13.1.0/amd64/iso-dvd/debian-13.1.0-amd64-DVD-1.iso': { size: 3.8 * GiB, rate: 10.2 * MiB },
  'http://download.blender.org/archive/Blender-Open-Movies.part1.rar': { size: 700 * MiB, rate: 12.5 * MiB },
  'http://download.blender.org/archive/Blender-Open-Movies.part2.rar': { size: 700 * MiB, rate: 12.5 * MiB },
  'http://download.blender.org/archive/Blender-Open-Movies.part3.rar': { size: 650 * MiB, rate: 12.5 * MiB },
};

/** The photo archive: a real 7z, so haul can extract it */
function holidayPhotos(target) {
  const dir = path.join(DATA, 'Holiday Photos 2025');
  mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= 12; i++) {
    writeFileSync(path.join(dir, `IMG_${String(4100 + i * 7)}.jpg`), randomBytes(450 * 1024));
  }
  const sevenZip = process.env.HAUL_7Z || '7z';
  const r = spawnSync(sevenZip, ['a', '-mx=0', target, '.'], { cwd: dir, stdio: 'ignore' });
  if (r.status !== 0) throw new Error(`${sevenZip} could not create ${target}`);
}

const zeros = Buffer.alloc(256 * 1024);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const drained = (res) =>
  new Promise((resolve) => {
    const done = () => {
      res.off('drain', done).off('close', done);
      resolve();
    };
    res.on('drain', done).on('close', done);
  });

/** Sends bytes [start, end] of the file at `rate` bytes per second */
async function send(res, entry, start, end) {
  const disk = entry.file ? readFileSync(entry.file) : null;
  const t0 = performance.now();
  let pos = start;
  while (pos <= end && !res.destroyed) {
    const n = Math.min(zeros.length, end - pos + 1);
    const chunk = disk ? disk.subarray(pos, pos + n) : zeros.subarray(0, n);
    if (!res.write(chunk)) await drained(res);
    pos += n;
    const ahead = ((pos - start) / entry.rate) * 1000 - (performance.now() - t0);
    if (ahead > 0) await sleep(ahead);
  }
  res.end();
}

function fakeInternet() {
  return http.createServer((req, res) => {
    const entry = FILES[req.url];
    if (!entry) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    const size = entry.file ? statSync(entry.file).size : Math.round(entry.size);
    const headers = {
      'accept-ranges': 'bytes',
      'content-type': 'application/octet-stream',
      'last-modified': 'Mon, 06 Oct 2025 08:00:00 GMT',
    };
    let start = 0;
    let end = size - 1;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range && (range[1] || range[2])) {
      start = range[1] ? Number(range[1]) : size - Number(range[2]);
      end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      res.writeHead(206, { ...headers, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}` });
    } else {
      res.writeHead(200, { ...headers, 'content-length': size });
    }
    if (req.method === 'HEAD') res.end();
    else send(res, entry, start, end);
  });
}

rmSync(DATA, { recursive: true, force: true });
for (const dir of ['config', 'tmp', 'done']) mkdirSync(path.join(DATA, dir), { recursive: true });
holidayPhotos(FILES['http://nas.example.com/Holiday-Photos-2025.7z'].file);
fakeInternet().listen(PROXY_PORT, '127.0.0.1');

const proxy = `http://127.0.0.1:${PROXY_PORT}`;
const haul = spawn(process.env.HAUL_BIN || path.join(ROOT, 'target/release/haul'), {
  stdio: 'inherit',
  env: {
    ...process.env,
    APP_SECRET: 'screenshots',
    HAUL_CONFIG_DIR: path.join(DATA, 'config'),
    HAUL_TMP_DIR: path.join(DATA, 'tmp'),
    HAUL_DONE_DIR: path.join(DATA, 'done'),
    HAUL_LISTEN: LISTEN,
    HAUL_CNL_LISTEN: 'off',
    HAUL_USER: 'demo',
    HAUL_PASSWORD: 'demo-password',
    HTTP_PROXY: proxy,
    http_proxy: proxy,
    ALL_PROXY: '',
    all_proxy: '',
    NO_PROXY: '',
    no_proxy: '',
  },
});
haul.on('exit', (code) => process.exit(code ?? 1));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => haul.kill(signal));
