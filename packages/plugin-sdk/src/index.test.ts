import { describe, expect, it } from 'vitest';
import { base64Decode, bilingual, cookiesFrom, findCaptcha, OfflineError, pickLang, decodeHtml, match, parseForms, parseSize, recaptchaKeyInCode, resolveUrl } from './index';
import { fakeCtx } from './testing';

describe('parseSize', () => {
  it('handles units and separators', () => {
    expect(parseSize('1.5 GB')).toBe(1610612736);
    expect(parseSize('700,5 MB')).toBe(Math.round(700.5 * 1024 ** 2));
    expect(parseSize('1.234,5 KB')).toBe(Math.round(1234.5 * 1024));
    expect(parseSize('12345')).toBe(12345);
    expect(parseSize('')).toBeUndefined();
  });
});

describe('html helpers', () => {
  it('parses forms', () => {
    const html = `<form name="F1" method="POST" action="/dl">
      <input type="hidden" name="op" value="download2">
      <input type="hidden" name="id" value='abc'>
      <input type="checkbox" name="skip" value="1">
      <input type="checkbox" name="keep" value="1" checked>
      <input type="submit" name="go" value="Go">
      <select name="q"><option value="a">A</option><option value="b" selected>B</option></select>
    </form>`;
    const [f] = parseForms(html);
    expect(f.method).toBe('post');
    expect(f.action).toBe('/dl');
    expect(f.fields).toEqual({ op: 'download2', id: 'abc', keep: '1', q: 'b' });
  });

  it('matches and decodes', () => {
    expect(match('<h4>A &amp; B</h4>', /<h3>(.*)<\/h3>/, /<h4>(.*)<\/h4>/)).toBe('A & B');
    expect(decodeHtml('&#65;&#x42;')).toBe('AB');
  });

  it('resolves urls', () => {
    expect(resolveUrl('https://a.com/x/y.html', '/z')).toBe('https://a.com/z');
    expect(resolveUrl('https://a.com/x/y.html', 'z')).toBe('https://a.com/x/z');
    expect(resolveUrl('https://a.com/x', '//b.com/q')).toBe('https://b.com/q');
  });

  it('reads cookies', async () => {
    const ctx = fakeCtx({ 'GET https://a.com': { headers: { 'Set-Cookie': 'a=1; Path=/\nb=2' } } });
    expect(cookiesFrom(await ctx.http.get('https://a.com/'))).toEqual({ a: '1', b: '2' });
  });
});

describe('base64Decode', () => {
  it('matches Buffer for URLs and UTF-8', () => {
    for (const text of ['https://download1234.mediafire.com/abc/q1w2e3/Film.part1.rar', 'Größe ✓', 'a', 'ab']) {
      const b64 = Buffer.from(text, 'utf8').toString('base64');
      expect(base64Decode(b64)).toBe(text);
      expect(base64Decode(b64.replace(/=+$/, ''))).toBe(text);
    }
  });
});

describe('bilingual messages', () => {
  it('packs both languages into one string', () => {
    const msg = `x: ${bilingual('Datei offline', 'File offline')}`;
    expect(msg).toBe('x: \u0002Datei offline\u001fFile offline\u0003');
    expect(pickLang(msg, 'de')).toBe('x: Datei offline');
    expect(pickLang(msg, 'en')).toBe('x: File offline');
    // Markers inside the texts cannot break the frame.
    expect(pickLang(bilingual('a\u0003b', 'c'), 'de')).toBe('ab');
  });

  it('errors take { de, en } or a plain string', () => {
    const e = new OfflineError({ de: 'Ordner gelöscht', en: 'Folder deleted' });
    expect(e.haulKind).toBe('offline');
    expect(pickLang(e.message, 'en')).toBe('Folder deleted');
    expect(pickLang(new OfflineError().message, 'de')).toBe('Datei offline');
    expect(new OfflineError('HTTP 410').message).toBe('HTTP 410');
  });
});

describe('captcha site keys (JD AbstractRecaptchaV2.findNextSiteKey)', () => {
  const KEY = '6LcAbCdEfGhIjKlMnOpQrStU';
  it('finds the widget, the render call and the fallback iframe', () => {
    expect(findCaptcha(`<div class="g-recaptcha" data-sitekey="${KEY}"></div>`)).toEqual({ kind: 'recaptcha', siteKey: KEY });
    expect(recaptchaKeyInCode(`<script>grecaptcha.render('box', { 'sitekey' : '${KEY}', theme: 'dark' });</script>`)).toBe(KEY);
    expect(recaptchaKeyInCode(`grecaptcha.enterprise.render(el, {sitekey: "${KEY}"})`)).toBe(KEY);
    expect(recaptchaKeyInCode(`<iframe src="https://www.google.com/recaptcha/api/fallback?k=${KEY}"></iframe>`)).toBe(KEY);
    expect(findCaptcha(`<noscript><iframe src="https://www.google.com/recaptcha/api/fallback?k=${KEY}"></iframe></noscript>`)?.siteKey).toBe(KEY);
  });

  it('leaves out v3 and keys that are no reCaptcha keys', () => {
    // v3: nothing to solve by hand (JD: render=… in the script URL, grecaptcha.execute).
    expect(recaptchaKeyInCode(`<script src="https://www.google.com/recaptcha/api.js?render=${KEY}"></script>`)).toBeUndefined();
    expect(recaptchaKeyInCode(`grecaptcha.execute('${KEY}', { action: 'dl' })`)).toBeUndefined();
    expect(recaptchaKeyInCode(`grecaptcha.render('box', { sitekey: 'not-a-key' })`)).toBeUndefined();
  });
});
