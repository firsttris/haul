import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api, post, type Captcha } from '../api';
import { useLang, useT } from '../i18n';

export function useCaptchas() {
  return useQuery({ queryKey: ['captchas'], queryFn: () => api<Captcha[]>('/captchas'), refetchInterval: 30_000 });
}

/** The hoster page with the challenge in the fragment, for the userscript (captcha.user.js). */
export function captchaUrl(c: Captcha, lang: string): string {
  const params = {
    'haul-captcha': c.id,
    secret: c.secret,
    server: location.origin,
    kind: c.kind,
    sitekey: c.siteKey,
    enterprise: c.enterprise ? '1' : '0',
    lang,
  };
  const hash = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `${c.pageUrl.split('#')[0]}#${hash}`;
}

/** Answered right here: a download password, or the text of an image captcha. */
function AnswerRow({ c, now }: { c: Captcha; now: number }) {
  const t = useT();
  const [value, setValue] = useState('');
  const name = c.name ?? c.link ?? c.host;
  const minutes = Math.max(0, Math.ceil((c.expiresAt - now) / 60_000));
  const isImage = c.kind === 'image';
  const answer = useMutation({ mutationFn: () => post('/captcha/solve', { id: c.id, secret: c.secret, token: value }) });
  const cancel = useMutation({ mutationFn: () => post(`/captchas/${c.id}/cancel`) });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (value) answer.mutate();
  }

  return (
    <form className="captcha-row" onSubmit={submit}>
      {isImage ? (
        <>
          <span className="mono">{t.captcha.item(c.host, c.pluginName, minutes)}</span>
          {c.image && <img className="captcha-image" src={c.image} alt={t.captcha.imageAlt} />}
        </>
      ) : (
        <span className="mono">
          {t.captcha.passwordFor(name, c.pluginName, minutes)}
          {c.wrong && <strong> {t.captcha.passwordWrong}</strong>}
          {c.link && c.link !== name && <span className="subtitle"> {c.link}</span>}
        </span>
      )}
      <div className="spacer" />
      <input
        type={isImage ? 'text' : 'password'}
        className="input small"
        aria-label={isImage ? t.captcha.imageLabel : t.captcha.passwordLabel(name)}
        autoComplete="off"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoFocus
      />
      <button type="submit" className="btn small primary" disabled={!value || answer.isPending}>
        {t.captcha.passwordOk}
      </button>
      <button type="button" className="btn small" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
        {t.captcha.cancel}
      </button>
    </form>
  );
}

/** Notice on every page while captchas or passwords wait; also in the tab title and as a notification. */
export function CaptchaBanner() {
  const t = useT();
  const lang = useLang();
  const { data = [] } = useCaptchas();
  const cancel = useMutation({ mutationFn: (id: string) => post(`/captchas/${id}/cancel`) });
  const [now, setNow] = useState(Date.now());
  const seen = useRef(new Set<string>());

  useEffect(() => {
    setNow(Date.now());
    if (!data.length) return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [data]);

  useEffect(() => {
    const base = document.title.replace(/^\(\d+\) /, '');
    document.title = data.length ? `(${data.length}) ${base}` : base;
    for (const c of data) {
      if (seen.current.has(c.id)) continue;
      seen.current.add(c.id);
      try {
        if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
          const body = c.kind === 'password' ? t.captcha.notifyPassword(c.name ?? c.host) : t.captcha.notify(c.host);
          new Notification('Haul', { body, tag: `haul-captcha-${c.id}` });
        }
      } catch {
        /* notifications unavailable */
      }
    }
  }, [data, t]);

  if (!data.length) return null;
  const passwords = data.filter((c) => c.kind === 'password');
  const images = data.filter((c) => c.kind === 'image');
  // reCaptcha, hCaptcha, Turnstile: solved on the hoster's page with the userscript.
  const captchas = data.filter((c) => c.kind !== 'password' && c.kind !== 'image');
  return (
    <div className="captcha-banner" role="alert">
      {passwords.length > 0 && (
        <div className="captcha-head">
          <strong>{t.captcha.passwordsWaiting(passwords.length)}</strong>
        </div>
      )}
      {passwords.map((c) => (
        <AnswerRow key={c.id} c={c} now={now} />
      ))}
      {images.length > 0 && (
        <div className="captcha-head">
          <strong>{t.captcha.waiting(images.length)}</strong>
          <span className="subtitle">{t.captcha.imageHint}</span>
        </div>
      )}
      {images.map((c) => (
        <AnswerRow key={c.id} c={c} now={now} />
      ))}
      {captchas.length > 0 && (
        <div className="captcha-head">
          <strong>{t.captcha.waiting(captchas.length)}</strong>
          <span className="subtitle">{t.captcha.hint}</span>
          <Link to="/einstellungen" hash="captchas" className="captcha-setup">
            {t.captcha.setup}
          </Link>
        </div>
      )}
      {captchas.map((c) => (
        <div className="captcha-row" key={c.id}>
          <span className="mono">{t.captcha.item(c.host, c.pluginName, Math.max(0, Math.ceil((c.expiresAt - now) / 60_000)))}</span>
          <div className="spacer" />
          <a className="btn small primary" href={captchaUrl(c, lang)} target="_blank" rel="noreferrer">
            {t.captcha.solve}
          </a>
          <button type="button" className="btn small" onClick={() => cancel.mutate(c.id)} disabled={cancel.isPending}>
            {t.captcha.cancel}
          </button>
        </div>
      ))}
    </div>
  );
}
