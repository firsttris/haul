import { useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, post, type Account, type PluginList } from '../api';
import { PageHeader } from '../components/Layout';
import { IconRefresh, IconTrash } from '../components/icons';
import { bytes, date } from '../format';

const statusText: Record<Account['status'], { label: string; color: string }> = {
  unchecked: { label: 'Ungeprüft', color: 'var(--muted-2)' },
  checking: { label: 'Prüfe …', color: 'var(--accent)' },
  valid: { label: 'Gültig', color: 'var(--ok)' },
  invalid: { label: 'Ungültig', color: 'var(--err)' },
  error: { label: 'Fehler', color: 'var(--err)' },
};

function AddAccount({ plugins }: { plugins: PluginList['plugins'] }) {
  const withAccounts = plugins.filter((p) => p.accountRequired || p.hasCheckAccount);
  const [pluginId, setPluginId] = useState('');
  const [user, setUser] = useState('');
  const [secret, setSecret] = useState('');
  const add = useMutation({
    mutationFn: () => post('/accounts', { pluginId: pluginId || withAccounts[0]?.id, user, secret }),
    onSuccess: () => {
      setUser('');
      setSecret('');
    },
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    add.mutate();
  }
  if (withAccounts.length === 0) return null;
  return (
    <form className="card" onSubmit={submit}>
      <h2>Account hinzufügen</h2>
      <div className="card-sub">
        Benutzer und Passwort für den Web-Login, oder Benutzer leer lassen und den API-Key als Passwort eintragen.
        Gespeichert wird verschlüsselt mit <span className="mono">APP_SECRET</span>.
      </div>
      <div className="grid-4" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr)) auto', alignItems: 'end' }}>
        <div className="field">
          <label htmlFor="acc-plugin">Hoster</label>
          <select id="acc-plugin" className="select" value={pluginId || withAccounts[0]?.id} onChange={(e) => setPluginId(e.target.value)}>
            {withAccounts.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="acc-user">Benutzer</label>
          <input id="acc-user" className="input" autoComplete="off" placeholder="leer = API-Key" value={user} onChange={(e) => setUser(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="acc-secret">Passwort oder API-Key</label>
          <input id="acc-secret" className="input" type="password" autoComplete="new-password" value={secret} onChange={(e) => setSecret(e.target.value)} required />
        </div>
        <button type="submit" className="btn primary" disabled={add.isPending}>
          Hinzufügen
        </button>
      </div>
      {add.error && <div className="notice" role="alert">{add.error.message}</div>}
    </form>
  );
}

export function AccountsPage() {
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api<Account[]>('/accounts') });
  const plugins = useQuery({ queryKey: ['plugins'], queryFn: () => api<PluginList>('/plugins') });
  const act = useMutation({ mutationFn: ({ path, method, body }: { path: string; method?: string; body?: unknown }) => api(path, { method: method ?? 'POST', body }) });
  const reload = useMutation({ mutationFn: () => post<PluginList>('/plugins/reload') });

  return (
    <>
      <PageHeader title="Accounts & Plugins" subtitle="Premium-Accounts für Hoster und die geladenen Hoster-Plugins" />
      <div className="content">
        <AddAccount plugins={plugins.data?.plugins ?? []} />

        <section className="card" aria-labelledby="acc-title">
          <h2 id="acc-title">Accounts</h2>
          {accounts.data?.length === 0 && <div className="subtitle">Noch keine Accounts.</div>}
          <div className="list">
            {accounts.data?.map((a) => {
              const s = statusText[a.status];
              return (
                <div className="list-row" key={a.id}>
                  <div className="grow">
                    <span className="title">
                      {a.pluginName ?? a.pluginId} · {a.user || 'API-Key'}
                    </span>
                    <span className="sub">
                      {a.premium === true ? 'Premium' : a.premium === false ? 'Kein Premium' : 'Typ unbekannt'}
                      {a.validUntil ? ` bis ${date(a.validUntil)}` : ''}
                      {a.trafficLeft !== null ? ` · ${bytes(a.trafficLeft)} Traffic übrig` : ''}
                      {a.checkedAt ? ` · geprüft ${new Date(a.checkedAt).toLocaleString('de-DE')}` : ''}
                    </span>
                    {a.error && <span className="sub" style={{ color: 'var(--err)' }}>{a.error}</span>}
                  </div>
                  <div className="status" style={{ color: s.color }}>
                    <span className="dot" style={{ background: s.color }} />
                    <span>{s.label}</span>
                  </div>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={a.enabled}
                      onChange={(e) => act.mutate({ path: `/accounts/${a.id}`, method: 'PATCH', body: { enabled: e.target.checked } })}
                    />
                    Aktiv
                  </label>
                  <button type="button" className="icon-btn" aria-label="Account prüfen" title="Prüfen" onClick={() => act.mutate({ path: `/accounts/${a.id}/check` })}>
                    <IconRefresh size={16} />
                  </button>
                  <button type="button" className="icon-btn" aria-label="Account löschen" onClick={() => act.mutate({ path: `/accounts/${a.id}`, method: 'DELETE' })}>
                    <IconTrash size={16} />
                  </button>
                </div>
              );
            })}
          </div>
          {act.error && <div className="notice" role="alert">{act.error.message}</div>}
        </section>

        <section className="card" aria-labelledby="plugins-title">
          <div className="toolbar">
            <h2 id="plugins-title">Plugins</h2>
            <div className="spacer" />
            <button type="button" className="btn small" onClick={() => reload.mutate()} disabled={reload.isPending}>
              <IconRefresh size={16} />
              Neu laden
            </button>
          </div>
          <div className="list">
            {plugins.data?.plugins.map((p) => (
              <div className="list-row" key={p.id}>
                <div className="grow">
                  <span className="title">
                    {p.name} <span className="pill">v{p.version}</span>
                  </span>
                  <span className="sub mono">{p.matches.map((m) => `/${m.source}/${m.flags}`).join('  ')}</span>
                  <span className="sub mono">{p.file}</span>
                </div>
                <span className="pill">{p.builtin ? 'mitgeliefert' : 'eigenes'}</span>
                <span className="subtitle" style={{ fontSize: 13 }}>
                  {p.accountRequired ? 'Premium nötig' : 'ohne Account'}
                </span>
              </div>
            ))}
            {plugins.data?.plugins.length === 0 && <div className="subtitle">Keine Plugins geladen.</div>}
          </div>
          {plugins.data?.errors.map((e) => (
            <div className="notice" key={e.file}>
              <span className="mono">{e.file}</span>: {e.error}
            </div>
          ))}
        </section>
      </div>
    </>
  );
}
