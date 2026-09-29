import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  useReactTable,
  type ExpandedState,
} from '@tanstack/react-table';
import { post, api, type Download, type Package } from '../api';
import { PageHeader, usePackages, useSettings, useStats } from '../components/Layout';
import { IconArchive, IconChevron, IconFolder, IconPause, IconPlay, IconPlus, IconTrash, IconX } from '../components/icons';
import { describe, isActive, isWaiting, toneColor } from '../components/status';
import { useLive, type LiveProgress } from '../live';
import { bytes, duration, percent, speed } from '../format';
import { useT } from '../i18n';

type Filter = 'all' | 'active' | 'waiting' | 'finished' | 'failed';

type Row = { kind: 'pkg'; pkg: Package; children: Row[] } | { kind: 'dl'; d: Download };

const filters: { id: Filter; test: (d: Download) => boolean }[] = [
  { id: 'all', test: () => true },
  { id: 'active', test: isActive },
  { id: 'waiting', test: isWaiting },
  { id: 'finished', test: (d) => d.status === 'finished' },
  { id: 'failed', test: (d) => d.status === 'failed' },
];

function progressOf(d: Download, live: Map<number, LiveProgress>) {
  const l = live.get(d.id);
  const done = l?.bytesDone ?? d.bytesDone;
  const size = l?.size ?? d.size;
  return { done, size, speed: l?.speed ?? 0 };
}

const col = createColumnHelper<Row>();

