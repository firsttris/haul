/**
 * Content script in the extension's own world, next to cnl-page.ts: tells the page script whether
 * Click'n'Load is on, and passes its requests to the background, which sends them to Haul. The
 * token never reaches the page. It also collects the links of a selection for the context menu.
 */
import { loadSettings } from './settings';

const TAG = '__haulCnl';

async function postConfig() {
  const { cnl, server, token } = await loadSettings();
  window.postMessage({ [TAG]: 'config', enabled: cnl && !!server && !!token }, '*');
}

window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || typeof e.data !== 'object') return;
  const msg = e.data as { [TAG]?: string; id?: number; action?: string; body?: string; page?: string };
  if (msg[TAG] === 'hello') {
    void postConfig();
  } else if (msg[TAG] === 'request' && (msg.action === 'add' || msg.action === 'addcrypted2')) {
    chrome.runtime
      .sendMessage({ type: 'cnl', action: msg.action, body: String(msg.body ?? ''), page: String(msg.page ?? location.href) })
      .then((r: { ok?: boolean } | undefined) => window.postMessage({ [TAG]: 'result', id: msg.id, ok: !!r?.ok }, '*'))
      .catch(() => window.postMessage({ [TAG]: 'result', id: msg.id, ok: false }, '*'));
  }
});

void postConfig();
chrome.storage.onChanged.addListener(() => void postConfig());

// The context menu's "links in the selection": the hrefs of the links inside it.
chrome.runtime.onMessage.addListener((msg: { type?: string }, _sender, reply) => {
  if (msg?.type !== 'selectedLinks') return;
  const sel = window.getSelection();
  const links: string[] = [];
  if (sel) {
    for (let i = 0; i < sel.rangeCount; i++) {
      const range = sel.getRangeAt(i);
      const box = document.createElement('div');
      box.append(range.cloneContents());
      for (const a of box.querySelectorAll('a[href]')) links.push((a as HTMLAnchorElement).href);
      const start = range.startContainer.parentElement?.closest('a[href]');
      if (start) links.push((start as HTMLAnchorElement).href);
    }
  }
  reply({ links, text: sel?.toString() ?? '' });
});
