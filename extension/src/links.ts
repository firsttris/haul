/** http(s) links in free text, in order, without duplicates and trailing punctuation. */
export function linksInText(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s<>"'`]+/gi) ?? [];
  const links = found.map((l) => l.replace(/[.,;:!?)\]}]+$/, ''));
  return [...new Set(links)];
}

/** A Click'n'Load address: `http://127.0.0.1:9666/flash/add` or `…/flash/addcrypted2`. */
export function cnlAction(url: string): 'add' | 'addcrypted2' | undefined {
  const m = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):9666\/flash\/(addcrypted2|add)\/?(?:[?#]|$)/i.exec(url);
  return m ? (m[1].toLowerCase() as 'add' | 'addcrypted2') : undefined;
}
