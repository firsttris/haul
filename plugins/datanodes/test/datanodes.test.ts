import { describe, expect, it } from 'vitest';
import { fakeCtx } from '@haul/plugin-sdk/testing';
import type { HttpRequest } from '@haul/plugin-sdk';
import plugin from '../src/index';

const LINK = 'https://datanodes.to/abcdefghijkl/Film.part1.rar';
const PAGE1 = `<a href="/premium">Premium</a>
  <file-actions link="https://datanodes.to/abcdefghijkl/Film.part1.rar"></file-actions>
  <form id="downloadForm" method="POST" action="">
    <input type="hidden" name="op" value="download1">
    <input type="hidden" name="id" value="abcdefghijkl">
    <input type="hidden" name="fname" value="Film.part1.rar">
    <input type="hidden" name="method_free" value="Free Download">
  </form>`;
// The download2 form comes via JavaScript: only its data is in the page (JD builds the form).
const PAGE2_JS = `<a href="/premium">Premium</a>
  <download-countdown countdown="7" rand="r4nd" dl-token="tok9"></download-countdown>`;
const CDN = 'https://dn12.datanodes.to/d/hash/Film.part1.rar';

describe('datanodes', () => {
  it('reads the name from file-actions (JD scanInfo)', async () => {
    const ctx = fakeCtx({ 'GET https://datanodes.to/abcdefghijkl': { body: PAGE1 } });
    expect((await plugin.check!(LINK, ctx)).name).toBe('Film.part1.rar');
  });

  it('builds download2 like JD when the page makes it with JavaScript, and reads the JSON link', async () => {
    const posts: HttpRequest[] = [];
    const ctx = fakeCtx({
      'GET https://datanodes.to/abcdefghijkl': (req) => {
        expect(req.headers?.Referer).toBe('https://datanodes.to/users');
        return { body: PAGE1 };
      },
      'POST https://datanodes.to/abcdefghijkl': (req) => {
        posts.push(req);
        expect(req.headers?.Referer).toBe('https://datanodes.to/users');
        if (req.form?.op === 'download1') return { body: PAGE2_JS };
        return { body: JSON.stringify({ url: encodeURIComponent(CDN) + '\n' }) };
      },
    });
    const r = await plugin.resolve(LINK, ctx);
    expect(posts[0].form).toMatchObject({ op: 'download1', id: 'abcdefghijkl', method_free: 'Free Download' });
    expect(posts[1].form).toEqual({
      op: 'download2',
      g_captch__a: '1',
      id: 'abcdefghijkl',
      rand: 'r4nd',
      dl_token: 'tok9',
      referer: 'https://datanodes.to/abcdefghijkl',
      method_free: 'Free Download >>',
      method_premium: '',
    });
    expect(ctx.waits[0]).toBeGreaterThan(6);
    expect(r).toMatchObject({ url: CDN, name: 'Film.part1.rar', maxConnections: 1 });
  });

  it('adds g_captch__a to a normal download2 form', async () => {
    const page2 = `<form name="F1" method="POST" action=""><input type="hidden" name="op" value="download2">
      <input type="hidden" name="id" value="abcdefghijkl"><input type="hidden" name="rand" value="x"></form>`;
    const ctx = fakeCtx({
      'GET https://datanodes.to/abcdefghijkl': { body: PAGE1 },
      'POST https://datanodes.to/abcdefghijkl': (req) =>
        req.form?.op === 'download1' ? { body: page2 } : (expect(req.form?.g_captch__a).toBe('1'), { status: 302, headers: { location: CDN } }),
    });
    expect((await plugin.resolve(LINK, ctx)).url).toBe(CDN);
  });

  it('has the user solve the reCaptcha from captcha-html', async () => {
    const page2 = `<download-countdown countdown="3" rand="r" captcha-html="&lt;div class=&quot;g-recaptcha&quot; data-sitekey=&quot;k&quot;&gt;&lt;/div&gt;"></download-countdown>`;
    const ctx = fakeCtx({
      'GET https://datanodes.to/abcdefghijkl': { body: PAGE1 },
      'POST https://datanodes.to/abcdefghijkl': (req) =>
        req.form?.op === 'download1'
          ? { body: page2 }
          : (expect(req.form?.['g-recaptcha-response']).toBe('CAPTCHA-TOKEN'), { status: 302, headers: { location: CDN } }),
    });
    expect((await plugin.resolve(LINK, ctx)).url).toBe(CDN);
    expect(ctx.captchas[0]).toMatchObject({ kind: 'recaptcha', siteKey: 'k' });
  });

  it('finds a reCaptcha set up by a script (JD: g-recaptcha-response in the page)', async () => {
    const key = '6LdDataNodesKey12345678';
    const page2 = `<download-countdown countdown="2" rand="r"></download-countdown>
      <textarea name="g-recaptcha-response" style="display:none"></textarea>
      <script>grecaptcha.render('rc', { 'sitekey': '${key}' });</script>`;
    const ctx = fakeCtx({
      'GET https://datanodes.to/abcdefghijkl': { body: PAGE1 },
      'POST https://datanodes.to/abcdefghijkl': (req) =>
        req.form?.op === 'download1'
          ? { body: page2 }
          : (expect(req.form?.['g-recaptcha-response']).toBe('CAPTCHA-TOKEN'), { status: 302, headers: { location: CDN } }),
    });
    expect((await plugin.resolve(LINK, ctx)).url).toBe(CDN);
    expect(ctx.captchas[0]).toMatchObject({ kind: 'recaptcha', siteKey: key });
  });

  it('does not ask for a captcha because of an unrelated script', async () => {
    const page2 = `<download-countdown countdown="2" rand="r"></download-countdown>
      <script>grecaptcha.render('newsletter', { 'sitekey': '6LdNewsletterKey1234567' });</script>`;
    const ctx = fakeCtx({
      'GET https://datanodes.to/abcdefghijkl': { body: PAGE1 },
      'POST https://datanodes.to/abcdefghijkl': (req) =>
        req.form?.op === 'download1' ? { body: page2 } : { status: 302, headers: { location: CDN } },
    });
    expect((await plugin.resolve(LINK, ctx)).url).toBe(CDN);
    expect(ctx.captchas).toEqual([]);
  });

  it('sends method_free when it is a submit button (JD findFormDownload1Free)', async () => {
    const page1 = `<form id="downloadForm" method="POST" action="">
      <input type="hidden" name="op" value="download1"><input type="hidden" name="id" value="abcdefghijkl">
      <input type="submit" name="method_free" value="Free Download &gt;&gt;"></form>`;
    const ctx = fakeCtx({
      'GET https://datanodes.to/abcdefghijkl': { body: page1 },
      'POST https://datanodes.to/abcdefghijkl': (req) =>
        req.form?.op === 'download1'
          ? (expect(req.form?.method_free).toBeTruthy(), { body: PAGE2_JS })
          : { body: JSON.stringify({ url: CDN }) },
    });
    expect((await plugin.resolve(LINK, ctx)).url).toBe(CDN);
  });

  it('posts the form to /download, where the file link redirects to (2026-09)', async () => {
    // The real page, shortened: the decoy fname outside every form, the form with action='' and
    // a disabled submit button that the page's script enables after its "scan".
    const page1 = `<input type="hidden" name="fname" value="Download">
      <file-actions link="https://datanodes.to/abcdefghijkl/OG19952-COREDEA.part01.rar" code="abcdefghijkl"></file-actions>
      <form method="POST" action='' id="downloadForm" class="m-0 w-full">
        <input type="hidden" name="op" value="download1">
        <input type="hidden" name="usr_login" value="">
        <input type="hidden" name="id" value="abcdefghijkl">
        <input type="hidden" name="fname" value="OG19952-COREDEA.part01.rar">
        <input type="hidden" name="referer" value="https://datanodes.to/users">
        <button type="submit" id="method_free" name="method_free" disabled value="Free Download >>">Continue to Download</button>
      </form>`;
    const posts: HttpRequest[] = [];
    const ctx = fakeCtx({
      'GET https://datanodes.to/abcdefghijkl': { url: 'https://datanodes.to/download', body: page1 },
      'POST https://datanodes.to/download': (req) => {
        posts.push(req);
        if (req.form?.op === 'download1') return { body: PAGE2_JS };
        return { body: JSON.stringify({ url: CDN }) };
      },
    });
    const r = await plugin.resolve(LINK, ctx);
    expect(posts.map((p) => p.form?.op)).toEqual(['download1', 'download2']);
    // JD findFormDownload1Free: the disabled button's value is not taken, "Free Download" is.
    expect(posts[0].form).toEqual({
      op: 'download1',
      usr_login: '',
      id: 'abcdefghijkl',
      fname: 'OG19952-COREDEA.part01.rar',
      referer: 'https://datanodes.to/users',
      method_free: 'Free Download',
    });
    expect(r).toMatchObject({ url: CDN, name: 'OG19952-COREDEA.part01.rar' });
  });

  it('knows its own errors', async () => {
    const domain = fakeCtx({ 'GET https://datanodes.to/abcdefghijkl': { body: "<p> Not allowed from domain you're coming from</p>" } });
    await expect(plugin.resolve(LINK, domain)).rejects.toMatchObject({ haulKind: 'fatal' });
    const premium = fakeCtx({ 'GET https://datanodes.to/abcdefghijkl': { body: '<a href="/premium">Buy premium to download</a>' } });
    await expect(plugin.resolve(LINK, premium)).rejects.toThrow(/Premium/);
  });
});
