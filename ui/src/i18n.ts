/**
 * The interface language. The texts live in messages/{de,en}.json and are compiled by Paraglide
 * to src/paraglide: components call them directly (m.settings_title()). The language is the one
 * picked in the UI (kept in localStorage), else the browser's; a change reloads the page.
 *
 * The server sends its messages as keys with their inputs, `\u0002["key",{…}]\u0003`, possibly
 * inside other text (see crates/haul/src/i18n.rs); localize() renders them. Plugins and entries
 * stored by older versions carry both texts instead: `\u0002` de `\u001f` en `\u0003`.
 */
import * as m from './paraglide/messages';
import { overwriteGetLocale } from './paraglide/runtime';

export type Lang = 'de' | 'en';
export const LANGS: { id: Lang; label: string }[] = [
  { id: 'de', label: 'Deutsch' },
  { id: 'en', label: 'English' },
];
const STORAGE_KEY = 'haul.lang';

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'de' || saved === 'en') return saved;
  } catch {
    /* storage blocked */
  }
  const browser = typeof navigator !== 'undefined' ? navigator.languages?.[0] ?? navigator.language : '';
  return browser?.toLowerCase().startsWith('de') ? 'de' : 'en';
}

const current: Lang = initialLang();
if (typeof document !== 'undefined') document.documentElement.lang = current;
// Paraglide's m.*() ask getLocale(): answer with the language picked here.
overwriteGetLocale(() => current);

export function getLang(): Lang {
  return current;
}

/** Saves the choice and reloads, so every text, including live data, comes in the new language. */
export function setLang(lang: Lang) {
  if (lang === current) return;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* storage blocked: nothing to keep the choice in */
  }
  location.reload();
}

/** The current language. */
export function useLang(): Lang {
  return current;
}

/** Intl locale of the current language. */
export const localeOf = (lang: Lang = current) => (lang === 'de' ? 'de-DE' : 'en-US');

type Inputs = Record<string, string | number>;
const messages = m as unknown as Record<string, ((inputs: Inputs, options: { locale: Lang }) => string) | undefined>;

// eslint-disable-next-line no-control-regex
const MARKED = /\u0002([^\u001f\u0003]*)(?:\u001f([^\u0003]*))?(?:\u0003|$)/g;

/** A message from the server or a plugin in the viewer's language; plain text stays as it is. */
export function localize(text: string, lang?: Lang): string;
export function localize(text: string | null | undefined, lang?: Lang): string | null;
export function localize(text: string | null | undefined, lang: Lang = current): string | null {
  if (text == null) return null;
  if (!text.includes('\u0002')) return text;
  return text.replace(MARKED, (whole, body: string, en?: string) => {
    if (en === undefined && body.startsWith('[')) {
      try {
        const [key, inputs] = JSON.parse(body) as [string, Inputs | undefined];
        // Inputs can be messages themselves (a tool's line inside an extraction error).
        const resolved = Object.fromEntries(
          Object.entries(inputs ?? {}).map(([k, v]) => [k, typeof v === 'string' ? localize(v, lang) : v]),
        );
        return messages[key]?.(resolved, { locale: lang }) ?? key;
      } catch {
        return whole;
      }
    }
    return lang === 'en' ? (en ?? body) : body;
  });
}

/** A message picked by a runtime key (status, filter …); unknown keys come back as they are. */
export function pickMsg(map: Record<string, () => string>, key: string): string {
  return map[key]?.() ?? key;
}

/** A text from a plugin: plain, or one per language (`{ de, en }`). */
export type PluginText = string | Partial<Record<Lang, string>>;

export function pluginText(text: PluginText | null | undefined, lang: Lang): string | undefined {
  if (text == null) return undefined;
  if (typeof text === 'string') return localize(text, lang);
  return text[lang] ?? text.en ?? text.de ?? Object.values(text)[0];
}
