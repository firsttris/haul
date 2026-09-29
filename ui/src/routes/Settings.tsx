import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, post, type Settings } from '../api';
import { PageHeader, useSettings } from '../components/Layout';
import { IconLogout } from '../components/icons';
import { LANGS, setLang, useLang, useT, type Lang, type Messages } from '../i18n';

function NumberField({
  id,
  label,
  help,
  value,
  min,
  max,
  onChange,
}: {
  id: string;
  label: string;
  help?: string;
  value: number;
  min: number;
  max?: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} className="input mono" type="number" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      {help && <span className="help">{help}</span>}
    </div>
  );
}

type CnlCheck = { ok: boolean; text: string } | null;

/** Checks from *this* browser whether something answers on 127.0.0.1:9666, like a web page would. */
async function checkCnl(t: Messages): Promise<CnlCheck> {
  try {
    const res = await fetch('http://127.0.0.1:9666/jdcheck.js', { cache: 'no-store' });
    const body = await res.text();
    if (!body.includes('jdownloader=true')) {
      return { ok: false, text: t.settings.cnlOther(res.status) };
    }
    const version = /version='([^']*)'/.exec(body)?.[1];
    return {
      ok: true,
      text: version === 'haul-cnl' ? t.settings.cnlForwarder : t.settings.cnlLocal,
    };
  } catch {
    return { ok: false, text: t.settings.cnlUnreachable };
  }
}

function ApiToken({ isSet }: { isSet: boolean }) {
  const t = useT();
  const [check, setCheck] = useState<CnlCheck>(null);
  const [token, setToken] = useState<string | null>(null);
  const qc = useQueryClient();
  const rotate = useMutation({
    mutationFn: () => post<{ token: string }>('/settings/api-token'),
    onSuccess: (r) => {
      setToken(r.token);
      qc.invalidateQueries({ queryKey: ['settings'] });
    },
  });
  const server = location.origin;
  return (
    <section className="card" aria-labelledby="cnl-title">
      <h2 id="cnl-title">{t.settings.cnlTitle}</h2>
      <div className="card-sub">
        {t.settings.cnlIntroA} <span className="mono">127.0.0.1:9666</span> {t.settings.cnlIntroB}{' '}
        <span className="mono">haul-cnl</span> {t.settings.cnlIntroC}
      </div>
      {token ? (
        <>
          <div className="notice info">{t.settings.tokenOnce}</div>
          <div className="token">{token}</div>
          <pre className="code">{`haul-cnl --server ${server} --token ${token}`}</pre>
        </>
      ) : (
        <div className="subtitle" style={{ fontSize: 13 }}>
          {isSet ? t.settings.tokenSet : t.settings.tokenNone}
        </div>
      )}
      <pre className="code">{`${t.settings.sshComment}\nssh -N -L 9666:localhost:9666 ${location.hostname}`}</pre>
      {check && (
        <div className={check.ok ? 'notice info' : 'notice'} role="status">
          {check.text}
        </div>
      )}
      <div className="toolbar">
        <button type="button" className="btn small" onClick={async () => setCheck(await checkCnl(t))}>
          {t.settings.cnlTest}
        </button>
        <button type="button" className="btn small" onClick={() => rotate.mutate()} disabled={rotate.isPending}>
          {isSet ? t.settings.newToken : t.settings.createToken}
        </button>
      </div>
    </section>
  );
}

function Password() {
  const t = useT();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const change = useMutation({
    mutationFn: () => post('/auth/password', { current, new: next }),
    onSuccess: () => {
      setCurrent('');
      setNext('');
    },
  });
  const qc = useQueryClient();
  const logout = useMutation({ mutationFn: () => post('/auth/logout'), onSuccess: () => qc.invalidateQueries() });
  function submit(e: FormEvent) {
    e.preventDefault();
    change.mutate();
  }
  return (
    <form className="card" onSubmit={submit} aria-labelledby="pw-title">
      <h2 id="pw-title">{t.settings.loginTitle}</h2>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="pw-cur">{t.settings.currentPassword}</label>
          <input id="pw-cur" className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="pw-new">{t.settings.newPassword}</label>
          <input id="pw-new" className="input" type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required />
        </div>
      </div>
      {change.error && <div className="notice" role="alert">{change.error.message}</div>}
      {change.isSuccess && <div className="notice info">{t.settings.passwordChanged}</div>}
      <div className="toolbar">
        <button type="submit" className="btn small">{t.settings.changePassword}</button>
        <div className="spacer" />
        <button type="button" className="btn small" onClick={() => logout.mutate()}>
          <IconLogout size={16} />
          {t.settings.logout}
        </button>
      </div>
    </form>
  );
}

