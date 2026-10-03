import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { api, type Package, type SettingsView, type Stats } from '../api';
import { useLive } from '../live';
import { bytes } from '../format';
import { LANGS, setLang, useLang, type Lang, pickMsg } from '../i18n';
import { CaptchaBanner } from './Captchas';
import { IconDownload, IconFolder, IconKey, IconLink, IconSliders, Logo } from './icons';
import * as m from '../paraglide/messages';
import { msgGroup } from '../msg-groups';

export function useStats() {
  return useQuery({ queryKey: ['stats'], queryFn: () => api<Stats>('/stats'), refetchInterval: 30_000 });
}

export function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: () => api<SettingsView>('/settings') });
}

export function usePackages(view: 'queue' | 'collector') {
  return useQuery({ queryKey: ['packages', view], queryFn: () => api<Package[]>(`/packages?view=${view}`) });
}

function StorageBox() {
  const { data } = useStats();
  if (!data?.storage.length) return null;
  return (
    <div className="storage" aria-label={m.nav_storageAria()}>
      <div className="storage-title">{m.nav_storage()}</div>
      {data.storage.map((s, i) => {
        const used = s.total - s.free;
        const pct = s.total ? Math.round((used / s.total) * 100) : 0;
        return (
          <div className="storage-row" key={s.label} title={s.path}>
            <div className="line">
              <span>{pickMsg(msgGroup.disks, s.label) ?? s.label}</span>
              <span>
                {bytes(used)} / {bytes(s.total)}
              </span>
            </div>
            <div className="bar">
              <div style={{ width: `${pct}%`, background: i === 0 ? 'var(--accent)' : '#7a8494' }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** DE | EN switch; also on the login page. */
export function LanguageSwitch() {
  const lang = useLang();
  return (
    <div className="lang-switch" role="group" aria-label={m.nav_language()}>
      {LANGS.map((l) => (
        <button
          key={l.id}
          type="button"
          className={lang === l.id ? 'on' : undefined}
          aria-pressed={lang === l.id}
          title={l.label}
          onClick={() => setLang(l.id as Lang)}
        >
          {l.id.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const live = useLive();
  const queue = usePackages('queue');
  const collector = usePackages('collector');
  const settings = useSettings();
  const queueCount = queue.data?.reduce((n, p) => n + p.downloads.filter((d) => d.status !== 'finished').length, 0) ?? 0;
  const collectorCount = collector.data?.reduce((n, p) => n + p.downloads.length, 0) ?? 0;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <Logo />
          <div className="brand-name">Haul</div>
          <div className="brand-version mono">v{settings.data?.version ?? '…'}</div>
        </div>
        <nav className="nav" aria-label={m.nav_main()}>
          <Link to="/" activeOptions={{ exact: true }} activeProps={{ className: 'active' }}>
            <IconDownload />
            <span className="label">{m.nav_downloads()}</span>
            {queueCount > 0 && <span className="count">{queueCount}</span>}
          </Link>
          <Link to="/linksammler" activeProps={{ className: 'active' }}>
            <IconLink />
            <span className="label">{m.nav_collector()}</span>
            {collectorCount > 0 && <span className="count">{collectorCount}</span>}
          </Link>
          <Link to="/fertig" search={{ path: '' }} activeProps={{ className: 'active' }}>
            <IconFolder />
            <span className="label">{m.nav_done()}</span>
          </Link>
          <Link to="/accounts" activeProps={{ className: 'active' }}>
            <IconKey />
            <span className="label">{m.nav_accounts()}</span>
          </Link>
          <Link to="/einstellungen" activeProps={{ className: 'active' }}>
            <IconSliders />
            <span className="label">{m.nav_settings()}</span>
          </Link>
        </nav>
        <StorageBox />
        <div className="conn" role="status">
          <span className="dot" style={{ background: live.connected ? 'var(--ok)' : 'var(--err)' }} />
          <span className="mono">{live.connected ? m.nav_connected({ host: location.hostname }) : m.nav_disconnected()}</span>
          <LanguageSwitch />
        </div>
      </aside>
      <main className="main">
        <CaptchaBanner />
        {children}
      </main>
    </div>
  );
}

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-header">
      <div className="titles">
        <h1>{title}</h1>
        {subtitle && <div className="subtitle">{subtitle}</div>}
      </div>
      {children}
    </header>
  );
}
