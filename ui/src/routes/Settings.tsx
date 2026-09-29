import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, post, type Settings } from '../api';
import { PageHeader, useSettings } from '../components/Layout';
import { IconLogout } from '../components/icons';

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
  try {
    const res = await fetch('http://127.0.0.1:9666/jdcheck.js', { cache: 'no-store' });
    const body = await res.text();
    if (!body.includes('jdownloader=true')) {
      return { ok: false, text: `Auf Port 9666 antwortet etwas anderes als Haul (HTTP ${res.status}).` };
    }
    const version = /version='([^']*)'/.exec(body)?.[1];
    return {
      ok: true,
      text:
        version === 'haul-cnl'
          ? 'Port 9666 erreichbar: haul-cnl läuft und leitet an den Server weiter.'
          : 'Port 9666 erreichbar: Haul selbst lauscht auf diesem Rechner.',
    };
  } catch {
    return {
      ok: false,
      text:
        'Port 9666 ist von diesem Browser aus nicht erreichbar. Läuft Haul auf einem anderen Rechner, ' +
        'auf diesem Rechner haul-cnl starten (oder den SSH-Tunnel). Fragt der Browser nach Zugriff aufs lokale Netzwerk, erlauben.',
    };
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
      <h2 id="cnl-title">Click'n'Load vom Desktop</h2>
      <div className="card-sub">
        Webseiten schicken Links an <span className="mono">127.0.0.1:9666</span> des Browser-Rechners. Dort leitet{' '}
        <span className="mono">haul-cnl</span> sie mit einem API-Token an diesen Server weiter. Empfangene Links landen im Linksammler.
      </div>
      {token ? (
        <>
          <div className="notice info">Token nur jetzt sichtbar. Kopieren und in haul-cnl eintragen:</div>
          <div className="token">{token}</div>
          <pre className="code">{`haul-cnl --server ${server} --token ${token}`}</pre>
        </>
      ) : (
        <div className="subtitle" style={{ fontSize: 13 }}>
          {isSet ? 'Ein Token ist gesetzt. Ein neues ersetzt das alte.' : 'Noch kein Token erstellt.'}
        </div>
      )}
      <pre className="code">{`# Zum Testen ohne haul-cnl:\nssh -N -L 9666:localhost:9666 ${location.hostname}`}</pre>
      {check && (
        <div className={check.ok ? 'notice info' : 'notice'} role="status">
          {check.text}
        </div>
      )}
      <div className="toolbar">
        <button type="button" className="btn small" onClick={async () => setCheck(await checkCnl())}>
          Click'n'Load im Browser testen
        </button>
        <button type="button" className="btn small" onClick={() => rotate.mutate()} disabled={rotate.isPending}>
          {isSet ? 'Neues Token erstellen' : 'Token erstellen'}
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
      <h2 id="pw-title">Zugang</h2>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="pw-cur">Aktuelles Passwort</label>
          <input id="pw-cur" className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="pw-new">Neues Passwort</label>
          <input id="pw-new" className="input" type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required />
        </div>
      </div>
      {change.error && <div className="notice" role="alert">{change.error.message}</div>}
      {change.isSuccess && <div className="notice info">Passwort geändert.</div>}
      <div className="toolbar">
        <button type="submit" className="btn small">Passwort ändern</button>
        <div className="spacer" />
        <button type="button" className="btn small" onClick={() => logout.mutate()}>
          <IconLogout size={16} />
          Abmelden
        </button>
      </div>
    </form>
  );
}

export function SettingsPage() {
  const { data } = useSettings();
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => {
    if (data && !s) setS(data);
  }, [data, s]);
  const save = useMutation({ mutationFn: (body: Settings) => api<Settings>('/settings', { method: 'PUT', body }), onSuccess: setS });

  if (!data || !s) return <PageHeader title="Einstellungen" />;
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS({ ...s, [k]: v });
  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate(s!);
  }

  return (
    <>
      <PageHeader title="Einstellungen" subtitle={`Haul ${data.version}`} />
      <div className="content">
        <form className="card" onSubmit={submit} aria-labelledby="dl-title">
          <h2 id="dl-title">Downloads</h2>
          <div className="grid-4">
            <NumberField id="par" label="Parallele Downloads" value={s.maxParallel} min={1} max={20} onChange={(v) => set('maxParallel', v)} />
            <NumberField id="conn" label="Verbindungen pro Datei" value={s.connectionsPerFile} min={1} max={16} onChange={(v) => set('connectionsPerFile', v)} />
            <NumberField
              id="limit"
              label="Bandbreitenlimit (KiB/s)"
              help="0 = kein Limit"
              value={s.speedLimitKib}
              min={0}
              onChange={(v) => set('speedLimitKib', v)}
            />
            <NumberField id="retries" label="Wiederholungen" value={s.maxRetries} min={0} max={50} onChange={(v) => set('maxRetries', v)} />
          </div>
          <div className="toolbar">
            <label className="checkbox">
              <input type="checkbox" checked={s.autoExtract} onChange={(e) => set('autoExtract', e.target.checked)} />
              Fertige Pakete automatisch entpacken
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={s.deleteArchives} onChange={(e) => set('deleteArchives', e.target.checked)} />
              Archive nach erfolgreichem Entpacken löschen
            </label>
          </div>
          {save.error && <div className="notice" role="alert">{save.error.message}</div>}
          <div className="toolbar">
            <div className="spacer" />
            {save.isSuccess && <span className="subtitle" style={{ fontSize: 13 }}>Gespeichert.</span>}
            <button type="submit" className="btn primary small" disabled={save.isPending}>
              Speichern
            </button>
          </div>
        </form>

        <section className="card" aria-labelledby="paths-title">
          <h2 id="paths-title">Ordner</h2>
          <div className="list">
            {[
              ['Laufende Downloads', data.tmpDir],
              ['Fertige Dateien', data.doneDir],
              ['Eigene Plugins', data.pluginDir],
              ['Entpacker', data.extractors.length ? data.extractors.join(', ') : 'keiner gefunden: sudo apt install 7zip 7zip-rar'],
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

        <ApiToken isSet={data.apiTokenSet} />
        <Password />
      </div>
    </>
  );
}
