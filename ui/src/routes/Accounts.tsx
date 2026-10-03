import { useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, post, type Account, type PluginList } from '../api';
import { PageHeader } from '../components/Layout';
import { IconRefresh, IconTrash } from '../components/icons';
import { bytes, date, dateTime } from '../format';
import { localize, pluginText, useLang, pickMsg } from '../i18n';
import * as m from '../paraglide/messages';
import { msgGroup } from '../msg-groups';

const statusColor: Record<Account['status'], string> = {
  unchecked: 'var(--muted-2)',
  checking: 'var(--accent)',
  valid: 'var(--ok)',
  invalid: 'var(--err)',
  error: 'var(--err)',
};

function AddAccount({ plugins }: { plugins: PluginList['plugins'] }) {
  const lang = useLang();
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
  const selected = withAccounts.find((p) => p.id === pluginId) ?? withAccounts[0];
  const form = selected.account ?? {};
  return (
    <form className="card" onSubmit={submit}>
      <h2>{m.accounts_add()}</h2>
      <div className="card-sub">
        {pluginText(form.help, lang) ?? m.accounts_defaultHelp()} {m.accounts_encrypted()}{' '}
        <span className="mono">APP_SECRET</span>.
      </div>
      <div className="grid-4" style={{ gridTemplateColumns: `repeat(${form.secretMultiline ? 2 : 3}, minmax(0, 1fr)) auto`, alignItems: 'end' }}>
        <div className="field">
          <label htmlFor="acc-plugin">{m.accounts_hoster()}</label>
          <select id="acc-plugin" className="select" value={pluginId || withAccounts[0]?.id} onChange={(e) => setPluginId(e.target.value)}>
            {withAccounts.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="acc-user">{pluginText(form.userLabel, lang) ?? m.common_user()}</label>
          <input id="acc-user" className="input" autoComplete="off" value={user} onChange={(e) => setUser(e.target.value)} />
        </div>
        {!form.secretMultiline && (
          <div className="field">
            <label htmlFor="acc-secret">{pluginText(form.secretLabel, lang) ?? m.common_password()}</label>
            <input id="acc-secret" className="input" type="password" autoComplete="new-password" value={secret} onChange={(e) => setSecret(e.target.value)} required />
          </div>
        )}
        <button type="submit" className="btn primary" disabled={add.isPending}>
          {m.common_add()}
        </button>
      </div>
      {form.secretMultiline && (
        <div className="field">
          <label htmlFor="acc-secret">{pluginText(form.secretLabel, lang) ?? m.common_password()}</label>
          <textarea
            id="acc-secret"
            className="textarea mono secret-area"
            placeholder="…"
            autoComplete="off"
            spellCheck={false}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            required
          />
        </div>
      )}
      {add.error && <div className="notice" role="alert">{add.error.message}</div>}
    </form>
  );
}

function EditSecret({ account, label, multiline, onDone }: { account: Account; label: string; multiline?: boolean; onDone: () => void }) {
  const [secret, setSecret] = useState('');
  const save = useMutation({
    mutationFn: () => api(`/accounts/${account.id}`, { method: 'PATCH', body: { secret } }),
    onSuccess: onDone,
  });
  return (
    <form
      className="toolbar"
      style={{ width: '100%' }}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <label htmlFor={`secret-${account.id}`} className="subtitle" style={{ fontSize: 13 }}>
        {m.accounts_newSecret({ label })}
      </label>
      {multiline ? (
        <textarea
          id={`secret-${account.id}`}
          className="textarea mono secret-area"
            placeholder="…"
          style={{ flex: '1 1 100%' }}
          autoComplete="off"
          spellCheck={false}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          required
        />
      ) : (
        <input
          id={`secret-${account.id}`}
          className="input"
          style={{ flex: 1, minWidth: 200 }}
          type="password"
          autoComplete="new-password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          required
        />
      )}
      <button type="submit" className="btn small primary" disabled={save.isPending}>
        {m.accounts_saveAndCheck()}
      </button>
      <button type="button" className="btn small" onClick={onDone}>
        {m.common_cancel()}
      </button>
      {save.error && <div className="notice" role="alert">{save.error.message}</div>}
    </form>
  );
}

export function AccountsPage() {
  const lang = useLang();
  const [editing, setEditing] = useState<number | null>(null);
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api<Account[]>('/accounts') });
  const plugins = useQuery({ queryKey: ['plugins'], queryFn: () => api<PluginList>('/plugins') });
  const act = useMutation({ mutationFn: ({ path, method, body }: { path: string; method?: string; body?: unknown }) => api(path, { method: method ?? 'POST', body }) });
  const reload = useMutation({ mutationFn: () => post<PluginList>('/plugins/reload') });

  return (
    <>
      <PageHeader title={m.accounts_title()} subtitle={m.accounts_subtitle()} />
      <div className="content">
        <AddAccount plugins={plugins.data?.plugins ?? []} />

        <section className="card" aria-labelledby="acc-title">
          <h2 id="acc-title">{m.accounts_list()}</h2>
          {accounts.data?.length === 0 && <div className="subtitle">{m.accounts_none()}</div>}
          <div className="list">
            {accounts.data?.map((a) => {
              const s = { label: pickMsg(msgGroup.accounts_status, a.status), color: statusColor[a.status] };
              return (
                <div className="list-row" key={a.id}>
                  <div className="grow">
                    <span className="title">
                      {a.pluginName ?? a.pluginId} · {a.user || m.accounts_sessionCookie()}
                    </span>
                    <span className="sub">
                      {a.premium === true ? m.accounts_premium() : a.premium === false ? m.accounts_noPremium() : m.accounts_typeUnknown()}
                      {a.validUntil ? m.accounts_until({ date: date(a.validUntil) }) : ''}
                      {a.trafficLeft !== null ? m.accounts_trafficLeft({ amount: bytes(a.trafficLeft) }) : ''}
                      {a.checkedAt ? m.accounts_checked({ when: dateTime(a.checkedAt) }) : ''}
                    </span>
                    {a.error && <span className="sub" style={{ color: 'var(--err)' }}>{localize(a.error)}</span>}
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
                    {m.accounts_enabled()}
                  </label>
                  <button type="button" className="btn small" onClick={() => setEditing(editing === a.id ? null : a.id)}>
                    {m.accounts_changeLogin()}
                  </button>
                  <button type="button" className="icon-btn" aria-label={m.accounts_checkAria()} title={m.accounts_check()} onClick={() => act.mutate({ path: `/accounts/${a.id}/check` })}>
                    <IconRefresh size={16} />
                  </button>
                  <button type="button" className="icon-btn" aria-label={m.accounts_deleteAria()} onClick={() => act.mutate({ path: `/accounts/${a.id}`, method: 'DELETE' })}>
                    <IconTrash size={16} />
                  </button>
                  {editing === a.id && (
                    <EditSecret
                      account={a}
                      label={pluginText(plugins.data?.plugins.find((p) => p.id === a.pluginId)?.account?.secretLabel, lang) ?? m.common_password()}
                      multiline={plugins.data?.plugins.find((p) => p.id === a.pluginId)?.account?.secretMultiline}
                      onDone={() => setEditing(null)}
                    />
                  )}
                </div>
              );
            })}
          </div>
          {act.error && <div className="notice" role="alert">{act.error.message}</div>}
        </section>

        <section className="card" aria-labelledby="plugins-title">
          <div className="toolbar">
            <h2 id="plugins-title">{m.accounts_plugins()}</h2>
            <div className="spacer" />
            <button type="button" className="btn small" onClick={() => reload.mutate()} disabled={reload.isPending}>
              <IconRefresh size={16} />
              {m.accounts_reload()}
            </button>
          </div>
          <div className="list">
            {plugins.data?.plugins.map((p) => (
              <div className="list-row plugin-row" key={p.id}>
                <div className="grow">
                  <span className="title">
                    {p.name} <span className="pill">v{p.version}</span>
                  </span>
                  {p.domains && p.domains.length > 0 && <span className="sub wrap-any">{m.accounts_supports({ domains: p.domains.join(', ') })}</span>}
                  <span className="sub mono wrap-any">{p.file}</span>
                  {p.replaces && (
                    <span className="sub" style={{ color: p.replaces.newer ? 'var(--err)' : undefined }} role={p.replaces.newer ? 'alert' : undefined}>
                      {p.replaces.newer ? m.accounts_replacesNewer({ builtin: p.replaces.version, own: p.version }) : m.accounts_replaces({ builtin: p.replaces.version })}
                    </span>
                  )}
                  <details className="patterns">
                    <summary>{m.accounts_patterns({ n: p.matches.length })}</summary>
                    <ul>
                      {p.matches.map((re) => (
                        <li key={re.source} className="mono wrap-any">{`/${re.source}/${re.flags}`}</li>
                      ))}
                    </ul>
                  </details>
                </div>
                <div className="plugin-meta">
                  <span className="pill">{p.builtin ? m.accounts_builtin() : m.accounts_custom()}</span>
                  <span className="subtitle" style={{ fontSize: 13 }}>
                    {p.accountRequired
                      ? m.accounts_premiumRequired()
                      : p.hasCheckAccount
                        ? `${m.accounts_noAccountNeeded()} · ${m.accounts_accountPossible()}`
                        : m.accounts_noAccountNeeded()}
                  </span>
                </div>
              </div>
            ))}
            {plugins.data?.plugins.length === 0 && <div className="subtitle">{m.accounts_noPlugins()}</div>}
          </div>
          {plugins.data?.errors.map((e) => (
            <div className="notice" key={e.file}>
              <span className="mono">{e.file}</span>: {localize(e.error)}
            </div>
          ))}
        </section>
      </div>
    </>
  );
}
