import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { api, type Package, type SettingsView, type Stats } from '../api';
import { useLive } from '../live';
import { bytes } from '../format';
import { IconDownload, IconFolder, IconKey, IconLink, IconSliders, Logo } from './icons';

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
    <div className="storage" aria-label="Speicherplatz">
      <div className="storage-title">Speicher</div>
      {data.storage.map((s, i) => {
        const used = s.total - s.free;
        const pct = s.total ? Math.round((used / s.total) * 100) : 0;
        return (
          <div className="storage-row" key={s.label} title={s.path}>
            <div className="line">
              <span>{s.label}</span>
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
        <nav className="nav" aria-label="Hauptnavigation">
          <Link to="/" activeOptions={{ exact: true }} activeProps={{ className: 'active' }}>
            <IconDownload />
            <span className="label">Downloads</span>
            {queueCount > 0 && <span className="count">{queueCount}</span>}
          </Link>
          <Link to="/linksammler" activeProps={{ className: 'active' }}>
            <IconLink />
            <span className="label">Linksammler</span>
            {collectorCount > 0 && <span className="count">{collectorCount}</span>}
          </Link>
          <Link to="/fertig" search={{ path: '' }} activeProps={{ className: 'active' }}>
            <IconFolder />
            <span className="label">Fertig</span>
          </Link>
          <Link to="/accounts" activeProps={{ className: 'active' }}>
            <IconKey />
            <span className="label">Accounts &amp; Plugins</span>
          </Link>
          <Link to="/einstellungen" activeProps={{ className: 'active' }}>
            <IconSliders />
            <span className="label">Einstellungen</span>
          </Link>
        </nav>
        <StorageBox />
        <div className="conn" role="status">
          <span className="dot" style={{ background: live.connected ? 'var(--ok)' : 'var(--err)' }} />
          <span className="mono">{live.connected ? `${location.hostname} verbunden` : 'Verbindung getrennt'}</span>
        </div>
      </aside>
      <main className="main">{children}</main>
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
