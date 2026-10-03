import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, post, type Settings } from '../api';
import { PageHeader, useSettings } from '../components/Layout';
import { IconLogout } from '../components/icons';
import { LANGS, setLang, useLang, type Lang } from '../i18n';
import * as m from '../paraglide/messages';

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
async function checkCnl(): Promise<CnlCheck> {
  // The extension answers Click'n'Load inside the page and sets `jdownloader` like jdcheck.js.
  if ((window as { jdownloader?: unknown }).jdownloader === true) return { ok: true, text: m.settings_cnlExtension() };
  try {
    const res = await fetch('http://127.0.0.1:9666/jdcheck.js', { cache: 'no-store' });
    const body = await res.text();
    if (!body.includes('jdownloader=true')) {
      return { ok: false, text: m.settings_cnlOther({ status: res.status }) };
    }
    const version = /version='([^']*)'/.exec(body)?.[1];
    return {
      ok: true,
      text: version === 'haul-cnl' ? m.settings_cnlForwarder() : m.settings_cnlLocal(),
    };
  } catch {
    return { ok: false, text: m.settings_cnlUnreachable() };
  }
}

function ApiToken({ isSet }: { isSet: boolean }) {
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
      <h2 id="cnl-title">{m.settings_cnlTitle()}</h2>
      <div className="card-sub">
        {m.settings_cnlIntroA()} <span className="mono">127.0.0.1:9666</span> {m.settings_cnlIntroB()}{' '}
        <span className="mono">haul-cnl</span> {m.settings_cnlIntroC()}
      </div>
      {token ? (
        <>
          <div className="notice info">{m.settings_tokenOnce()}</div>
          <div className="token">{token}</div>
          <pre className="code">{`haul-cnl --server ${server} --token ${token}`}</pre>
        </>
      ) : (
        <div className="subtitle" style={{ fontSize: 13 }}>
          {isSet ? m.settings_tokenSet() : m.settings_tokenNone()}
        </div>
      )}
      <pre className="code">{`${m.settings_sshComment()}\nssh -N -L 9666:localhost:9666 ${location.hostname}`}</pre>
      {check && (
        <div className={check.ok ? 'notice info' : 'notice'} role="status">
          {check.text}
        </div>
      )}
      <div className="toolbar">
        <button type="button" className="btn small" onClick={async () => setCheck(await checkCnl())}>
          {m.settings_cnlTest()}
        </button>
        <button type="button" className="btn small" onClick={() => rotate.mutate()} disabled={rotate.isPending}>
          {isSet ? m.settings_newToken() : m.settings_createToken()}
        </button>
      </div>
    </section>
  );
}

function Password() {
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
      <h2 id="pw-title">{m.settings_loginTitle()}</h2>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="pw-cur">{m.settings_currentPassword()}</label>
          <input id="pw-cur" className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="pw-new">{m.settings_newPassword()}</label>
          <input id="pw-new" className="input" type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required />
        </div>
      </div>
      {change.error && <div className="notice" role="alert">{change.error.message}</div>}
      {change.isSuccess && <div className="notice info">{m.settings_passwordChanged()}</div>}
      <div className="toolbar">
        <button type="submit" className="btn small">{m.settings_changePassword()}</button>
        <div className="spacer" />
        <button type="button" className="btn small" onClick={() => logout.mutate()}>
          <IconLogout size={16} />
          {m.settings_logout()}
        </button>
      </div>
    </form>
  );
}

function Captchas() {
  const [permission, setPermission] = useState(() => ('Notification' in window ? Notification.permission : 'denied'));
  return (
    <section className="card" id="captchas" aria-labelledby="captcha-title">
      <h2 id="captcha-title">{m.captcha_title()}</h2>
      <div className="card-sub">{m.captcha_intro()}</div>
      <ol className="steps">
        <li>{m.captcha_step1()}</li>
        <li>
          {m.captcha_step2()}{' '}
          <a href="/api/captcha/haul-captcha.user.js" target="_blank" rel="noreferrer">
            {m.captcha_install()}
          </a>
        </li>
        <li>{m.captcha_step3()}</li>
      </ol>
      <div className="toolbar">
        <span className="subtitle" style={{ fontSize: 13 }}>
          {m.captcha_notifications()}:{' '}
          {permission === 'granted' ? m.captcha_notificationsOn() : permission === 'denied' ? m.captcha_notificationsBlocked() : ''}
        </span>
        {permission === 'default' && (
          <button type="button" className="btn small" onClick={async () => setPermission(await Notification.requestPermission())}>
            {m.captcha_notificationsEnable()}
          </button>
        )}
      </div>
    </section>
  );
}

/** The archive password list; saved on its own, so the settings form never overwrites a
 *  password extraction just added (see db::ARCHIVE_PASSWORDS). */
