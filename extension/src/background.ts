/**
 * Background of the extension (service worker in Chrome, event page in Firefox): the context
 * menu "Send to Haul", Click'n'Load requests from the pages, and the result on the toolbar icon.
 */
import { forwardCnl, HaulError, sendLinks } from './api';
import { linksInText } from './links';
import { t } from './i18n';
import { loadSettings } from './settings';

const BADGE_RESET_MS = 4000;

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'link', title: t('menuLink'), contexts: ['link'] });
    chrome.contextMenus.create({ id: 'selection', title: t('menuSelection'), contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'page', title: t('menuPage'), contexts: ['page'] });
  });
}
chrome.runtime.onInstalled.addListener(createMenus);
chrome.runtime.onStartup.addListener(createMenus);

let badgeTimer: ReturnType<typeof setTimeout> | undefined;
async function showResult(ok: boolean, message: string) {
  clearTimeout(badgeTimer);
  await chrome.action.setBadgeBackgroundColor({ color: ok ? '#10b981' : '#e11d48' });
  await chrome.action.setBadgeText({ text: ok ? '✓' : '!' });
  await chrome.action.setTitle({ title: `${t('extName')}: ${message}` });
  badgeTimer = setTimeout(() => {
    void chrome.action.setBadgeText({ text: '' });
    void chrome.action.setTitle({ title: t('extName') });
  }, BADGE_RESET_MS);
}

function errorText(e: unknown): string {
  return e instanceof HaulError ? t(e.key) : String(e);
}

async function send(links: string[], sourcePage?: string) {
  try {
    const n = links.length;
    await sendLinks(await loadSettings(), links, sourcePage);
    await showResult(true, n === 1 ? t('sentOne') : t('sentMany', String(n)));
  } catch (e) {
    console.error(e);
    await showResult(false, errorText(e));
    if (e instanceof HaulError && (e.key === 'notConfigured' || e.key === 'unauthorized')) {
      void chrome.runtime.openOptionsPage();
    }
  }
}

/** The links inside the selection, asked from the page; the selection's text as a fallback. */
async function selectedLinks(tabId: number | undefined, frameId: number | undefined, text: string): Promise<string[]> {
  const fromText = linksInText(text);
  if (tabId === undefined) return fromText;
  try {
    const r = (await chrome.tabs.sendMessage(tabId, { type: 'selectedLinks' }, { frameId: frameId ?? 0 })) as { links?: string[] };
    const links = [...new Set([...(r?.links ?? []), ...fromText])].filter((l) => /^https?:\/\//i.test(l));
    return links;
  } catch {
    return fromText;
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  void (async () => {
    const page = info.pageUrl ?? tab?.url;
    if (info.menuItemId === 'link' && info.linkUrl) return send([info.linkUrl], page);
    if (info.menuItemId === 'selection') return send(await selectedLinks(tab?.id, info.frameId, info.selectionText ?? ''), page);
    if (info.menuItemId === 'page' && page) return send([page], page);
  })();
});

chrome.runtime.onMessage.addListener((msg: { type?: string; action?: 'add' | 'addcrypted2'; body?: string; page?: string }, _sender, reply) => {
  if (msg?.type === 'cnl' && msg.action) {
    void (async () => {
      try {
        await forwardCnl(await loadSettings(), msg.action!, msg.body ?? '', msg.page ?? '');
        await showResult(true, t('cnlSent'));
        reply({ ok: true });
      } catch (e) {
        console.error(e);
        await showResult(false, errorText(e));
        reply({ ok: false });
      }
    })();
    return true; // answers asynchronously
  }
  return undefined;
});
