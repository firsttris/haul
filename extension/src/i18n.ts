/** A text from `_locales/<lang>/messages.json` in the browser's language. */
export function t(key: string, ...subs: string[]): string {
  return chrome.i18n.getMessage(key, subs) || key;
}

/** Fills every `data-i18n` element with its text (and `data-i18n-placeholder` placeholders). */
export function localize(root: ParentNode = document) {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) el.textContent = t(el.dataset.i18n!);
  for (const el of root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-i18n-placeholder]')) {
    el.placeholder = t(el.dataset.i18nPlaceholder!);
  }
}
