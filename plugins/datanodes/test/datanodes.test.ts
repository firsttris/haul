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
        // download1 as a plain form; download2 as the page's script sends it (2026-09-30).
        expect(req.headers?.Referer).toBe(req.form?.op === 'download1' ? 'https://datanodes.to/users' : 'https://datanodes.to/download');
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

  it('takes a limit page for a limit, not for premium only', async () => {
    const limited = (text: string) =>
      fakeCtx({
        'GET https://datanodes.to/abcdefghijkl': { body: PAGE1 },
        'POST https://datanodes.to/abcdefghijkl': { body: `<a href="/premium">Premium</a><div class="alert">${text}</div>` },
      });
    await expect(plugin.resolve(LINK, limited('All download slots are in use, try again later'))).rejects.toMatchObject({ haulKind: 'temporary', haulWait: 900 });
    await expect(plugin.resolve(LINK, limited('Download-limit reached. Please wait 2 hours'))).rejects.toMatchObject({ haulKind: 'temporary', haulWait: 7201 });
    await expect(plugin.resolve(LINK, limited('Buy premium'))).rejects.toMatchObject({ haulKind: 'fatal' });
  });

  it('sends a countdown longer than a plugin call back to the queue', async () => {
    const ctx = fakeCtx({
      'GET https://datanodes.to/abcdefghijkl': { body: PAGE1 },
      'POST https://datanodes.to/abcdefghijkl': { body: PAGE2_JS.replace('countdown="7"', 'countdown="600"') },
    });
    await expect(plugin.resolve(LINK, ctx)).rejects.toMatchObject({ haulKind: 'temporary', haulWait: 600 });
    expect(ctx.waits).toEqual([]);
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

  it('has the user solve the Turnstile from a captcha-html over several lines (2026-09)', async () => {
    // Structure of the real step 2 page (POST /download answer, 2026-09-30).
    const page2 = `<download-countdown :countdown="10"
        code="abcdefghijkl" referer="https://datanodes.to/users" rand="22dau"
        free-method="Free Download" premium-method=""
        :has-captcha="true"
        captcha-html="&lt;script src=&quot;https://challenges.cloudflare.com/turnstile/v0/api.js&quot; defer&gt;&lt;/script&gt;
&lt;div class=&quot;cf-turnstile&quot; data-sitekey=&quot;0x4AAAAAAD8U9nktqncPIkBM&quot;&gt;&lt;/div&gt;
"
        :has-countdown="true" message=""
        dl-token="1790746876.10.aa4f191644faccf7d125c31f"
        name="Film.part1.rar"></download-countdown>`;
    const posts: HttpRequest[] = [];
    const ctx = fakeCtx({
      'GET https://datanodes.to/abcdefghijkl': { body: PAGE1 },
      'POST https://datanodes.to/abcdefghijkl': (req) => {
        posts.push(req);
        // The answer in the browser (2026-09-30): the link URL-encoded in JSON.
        return req.form?.op === 'download1' ? { body: page2 } : { body: JSON.stringify({ url: encodeURIComponent(CDN) }) };
      },
    });
    expect((await plugin.resolve(LINK, ctx)).url).toBe(CDN);
    expect(ctx.captchas[0]).toMatchObject({ kind: 'turnstile', siteKey: '0x4AAAAAAD8U9nktqncPIkBM' });
    // The fields of the browser's request (2026-09-30), method_free aside (the browser's is in its language).
    expect(posts[1].form).toEqual({
      op: 'download2',
      g_captch__a: '1',
      id: 'abcdefghijkl',
      rand: '22dau',
      dl_token: '1790746876.10.aa4f191644faccf7d125c31f',
      referer: 'https://datanodes.to/users',
      method_free: 'Free Download >>',
      method_premium: '',
      'cf-turnstile-response': 'CAPTCHA-TOKEN',
    });
    // The headers the page's script sends; download1 goes like a plain form.
    expect(posts[1].headers).toMatchObject({ 'x-dn-dl': '1', Origin: 'https://datanodes.to', Referer: 'https://datanodes.to/download', Accept: '*/*' });
    expect(posts[0].headers?.['x-dn-dl']).toBeUndefined();
    expect(posts[0].headers?.Referer).toBe('https://datanodes.to/users');
    expect(ctx.waits[0]).toBeGreaterThan(9);
  });

  it('reports a wrong captcha, not offline, when the page also says "No such file" (2026-09)', async () => {
    const page2 = `<download-countdown countdown="1" rand="r" captcha-html="&lt;div class=&quot;cf-turnstile&quot; data-sitekey=&quot;k&quot;&gt;&lt;/div&gt;"></download-countdown>`;
    const answer = `<a href="/premium">Pricing</a><div><p class="m-0">No such file</p></div><div><p class="m-0">Wrong captcha</p></div>`;
    const ctx = fakeCtx({
      'GET https://datanodes.to/abcdefghijkl': { body: PAGE1 },
      'POST https://datanodes.to/abcdefghijkl': (req) => (req.form?.op === 'download1' ? { body: page2 } : { body: answer }),
    });
    await expect(plugin.resolve(LINK, ctx)).rejects.toMatchObject({ haulKind: 'temporary' });
  });

  it('stops when the site takes free downloads only from a browser (2026-09)', async () => {
    const page2 = `<download-countdown countdown="1" rand="r" dl-token="t"></download-countdown>`;
    const answer = JSON.stringify({
      error: 'Free downloads are only available through your web browser. Please open this link in a browser, or upgrade to Premium for direct and download-manager support.',
    });
    const ctx = fakeCtx({
      'GET https://datanodes.to/abcdefghijkl': { body: PAGE1 },
      'POST https://datanodes.to/abcdefghijkl': (req) => (req.form?.op === 'download1' ? { body: page2 } : { body: answer }),
    });
    await expect(plugin.resolve(LINK, ctx)).rejects.toMatchObject({ haulKind: 'fatal' });
  });

  it('knows its own errors', async () => {
    const domain = fakeCtx({ 'GET https://datanodes.to/abcdefghijkl': { body: "<p> Not allowed from domain you're coming from</p>" } });
    await expect(plugin.resolve(LINK, domain)).rejects.toMatchObject({ haulKind: 'fatal' });
    const premium = fakeCtx({ 'GET https://datanodes.to/abcdefghijkl': { body: '<a href="/premium">Buy premium to download</a>' } });
    await expect(plugin.resolve(LINK, premium)).rejects.toThrow(/Premium/);
  });
});