function ArchivePasswords() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['settings', 'archive-passwords'],
    queryFn: () => api<{ passwords: string[] }>('/settings/archive-passwords'),
  });
  const [text, setText] = useState<string | null>(null);
  const saved = data?.passwords.join('\n') ?? '';
  const save = useMutation({
    mutationFn: (passwords: string[]) =>
      api<{ passwords: string[] }>('/settings/archive-passwords', { method: 'PUT', body: { passwords } }),
    onSuccess: (r) => {
      qc.setQueryData(['settings', 'archive-passwords'], r);
      setText(null);
    },
  });
  // Untouched, the field follows the server (a password found while extracting shows up).
  const value = text ?? saved;
  const count = value.split('\n').filter((l) => l.trim()).length;
  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate(value.split('\n'));
  }
  return (
    <form className="card" id="archive-passwords" onSubmit={submit} aria-labelledby="apw-title">
      <h2 id="apw-title">{m.settings_archivePasswords()}</h2>
      <div className="card-sub">{m.settings_archivePasswordsIntro()}</div>
      <div className="field">
        <label htmlFor="apw">{m.settings_archivePasswordsLabel()}</label>
        <textarea
          id="apw"
          className="textarea mono"
          style={{ minHeight: 96 }}
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      {save.error && <div className="notice" role="alert">{save.error.message}</div>}
      <div className="toolbar">
        <span className="subtitle" style={{ fontSize: 13 }}>
          {m.settings_archivePasswordsCount({ n: count })}
        </span>
        <div className="spacer" />
        {save.isSuccess && text === null && <span className="subtitle" style={{ fontSize: 13 }}>{m.settings_saved()}</span>}
        <button type="submit" className="btn primary small" disabled={save.isPending || text === null}>
          {m.common_save()}
        </button>
      </div>
    </form>
  );
}

function Language() {
  const lang = useLang();
  return (
    <section className="card" aria-labelledby="lang-title">
      <h2 id="lang-title">{m.settings_language()}</h2>
      <div className="field" style={{ maxWidth: 320 }}>
        <select id="lang" className="select" aria-labelledby="lang-title" value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
          {LANGS.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
        <span className="help">{m.settings_languageHelp()}</span>
      </div>
    </section>
  );
}

export function SettingsPage() {
  const { data } = useSettings();
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => {
    if (data && !s) setS(data);
  }, [data, s]);
  const save = useMutation({ mutationFn: (body: Settings) => api<Settings>('/settings', { method: 'PUT', body }), onSuccess: setS });

  if (!data || !s) return <PageHeader title={m.settings_title()} />;
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS({ ...s, [k]: v });
  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate(s!);
  }

  return (
    <>
      <PageHeader title={m.settings_title()} subtitle={`Haul ${data.version}`} />
      <div className="content">
        <form className="card" onSubmit={submit} aria-labelledby="dl-title">
          <h2 id="dl-title">{m.settings_downloads()}</h2>
          <div className="grid-4">
            <NumberField id="par" label={m.settings_parallel()} value={s.maxParallel} min={1} max={20} onChange={(v) => set('maxParallel', v)} />
            <NumberField id="conn" label={m.settings_connections()} value={s.connectionsPerFile} min={1} max={16} onChange={(v) => set('connectionsPerFile', v)} />
            <NumberField
              id="limit"
              label={m.settings_limit()}
              help={m.settings_limitHelp()}
              value={s.speedLimitKib}
              min={0}
              onChange={(v) => set('speedLimitKib', v)}
            />
            <NumberField id="retries" label={m.settings_retries()} value={s.maxRetries} min={0} max={50} onChange={(v) => set('maxRetries', v)} />
          </div>
          <div className="toolbar">
            <label className="checkbox">
              <input type="checkbox" checked={s.autoExtract} onChange={(e) => set('autoExtract', e.target.checked)} />
              {m.settings_autoExtract()}
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={s.deleteArchives} onChange={(e) => set('deleteArchives', e.target.checked)} />
              {m.settings_deleteArchives()}
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={s.removeArchiveDownloads}
                onChange={(e) => set('removeArchiveDownloads', e.target.checked)}
              />
              {m.settings_removeArchiveDownloads()}
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={s.askArchivePassword} onChange={(e) => set('askArchivePassword', e.target.checked)} />
              {m.settings_askArchivePassword()}
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={s.verifyChecksums} onChange={(e) => set('verifyChecksums', e.target.checked)} />
              {m.settings_verifyChecksums()}
            </label>
          </div>
          {save.error && <div className="notice" role="alert">{save.error.message}</div>}
          <div className="toolbar">
            <div className="spacer" />
            {save.isSuccess && <span className="subtitle" style={{ fontSize: 13 }}>{m.settings_saved()}</span>}
            <button type="submit" className="btn primary small" disabled={save.isPending}>
              {m.common_save()}
            </button>
          </div>
        </form>

        <section className="card" aria-labelledby="paths-title">
          <h2 id="paths-title">{m.settings_folders()}</h2>
          <div className="list">
            {[
              [m.settings_tmpDir(), data.tmpDir],
              [m.settings_doneDir(), data.doneDir],
              [m.settings_pluginDir(), data.pluginDir],
              [m.settings_extractors(), data.extractors.length ? data.extractors.join(', ') : m.settings_noExtractor()],
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

        <ArchivePasswords />
        <Language />
        <Captchas />
        <ApiToken isSet={data.apiTokenSet} />
        <Password />
      </div>
    </>
  );
}
