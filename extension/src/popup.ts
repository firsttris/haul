import { HaulError, sendLinks, stats } from './api';
import { localize, t } from './i18n';
import { linksInText } from './links';
import { loadSettings } from './settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const links = $<HTMLTextAreaElement>('links');
const status = $<HTMLDivElement>('status');

function show(ok: boolean, text: string) {
  status.textContent = text;
  status.className = `status ${ok ? 'ok' : 'bad'}`;
}

async function send(list: string[], page?: string) {
  try {
    await sendLinks(await loadSettings(), list, page);
    show(true, list.length === 1 ? t('sentOne') : t('sentMany', String(list.length)));
    links.value = '';
  } catch (e) {
    show(false, e instanceof HaulError ? t(e.key) : String(e));
  }
}

$('sendLinks').addEventListener('click', () => void send(linksInText(links.value)));
$('sendPage').addEventListener('click', () => {
  void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (tab?.url && /^https?:\/\//i.test(tab.url)) void send([tab.url], tab.url);
    else show(false, t('noLinks'));
  });
});
$('settings').addEventListener('click', (e) => {
  e.preventDefault();
  void chrome.runtime.openOptionsPage();
});
$('open').addEventListener('click', (e) => {
  e.preventDefault();
  void loadSettings().then(async (s) => {
    if (s.server) await chrome.tabs.create({ url: s.server });
    else await chrome.runtime.openOptionsPage();
  });
});

localize();
void loadSettings().then(async (s) => {
  if (!s.server || !s.token) {
    show(false, t('notConfigured'));
    return;
  }
  try {
    const st = await stats(s);
    $('stats').textContent = t('statsLine', String(st.active), String(st.queued));
  } catch (e) {
    show(false, e instanceof HaulError ? t(e.key) : String(e));
  }
});
