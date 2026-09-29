import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { api, post, type FileEntry, type FolderView, type MoveTarget } from '../api';
import { PageHeader, useStats } from '../components/Layout';
import { IconArchive, IconChevron, IconFolder, IconTrash } from '../components/icons';
import { useLive } from '../live';
import { bytes, date } from '../format';

type State = { label: string; tone: 'ok' | 'warn' | 'err' | 'muted' };

/** What the folder's state is, from Haul's point of view. */
const archiveCount = (n: number) => `${n} ${n === 1 ? 'Archivdatei' : 'Archivdateien'}`;

function folderState(e: FileEntry, topLevel: boolean): State | null {
  if (!e.dir) return e.kind === 'archive' ? { label: 'Archiv', tone: 'muted' } : null;
  if (e.error) return { label: 'Entpacken fehlgeschlagen', tone: 'err' };
  const p = e.package;
  if (p?.extract === 'failed') return { label: 'Entpacken fehlgeschlagen', tone: 'err' };
  if (e.archives > 0 && p?.extract === 'done') return { label: `${archiveCount(e.archives)} übrig`, tone: 'warn' };
  if (e.archives > 0) return { label: `${archiveCount(e.archives)}, nicht entpackt`, tone: 'warn' };
  if (p) return { label: p.extract === 'done' ? 'entpackt' : 'fertig', tone: 'ok' };
  return topLevel ? { label: 'nicht von Haul', tone: 'muted' } : null;
}

const toneColor = { ok: 'var(--ok)', warn: 'var(--accent)', err: 'var(--err)', muted: 'var(--muted-2)' };

