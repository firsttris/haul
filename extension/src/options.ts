import { HaulError, stats } from './api';
import { localize, t } from './i18n';
import { loadSettings, normalizeServer, originPattern, saveSettings, type Settings } from './settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>('form');
const server = $<HTMLInputElement>('server');
const token = $<HTMLInputElement>('token');
const cnl = $<HTMLInputElement>('cnl');
const start = $<HTMLInputElement>('start');
const status = $<HTMLDivElement>('status');

function show(ok: boolean, text: string) {
  status.textContent = text;
  status.className = `status ${ok ? 'ok' : 'bad'}`;
}

/** The form's settings; throws on a missing or invalid address. */
function current(): Settings {
  const address = normalizeServer(server.value);
  if (!address) throw new Error('no address');
  return { server: address, token: token.value.trim(), cnl: cnl.checked, start: start.checked };
}

const PAGES = ['http://*/*', 'https://*/*'];

/** Host permissions the extension has; Chrome grants the pages with the content scripts on install. */
let granted: string[] = [];
const refreshGranted = () =>
  void chrome.permissions.getAll().then((p) => {
    granted = p.origins ?? [];
  });
refreshGranted();
chrome.permissions.onAdded.addListener(refreshGranted);
chrome.permissions.onRemoved.addListener(refreshGranted);

/**
 * Asks for the Haul server and, for Click'n'Load, the pages when they are missing (Firefox leaves
 * them to the user). Called synchronously from the click: Firefox allows `permissions.request`
 * only while handling user input, not after an `await`. Already granted ones resolve without asking.
 */
function requestPermissions(s: Settings): Promise<boolean> {
  const origins = [originPattern(s.server)];
  if (s.cnl && !PAGES.every((p) => granted.includes(p))) origins.push(...PAGES);
  return chrome.permissions.request({ origins });
}

async function check(s: Settings) {
  try {
    const st = await stats(s);
    show(true, t('connected', String(st.active), String(st.queued)));
  } catch (e) {
    show(false, e instanceof HaulError ? t(e.key) : String(e));
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  let s: Settings;
  try {
    s = current();
  } catch {
    show(false, t('badServer'));
    return;
  }
  const allowed = requestPermissions(s);
  void (async () => {
    if (!(await allowed)) {
      show(false, t('noPermission'));
      return;
    }
    await saveSettings(s);
    server.value = s.server;
    await check(s);
  })();
});

$<HTMLButtonElement>('test').addEventListener('click', () => {
  let s: Settings;
  try {
    s = current();
  } catch {
    show(false, t('badServer'));
    return;
  }
  const allowed = requestPermissions(s);
  void (async () => {
    if (!(await allowed)) return show(false, t('noPermission'));
    await check(s);
  })();
});

localize();
void loadSettings().then((s) => {
  server.value = s.server;
  token.value = s.token;
  cnl.checked = s.cnl;
  start.checked = s.start;
});