export function DownloadsPage() {
  const t = useT();
  const { data: packages = [], isPending } = usePackages('queue');
  const stats = useStats().data;
  const settings = useSettings().data;
  const live = useLive();
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<ExpandedState>(true);

  const action = useMutation({ mutationFn: (path: string) => post(path) });
  const remove = useMutation({ mutationFn: (path: string) => api(path, { method: 'DELETE' }) });

  const all = packages.flatMap((p) => p.downloads);
  const counts = Object.fromEntries(filters.map((f) => [f.id, all.filter(f.test).length])) as Record<Filter, number>;

  const rows = useMemo<Row[]>(() => {
    const test = filters.find((f) => f.id === filter)!.test;
    const q = search.trim().toLowerCase();
    return packages
      .map((pkg) => ({
        kind: 'pkg' as const,
        pkg,
        children: pkg.downloads
          .filter((d) => test(d) && (!q || d.name.toLowerCase().includes(q) || pkg.name.toLowerCase().includes(q)))
          .map((d) => ({ kind: 'dl' as const, d })),
      }))
      .filter((r) => r.children.length > 0);
  }, [packages, filter, search]);

  const columns = useMemo(
    () => [
      col.display({
        id: 'name',
        header: t.common.name,
        cell: ({ row }) => row.original.kind === 'dl' && (
          <div className="cell-name" title={row.original.d.url}>{row.original.d.name}</div>
        ),
      }),
      col.display({
        id: 'hoster',
        header: t.downloads.colHoster,
        cell: ({ row }) => row.original.kind === 'dl' && <span className="pill">{row.original.d.pluginId ?? 'http'}</span>,
      }),
      col.display({
        id: 'size',
        header: t.common.size,
        cell: ({ row }) => {
          if (row.original.kind !== 'dl') return null;
          return <span className="cell-mono">{bytes(progressOf(row.original.d, live.items).size)}</span>;
        },
      }),
      col.display({
        id: 'progress',
        header: t.downloads.colProgress,
        cell: ({ row }) => {
          if (row.original.kind !== 'dl') return null;
          const d = row.original.d;
          const p = progressOf(d, live.items);
          const pct = d.status === 'finished' ? 100 : percent(p.done, p.size);
          const tone = describe(d, t).tone;
          return (
            <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={t.downloads.progressOf(d.name)}>
              <div className="bar">
                <div style={{ width: `${pct}%`, background: toneColor[tone].bar }} />
              </div>
              <span className="pct">{pct} %</span>
            </div>
          );
        },
      }),
      col.display({
        id: 'speed',
        header: t.downloads.colSpeed,
        cell: ({ row }) => {
          if (row.original.kind !== 'dl') return null;
          const p = progressOf(row.original.d, live.items);
          return <span className="cell-mono strong">{isActive(row.original.d) ? speed(p.speed) : '—'}</span>;
        },
      }),
      col.display({
        id: 'eta',
        header: t.downloads.colEta,
        cell: ({ row }) => {
          if (row.original.kind !== 'dl') return null;
          const p = progressOf(row.original.d, live.items);
          const eta = p.speed > 0 && p.size ? (p.size - p.done) / p.speed : null;
          return <span className="cell-mono">{isActive(row.original.d) ? duration(eta) : '—'}</span>;
        },
      }),
      col.display({
        id: 'status',
        header: t.common.status,
        cell: ({ row }) => {
          if (row.original.kind !== 'dl') return null;
          const s = describe(row.original.d, t);
          return (
            <div className="status" style={{ color: toneColor[s.tone].color }} title={row.original.d.error ?? s.label}>
              <span className="dot" style={{ background: toneColor[s.tone].color }} />
              <span>{s.label}</span>
            </div>
          );
        },
      }),
      col.display({
        id: 'actions',
        header: () => <span className="sr-only" />,
        cell: ({ row }) => {
          if (row.original.kind !== 'dl') return null;
          const d = row.original.d;
          const running = isActive(d) || d.status === 'queued';
          const canResume = d.status === 'paused' || d.status === 'failed';
          return (
            <div className="actions">
              <button
                type="button"
                className="icon-btn"
                aria-label={running ? t.common.pause(d.name) : t.common.resume(d.name)}
                disabled={!running && !canResume}
                onClick={() => action.mutate(`/downloads/${d.id}/${running ? 'pause' : 'resume'}`)}
              >
                {running ? <IconPause size={16} /> : <IconPlay size={16} />}
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label={t.common.remove(d.name)}
                onClick={() => remove.mutate(`/downloads/${d.id}`)}
              >
                <IconX size={16} />
              </button>
            </div>
          );
        },
      }),
    ],
    [live.items, action, remove, t],
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: { expanded },
    onExpandedChange: setExpanded,
    getSubRows: (r) => (r.kind === 'pkg' ? r.children : undefined),
    getRowId: (r) => (r.kind === 'pkg' ? `p${r.pkg.id}` : `d${r.d.id}`),
    getCoreRowModel: getCoreRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
  });

  const active = counts.active;
  const waiting = all.filter((d) => d.status === 'queued').length;
  const failed = counts.failed;
  const premium = stats?.premium[0];
  const anyRunning = all.some((d) => isActive(d) || d.status === 'queued');

  return (
    <>
      <PageHeader title={t.downloads.title} subtitle={t.downloads.subtitle(active, waiting, failed)}>
        <div className="speed-total" aria-live="polite">
          <div className="value">
            {speed(live.totalSpeed).replace('/s', '')} <small>/s</small>
          </div>
          <div className="hint">
            {t.downloads.total} · {stats?.speedLimitKib ? t.downloads.limit(`${bytes(stats.speedLimitKib * 1024)}/s`) : t.downloads.noLimit}
          </div>
        </div>
        <button type="button" className="btn" onClick={() => action.mutate(anyRunning ? '/downloads/pause-all' : '/downloads/resume-all')}>
          {anyRunning ? <IconPause size={16} /> : <IconPlay size={16} />}
          {anyRunning ? t.downloads.pauseAll : t.downloads.resumeAll}
        </button>
        <Link to="/linksammler" className="btn primary">
          <IconPlus size={16} strokeWidth={2.5} />
          {t.downloads.addLinks}
        </Link>
      </PageHeader>

      <div className="content">
        {settings && settings.autoExtract && settings.extractors.length === 0 && (
          <div className="notice" role="alert">
            <strong>{t.downloads.noExtractorTitle}</strong> {t.downloads.noExtractorText}{' '}
            <code className="mono">sudo apt install 7zip 7zip-rar</code> ({t.downloads.noExtractorOr}{' '}
            <code className="mono">7zip unrar</code>). {t.downloads.noExtractorThen}
          </div>
        )}
        <div className="grid-4">
          <div className="stat">
            <div className="k">{t.downloads.statActive}</div>
            <div className="v">
              {stats?.active ?? active} <small>/ {stats?.slots ?? '–'} {t.downloads.slots}</small>
            </div>
          </div>
          <div className="stat">
            <div className="k">{t.downloads.statQueue}</div>
            <div className="v">
              {stats?.queued ?? waiting} <small>· {bytes(stats?.queuedBytes ?? 0)}</small>
            </div>
          </div>
          <div className="stat">
            <div className="k">{t.downloads.statToday}</div>
            <div className="v">
              {stats?.finishedToday ?? 0} <small>· {bytes(stats?.finishedTodayBytes ?? 0)}</small>
            </div>
          </div>
          <div className="stat">
            <div className="k">{premium ? `${premium.pluginId} ${t.downloads.premium}` : t.downloads.premium}</div>
            <div className="v">
              {premium ? (
                premium.trafficLeft !== null ? (
                  <>
                    {bytes(premium.trafficLeft).split(' ')[0]} <small>{t.downloads.left(bytes(premium.trafficLeft).split(' ')[1])}</small>
                  </>
                ) : (
                  <small>{t.downloads.trafficUnknown}</small>
                )
              ) : (
                <small>
                  <Link to="/accounts">{t.downloads.addAccount}</Link>
                </small>
              )}
            </div>
          </div>
        </div>

        <div className="toolbar" role="group" aria-label={t.downloads.filterAria}>
          {filters.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`chip${filter === f.id ? ' on' : ''}${f.id === 'failed' && counts.failed ? ' err' : ''}`}
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
            >
              {t.downloads.filters[f.id]} {counts[f.id]}
            </button>
          ))}
          <div className="spacer" />
          {counts.finished > 0 && (
            <button type="button" className="btn small" onClick={() => action.mutate('/downloads/clear-finished')}>
              {t.downloads.clearFinished}
            </button>
          )}
          <label htmlFor="search" className="subtitle" style={{ fontSize: 13 }}>
            {t.downloads.search}
          </label>
          <input
            id="search"
            type="search"
            className="input search"
            placeholder={t.downloads.searchPlaceholder}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="table">
          <div className="table-scroll">
            <div className="trow head" role="row">
              {table.getHeaderGroups()[0].headers.map((h) => (
                <div key={h.id} role="columnheader">
                  {flexRender(h.column.columnDef.header, h.getContext())}
                </div>
              ))}
            </div>
            {table.getRowModel().rows.map((row) =>
              row.original.kind === 'pkg' ? (
                <PackageRow
                  key={row.id}
                  pkg={row.original.pkg}
                  live={live.items}
                  open={row.getIsExpanded()}
                  onToggle={row.getToggleExpandedHandler()}
                  onAction={(p) => action.mutate(p)}
                  onDelete={() => remove.mutate(`/packages/${row.original.kind === 'pkg' ? row.original.pkg.id : 0}`)}
                />
              ) : (
                <div className="trow" role="row" key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <div key={cell.id} role="cell" style={{ minWidth: 0 }}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </div>
                  ))}
                </div>
              ),
            )}
            {!isPending && rows.length === 0 && (
              <div className="empty">
                <strong>{all.length ? t.downloads.nothingFound : t.downloads.empty}</strong>
                {all.length ? t.downloads.adjustFilter : <Link to="/linksammler">{t.downloads.emptyHint}</Link>}
              </div>
            )}
          </div>
        </div>
      </div>

      <footer className="footer">
        <span>
          {t.downloads.parallel(settings?.maxParallel ?? '–')} · {t.downloads.connections(settings?.connectionsPerFile ?? '–')}
        </span>
        <span>
          {t.downloads.tmpDir} → {settings?.tmpDir}
        </span>
        <span>
          {t.downloads.doneDir} → {settings?.doneDir}
        </span>
        <span className="right">{t.downloads.liveUpdates}</span>
      </footer>
    </>
  );
}