function Breadcrumbs({ path, onOpen }: { path: string; onOpen: (p: string) => void }) {
  const parts = path ? path.split('/') : [];
  return (
    <nav className="crumbs" aria-label="Ordnerpfad">
      <button type="button" className="crumb" onClick={() => onOpen('')} aria-current={parts.length === 0 ? 'page' : undefined}>
        Fertig
      </button>
      {parts.map((part, i) => {
        const to = parts.slice(0, i + 1).join('/');
        return (
          <span key={to} className="crumb-sep">
            /
            <button type="button" className="crumb" onClick={() => onOpen(to)} aria-current={i === parts.length - 1 ? 'page' : undefined}>
              {part}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

function Row({
  entry,
  topLevel,
  targets,
  extracting,
  onOpen,
  onAction,
}: {
  entry: FileEntry;
  topLevel: boolean;
  targets: MoveTarget[];
  extracting: number | undefined;
  onOpen: (p: string) => void;
  onAction: (a: { kind: 'extract' | 'delete' | 'delete-archives' | 'move'; entry: FileEntry; target?: string }) => void;
}) {
  const state = folderState(entry, topLevel);
  const busy = extracting !== undefined;
  const canExtract = entry.dir ? entry.archives > 0 : entry.kind === 'archive';
  const error = entry.error ?? entry.package?.extractError ?? null;
  return (
    <>
      <div className="frow" role="row">
        <div className="fname" role="cell">
          {entry.dir ? (
            <button type="button" className="link-btn" onClick={() => onOpen(entry.path)}>
              <IconFolder size={16} style={{ color: 'var(--accent)', flexShrink: 0 }} />
              <span>{entry.name}</span>
              <IconChevron size={12} open={false} />
            </button>
          ) : (
            <span className="mono file-name">{entry.name}</span>
          )}
        </div>
        <div role="cell" className="fstate">
          {busy ? (
            <div className="progress" role="progressbar" aria-label={`${entry.name} wird entpackt`} aria-valuenow={extracting} aria-valuemin={0} aria-valuemax={100}>
              <div className="bar">
                <div style={{ width: `${extracting}%`, background: 'var(--accent)' }} />
              </div>
              <span className="pct">{extracting} %</span>
            </div>
          ) : (
            state && (
              <span className="status" style={{ color: toneColor[state.tone] }} title={error ?? state.label}>
                <span className="dot" style={{ background: toneColor[state.tone] }} />
                <span>{state.label}</span>
              </span>
            )
          )}
        </div>
        <div role="cell" className="cell-mono">
          {bytes(entry.size)}
        </div>
        <div role="cell" className="cell-mono">
          {date(entry.modified)}
        </div>
        <div role="cell" className="actions">
          {canExtract && (
            <button type="button" className="btn small" disabled={busy} onClick={() => onAction({ kind: 'extract', entry })}>
              <IconArchive size={16} />
              Entpacken
            </button>
          )}
          {entry.dir && entry.archives > 0 && (
            <button type="button" className="btn small" disabled={busy} onClick={() => onAction({ kind: 'delete-archives', entry })}>
              Archive löschen
            </button>
          )}
          {targets.length > 0 && (
            <select
              className="select small-select"
              aria-label={`${entry.name} verschieben`}
              value=""
              disabled={busy}
              onChange={(e) => e.target.value && onAction({ kind: 'move', entry, target: e.target.value })}
            >
              <option value="">Verschieben …</option>
              {targets.map((t) => (
                <option key={t.name} value={t.name} disabled={!t.available}>
                  {t.name}
                  {t.available ? '' : ' (nicht erreichbar)'}
                </option>
              ))}
            </select>
          )}
          <button type="button" className="icon-btn" aria-label={`${entry.name} löschen`} disabled={busy} onClick={() => onAction({ kind: 'delete', entry })}>
            <IconTrash size={16} />
          </button>
        </div>
      </div>
      {error && !busy && (
        <div className="pkg-error" role="row">
          <span role="alert">{error}</span>
        </div>
      )}
    </>
  );
}

export function DonePage() {
  const { path } = useSearch({ from: '/fertig' });
  const navigate = useNavigate();
  const open = (p: string) => navigate({ to: '/fertig', search: { path: p } });
  const live = useLive();
  const stats = useStats().data;
  const view = useQuery({
    queryKey: ['files', path],
    queryFn: () => api<FolderView>(`/files?path=${encodeURIComponent(path)}`),
  });
  const act = useMutation({
    mutationFn: async (a: { kind: 'extract' | 'delete' | 'delete-archives' | 'move'; entry: FileEntry; target?: string }) => {
      switch (a.kind) {
        case 'extract':
          return post('/files/extract', { path: a.entry.path });
        case 'delete-archives':
          if (!confirm(`Alle Archivdateien in „${a.entry.name}“ löschen?`)) return;
          return post('/files/delete-archives', { path: a.entry.path });
        case 'move':
          if (!confirm(`„${a.entry.name}“ nach „${a.target}“ verschieben?`)) return;
          return post('/files/move', { path: a.entry.path, target: a.target });
        case 'delete':
          if (!confirm(`„${a.entry.name}“ ${a.entry.dir ? 'mit allem Inhalt ' : ''}endgültig löschen?`)) return;
          return post('/files/delete', { paths: [a.entry.path] });
      }
    },
    onSettled: () => view.refetch(),
  });

  const data = view.data;
  const doneDisk = stats?.storage.find((s) => s.label === 'fertig');
  const total = data?.entries.reduce((n, e) => n + e.size, 0) ?? 0;
  const here = live.extractPaths.get(path) ?? data?.extracting ?? undefined;

  return (
    <>
      <PageHeader
        title="Fertig"
        subtitle={
          <>
            <span className="mono">{data?.root ?? ''}</span>
            {data && ` · ${data.entries.length} Einträge · ${bytes(total)}`}
            {doneDisk && ` · ${bytes(doneDisk.free)} frei`}
          </>
        }
      />
      <div className="content">
        <Breadcrumbs path={path} onOpen={open} />
        {view.error && <div className="notice" role="alert">{view.error.message}</div>}
        {act.error && <div className="notice" role="alert">{act.error.message}</div>}
        {here !== undefined && (
          <div className="notice info" role="status">
            Dieser Ordner wird entpackt: {here} %
          </div>
        )}
        {data?.error && <div className="notice" role="alert">{data.error}</div>}

        <div className="table">
          <div className="table-scroll">
            <div className="frow head" role="row">
              <div role="columnheader">Name</div>
              <div role="columnheader">Zustand</div>
              <div role="columnheader">Größe</div>
              <div role="columnheader">Geändert</div>
              <div role="columnheader">
                <span className="sr-only">Aktionen</span>
              </div>
            </div>
            {path && (
              <div className="frow" role="row">
                <div className="fname" role="cell">
                  <button type="button" className="link-btn" onClick={() => open(path.split('/').slice(0, -1).join('/'))}>
                    <IconFolder size={16} style={{ color: 'var(--muted-2)' }} />
                    <span>..</span>
                  </button>
                </div>
              </div>
            )}
            {data?.entries.map((e) => (
              <Row
                key={e.path}
                entry={e}
                topLevel={path === ''}
                targets={data.targets}
                extracting={live.extractPaths.get(e.path) ?? e.extracting ?? (e.dir ? undefined : here)}
                onOpen={open}
                onAction={(a) => act.mutate(a)}
              />
            ))}
            {data && data.entries.length === 0 && (
              <div className="empty">
                <strong>Leer</strong>
                {path ? 'Dieser Ordner ist leer.' : 'Fertige Downloads landen hier, ein Ordner pro Paket.'}
              </div>
            )}
          </div>
        </div>

        {data && data.targets.length === 0 && (
          <div className="notice info">
            Zum Verschieben (z. B. an den Renamer) Ziele in <code className="mono">.env</code> bzw. docker-compose festlegen:{' '}
            <code className="mono">HAUL_MOVE_TARGETS=Renamer=/media/inbox;Archiv=/mnt/archiv</code>. Die Ordner müssen im
            Container gemountet sein.
          </div>
        )}
      </div>
    </>
  );
}