function Captchas() {
  const t = useT();
  const [permission, setPermission] = useState(() => ('Notification' in window ? Notification.permission : 'denied'));
  return (
    <section className="card" id="captchas" aria-labelledby="captcha-title">
      <h2 id="captcha-title">{t.captcha.title}</h2>
      <div className="card-sub">{t.captcha.intro}</div>
      <ol className="steps">
        <li>{t.captcha.step1}</li>
        <li>
          {t.captcha.step2}{' '}
          <a href="/api/captcha/haul-captcha.user.js" target="_blank" rel="noreferrer">
            {t.captcha.install}
          </a>
        </li>
        <li>{t.captcha.step3}</li>
      </ol>
      <div className="toolbar">
        <span className="subtitle" style={{ fontSize: 13 }}>
          {t.captcha.notifications}:{' '}
          {permission === 'granted' ? t.captcha.notificationsOn : permission === 'denied' ? t.captcha.notificationsBlocked : ''}
        </span>
        {permission === 'default' && (
          <button type="button" className="btn small" onClick={async () => setPermission(await Notification.requestPermission())}>
            {t.captcha.notificationsEnable}
          </button>
        )}
      </div>
    </section>
  );
}

function Language() {
  const t = useT();
  const lang = useLang();
  return (
    <section className="card" aria-labelledby="lang-title">
      <h2 id="lang-title">{t.settings.language}</h2>
      <div className="field" style={{ maxWidth: 320 }}>
        <select id="lang" className="select" aria-labelledby="lang-title" value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
          {LANGS.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
        <span className="help">{t.settings.languageHelp}</span>
      </div>
    </section>
  );
}

export function SettingsPage() {
  const t = useT();
  const { data } = useSettings();
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => {
    if (data && !s) setS(data);
  }, [data, s]);
  const save = useMutation({ mutationFn: (body: Settings) => api<Settings>('/settings', { method: 'PUT', body }), onSuccess: setS });

  if (!data || !s) return <PageHeader title={t.settings.title} />;
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS({ ...s, [k]: v });
  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate(s!);
  }

  return (
    <>
      <PageHeader title={t.settings.title} subtitle={`Haul ${data.version}`} />
      <div className="content">
        <form className="card" onSubmit={submit} aria-labelledby="dl-title">
          <h2 id="dl-title">{t.settings.downloads}</h2>
          <div className="grid-4">
            <NumberField id="par" label={t.settings.parallel} value={s.maxParallel} min={1} max={20} onChange={(v) => set('maxParallel', v)} />
            <NumberField id="conn" label={t.settings.connections} value={s.connectionsPerFile} min={1} max={16} onChange={(v) => set('connectionsPerFile', v)} />
            <NumberField
              id="limit"
              label={t.settings.limit}
              help={t.settings.limitHelp}
              value={s.speedLimitKib}
              min={0}
              onChange={(v) => set('speedLimitKib', v)}
            />
            <NumberField id="retries" label={t.settings.retries} value={s.maxRetries} min={0} max={50} onChange={(v) => set('maxRetries', v)} />
          </div>
          <div className="toolbar">
            <label className="checkbox">
              <input type="checkbox" checked={s.autoExtract} onChange={(e) => set('autoExtract', e.target.checked)} />
              {t.settings.autoExtract}
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={s.deleteArchives} onChange={(e) => set('deleteArchives', e.target.checked)} />
              {t.settings.deleteArchives}
            </label>
          </div>
          {save.error && <div className="notice" role="alert">{save.error.message}</div>}
          <div className="toolbar">
            <div className="spacer" />
            {save.isSuccess && <span className="subtitle" style={{ fontSize: 13 }}>{t.settings.saved}</span>}
            <button type="submit" className="btn primary small" disabled={save.isPending}>
              {t.common.save}
            </button>
          </div>
        </form>

        <section className="card" aria-labelledby="paths-title">
          <h2 id="paths-title">{t.settings.folders}</h2>
          <div className="list">
            {[
              [t.settings.tmpDir, data.tmpDir],
              [t.settings.doneDir, data.doneDir],
              [t.settings.pluginDir, data.pluginDir],
              [t.settings.extractors, data.extractors.length ? data.extractors.join(', ') : t.settings.noExtractor],
            ].map(([k, v]) => (
              <div className="list-row" key={k}>
                <div className="grow">
                  <span className="title">{k}</span>
                </div>
                <span className="mono cell-mono">{v}</span>
              </div>
            ))}
          </div>
        </section>

        <Language />
        <Captchas />
        <ApiToken isSet={data.apiTokenSet} />
        <Password />
      </div>
    </>
  );
}
