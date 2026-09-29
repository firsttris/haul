import { useEffect, useRef, useState } from 'react';
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

/** Notice on every page while captchas wait; also in the tab title and as a notification. */
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
          new Notification('Haul', { body: t.captcha.notify(c.host), tag: `haul-captcha-${c.id}` });
        }
      } catch {
        /* notifications unavailable */
      }
    }
  }, [data, t]);

  if (!data.length) return null;
  return (
    <div className="captcha-banner" role="alert">
      <div className="captcha-head">
        <strong>{t.captcha.waiting(data.length)}</strong>
        <span className="subtitle">{t.captcha.hint}</span>
        <Link to="/einstellungen" hash="captchas" className="captcha-setup">
          {t.captcha.setup}
        </Link>
      </div>
      {data.map((c) => (
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