function PackageRow({
  pkg,
  live,
  open,
  onToggle,
  onAction,
  onDelete,
}: {
  pkg: Package;
  live: Map<number, LiveProgress>;
  open: boolean;
  onToggle: () => void;
  onAction: (path: string) => void;
  onDelete: () => void;
}) {
  const t = useT();
  const total = pkg.downloads.reduce((n, d) => n + (progressOf(d, live).size ?? 0), 0);
  const done = pkg.downloads.reduce((n, d) => n + (d.status === 'finished' ? (d.size ?? 0) : progressOf(d, live).done), 0);
  const running = pkg.downloads.some((d) => isActive(d) || d.status === 'queued');
  const resumable = pkg.downloads.some((d) => d.status === 'paused' || d.status === 'failed');
  const extractPercent = useLive().extract.get(pkg.id);
  const extract =
    pkg.extract === 'running'
      ? extractPercent !== undefined
        ? t.pkg.extractingPct(extractPercent)
        : t.pkg.extracting
      : pkg.extract === 'done'
        ? t.pkg.extracted
        : pkg.extract === 'failed'
          ? t.pkg.extractFailed
          : null;
  const n = pkg.downloads.length;
  return (
    <>
    <div className="pkg-row" role="row">
      <button type="button" className="icon-btn toggle" aria-expanded={open} aria-label={t.pkg.toggle(pkg.name)} onClick={onToggle}>
        <IconChevron size={14} strokeWidth={2.5} open={open} />
      </button>
      <IconFolder size={16} style={{ color: 'var(--accent)' }} />
      <div className="name">{pkg.name}</div>
      <div className="meta">
        {t.common.files(n)} · {bytes(total)} · {percent(done, total)} %
        {extract && (
          <span style={{ color: pkg.extract === 'failed' ? 'var(--err)' : undefined }} title={pkg.extractError ?? undefined}>
            {' '}
            · {extract}
          </span>
        )}
      </div>
      <div className="grow" />
      {pkg.extract === 'running' && (
        <div
          className="extract-bar"
          role="progressbar"
          aria-label={t.pkg.beingExtracted(pkg.name)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={extractPercent ?? 0}
        >
          <div className="bar">
            <div style={{ width: `${extractPercent ?? 0}%`, background: 'var(--accent)' }} />
          </div>
        </div>
      )}
      <button
        type="button"
        className="icon-btn"
        aria-label={t.pkg.extractName(pkg.name)}
        title={t.pkg.extract}
        disabled={pkg.extract === 'running' || !pkg.downloads.every((d) => d.status === 'finished')}
        onClick={() => onAction(`/packages/${pkg.id}/extract`)}
      >
        <IconArchive size={16} />
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label={running ? t.common.pause(pkg.name) : t.common.resume(pkg.name)}
        disabled={!running && !resumable}
        onClick={() => onAction(`/packages/${pkg.id}/${running ? 'pause' : 'resume'}`)}
      >
        {running ? <IconPause size={16} /> : <IconPlay size={16} />}
      </button>
      <button type="button" className="icon-btn" aria-label={t.common.remove(pkg.name)} onClick={onDelete}>
        <IconTrash size={16} />
      </button>
    </div>
    {pkg.extract === 'failed' && (
      <div className="pkg-error" role="row">
        <span role="alert">{pkg.extractError ?? t.pkg.extractFailed}</span>
        <button type="button" className="btn small" onClick={() => onAction(`/packages/${pkg.id}/extract`)}>
          <IconArchive size={16} />
          {t.pkg.extractAgain}
        </button>
      </div>
    )}
    </>
  );
}
