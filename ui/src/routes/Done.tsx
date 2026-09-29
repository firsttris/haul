import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { api, post, type FileEntry, type FolderView } from '../api';
import { PageHeader, useStats } from '../components/Layout';
import { IconArchive, IconChevron, IconFolder, IconPlus, IconTrash } from '../components/icons';
import { useLive } from '../live';
import { bytes, date } from '../format';
import { useT, type Messages } from '../i18n';

type State = { label: string; tone: 'ok' | 'warn' | 'err' | 'muted' };

/** What the folder's state is, from Haul's point of view. */
function folderState(e: FileEntry, topLevel: boolean, t: Messages): State | null {
  const d = t.done;
  if (!e.dir) return e.kind === 'archive' ? { label: d.stateArchive, tone: 'muted' } : null;
  if (e.error) return { label: d.stateFailed, tone: 'err' };
  const p = e.package;
  if (p?.extract === 'failed') return { label: d.stateFailed, tone: 'err' };
  if (e.archives > 0 && p?.extract === 'done') return { label: d.stateLeft(d.archives(e.archives)), tone: 'warn' };
  if (e.archives > 0) return { label: d.stateNotExtracted(d.archives(e.archives)), tone: 'warn' };
  if (p) return { label: p.extract === 'done' ? d.stateExtracted : d.stateFinished, tone: 'ok' };
  return topLevel ? { label: d.stateForeign, tone: 'muted' } : null;
}

const toneColor = { ok: 'var(--ok)', warn: 'var(--accent)', err: 'var(--err)', muted: 'var(--muted-2)' };

const displayPath = (p: string, t: Messages) => (p ? `${t.done.root} / ${p.split('/').join(' / ')}` : t.done.root);

function Breadcrumbs({ path, onOpen }: { path: string; onOpen: (p: string) => void }) {
  const t = useT();
  const parts = path ? path.split('/') : [];
  return (
    <nav className="crumbs" aria-label={t.done.pathAria}>
      <button type="button" className="crumb" onClick={() => onOpen('')} aria-current={parts.length === 0 ? 'page' : undefined}>
        {t.done.root}
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

/** A modal <dialog> that opens while `open` is true. */
function Modal({ open, onClose, children }: { open: boolean; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="dialog" onClose={onClose}>
      {open && children}
    </dialog>
  );
}

function NewFolderDialog({ open, parent, onClose }: { open: boolean; parent: string; onClose: () => void }) {
  const t = useT();
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => post('/files/mkdir', { path: parent, name }),
    onSuccess: () => {
      setName('');
      onClose();
    },
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }
  return (
    <Modal open={open} onClose={onClose}>
      <form onSubmit={submit}>
        <h2>{t.done.newFolder}</h2>
        <div className="subtitle">{t.done.inFolder(displayPath(parent, t))}</div>
        <div className="field">
          <label htmlFor="new-folder">{t.common.name}</label>
          <input id="new-folder" className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
        </div>
        {create.error && <div className="notice" role="alert">{create.error.message}</div>}
        <div className="buttons">
          <button type="button" className="btn small" onClick={onClose}>
            {t.common.cancel}
          </button>
          <button type="submit" className="btn small primary" disabled={create.isPending}>
            {t.done.create}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function MoveDialog({
  open,
  selected,
  current,
  onClose,
  onMoved,
}: {
  open: boolean;
  selected: FileEntry[];
  current: string;
  onClose: () => void;
  onMoved: () => void;
}) {
  const t = useT();
  const folders = useQuery({ queryKey: ['files', 'folders'], queryFn: () => api<string[]>('/files/folders'), enabled: open });
  const [dest, setDest] = useState('');
  const [filter, setFilter] = useState('');
  const [newName, setNewName] = useState('');
  useEffect(() => {
    if (open) {
      setDest(current);
      setFilter('');
      setNewName('');
    }
  }, [open, current]);
  // Nothing may go into itself or where it already is.
  const blocked = (f: string) =>
    selected.some((s) => s.dir && (f === s.path || f.startsWith(`${s.path}/`)));
  const choices = ['', ...(folders.data ?? [])].filter(
    (f) => !blocked(f) && (!filter || f.toLowerCase().includes(filter.toLowerCase())),
  );
  const move = useMutation({
    mutationFn: async () => {
      let to = dest;
      if (newName.trim()) {
        to = (await post<{ path: string }>('/files/mkdir', { path: dest, name: newName })).path;
      }
      await post('/files/move', { paths: selected.map((s) => s.path), to });
    },
    onSuccess: () => {
      onMoved();
      onClose();
    },
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    move.mutate();
  }
  const n = selected.length;
  return (
    <Modal open={open} onClose={onClose}>
      <form onSubmit={submit}>
        <h2>{n === 1 ? t.done.moveOne(selected[0].name) : t.done.moveMany(n)}</h2>
        <div className="field">
          <label htmlFor="move-filter">{t.done.targetFolder}</label>
          <input id="move-filter" className="input" type="search" placeholder={t.done.searchFolders} value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <div className="folder-list" role="radiogroup" aria-label={t.done.targetFolder}>
          {choices.map((f) => (
            <label key={f || '/'} className={`folder-choice${dest === f ? ' on' : ''}`}>
              <input type="radio" name="dest" value={f} checked={dest === f} onChange={() => setDest(f)} />
              <IconFolder size={16} style={{ color: 'var(--accent)', flexShrink: 0 }} />
              <span>{f ? f.split('/').join(' / ') : t.done.topLevel}</span>
            </label>
          ))}
        </div>
        <div className="field">
          <label htmlFor="move-new">{t.done.optionalNew}</label>
          <input id="move-new" className="input" placeholder={t.done.newFolderName} value={newName} onChange={(e) => setNewName(e.target.value)} />
          <span className="help">
            {t.done.target(`${displayPath(dest, t)}${newName.trim() ? ` / ${newName.trim()}` : ''}`)}
          </span>
        </div>
        {move.error && <div className="notice" role="alert">{move.error.message}</div>}
        <div className="buttons">
          <button type="button" className="btn small" onClick={onClose}>
            {t.common.cancel}
          </button>
          <button type="submit" className="btn small primary" disabled={move.isPending || (dest === current && !newName.trim())}>
            {t.done.move}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function DonePage() {
  const t = useT();
  const { path } = useSearch({ from: '/fertig' });
  const navigate = useNavigate();
  const open = (p: string) => navigate({ to: '/fertig', search: { path: p } });
  const live = useLive();
  const stats = useStats().data;
  const view = useQuery({
    queryKey: ['files', path],
    queryFn: () => api<FolderView>(`/files?path=${encodeURIComponent(path)}`),
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<'none' | 'mkdir' | 'move'>('none');
  useEffect(() => setSelected(new Set()), [path]);

  const data = view.data;
  const entries = useMemo(() => data?.entries ?? [], [data]);
  // Drop selections that no longer exist (deleted, moved).
  useEffect(() => {
    setSelected((sel) => new Set([...sel].filter((p) => entries.some((e) => e.path === p))));
  }, [entries]);
  const chosen = entries.filter((e) => selected.has(e.path));
  const here = live.extractPaths.get(path) ?? data?.extracting ?? undefined;
  const busy = (e: FileEntry) => live.extractPaths.has(e.path) || e.extracting != null || (!e.dir && here !== undefined);

  const act = useMutation({
    mutationFn: async (kind: 'extract' | 'delete-archives' | 'delete') => {
      const paths = chosen.map((e) => e.path);
      if (kind === 'extract') return post('/files/extract', { paths });
      if (kind === 'delete-archives') {
        const folders = chosen.filter((e) => e.dir && e.archives > 0).map((e) => e.path);
        if (!confirm(t.done.confirmDeleteArchives(folders.length))) return;
        return post('/files/delete-archives', { paths: folders });
      }
      const question =
        chosen.length === 1 ? t.done.confirmDeleteOne(chosen[0].name, chosen[0].dir) : t.done.confirmDeleteMany(chosen.length);
      if (!confirm(question)) return;
      return post('/files/delete', { paths });
    },
    // Clear the selection after an action, so the next one starts fresh.
    onSuccess: () => setSelected(new Set()),
    onSettled: () => view.refetch(),
  });

  const toggle = (p: string) =>
    setSelected((sel) => {
      const next = new Set(sel);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  const allSelected = entries.length > 0 && chosen.length === entries.length;
  const canExtract = chosen.some((e) => (e.dir ? e.archives > 0 : e.kind === 'archive')) && !chosen.some(busy);
  const canDeleteArchives = chosen.some((e) => e.dir && e.archives > 0) && !chosen.some(busy);
  const doneDisk = stats?.storage.find((s) => s.label === 'fertig');
  const total = entries.reduce((n, e) => n + e.size, 0);

  return (
    <>
      <PageHeader
        title={t.done.title}
        subtitle={
          <>
            <span className="mono">{data?.root ?? ''}</span>
            {data && ` · ${t.done.entries(entries.length)} · ${bytes(total)}`}
            {doneDisk && ` · ${t.done.free(bytes(doneDisk.free))}`}
          </>
        }
      />
      <div className="content">
        <Breadcrumbs path={path} onOpen={open} />

        <div className="toolbar files-toolbar" role="toolbar" aria-label={t.done.actionsAria}>
          {chosen.length === 0 ? (
            <span className="subtitle" style={{ fontSize: 13 }}>
              {t.done.selectHint}
            </span>
          ) : (
            <>
              <strong style={{ fontSize: 14 }}>{t.done.selected(chosen.length)}</strong>
              <button type="button" className="btn small" disabled={!canExtract || act.isPending} onClick={() => act.mutate('extract')}>
                <IconArchive size={16} />
                {t.done.extract}
              </button>
              <button type="button" className="btn small" disabled={chosen.some(busy)} onClick={() => setDialog('move')}>
                {t.done.moveEllipsis}
              </button>
              {canDeleteArchives && (
                <button type="button" className="btn small" disabled={act.isPending} onClick={() => act.mutate('delete-archives')}>
                  {t.done.deleteArchives}
                </button>
              )}
              <button type="button" className="btn small danger" disabled={chosen.some(busy) || act.isPending} onClick={() => act.mutate('delete')}>
                <IconTrash size={16} />
                {t.done.delete}
              </button>
              <button type="button" className="btn small" onClick={() => setSelected(new Set())}>
                {t.done.clearSelection}
              </button>
            </>
          )}
          <div className="spacer" />
          <button type="button" className="btn small" onClick={() => setDialog('mkdir')}>
            <IconPlus size={16} />
            {t.done.newFolder}
          </button>
        </div>

        {view.error && <div className="notice" role="alert">{view.error.message}</div>}
        {act.error && <div className="notice" role="alert">{act.error.message}</div>}
        {here !== undefined && (
          <div className="notice info" role="status">
            {t.done.extractingHere(here)}
          </div>
        )}
        {data?.error && <div className="notice" role="alert">{data.error}</div>}

        <div className="table">
          <div className="table-scroll">
            <div className="frow head" role="row">
              <div role="columnheader">
                <input
                  type="checkbox"
                  className="row-check"
                  aria-label={t.done.selectAll}
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = chosen.length > 0 && !allSelected;
                  }}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(entries.map((e) => e.path)))}
                  disabled={entries.length === 0}
                />
              </div>
              <div role="columnheader">{t.common.name}</div>
              <div role="columnheader">{t.done.colState}</div>
              <div role="columnheader">{t.common.size}</div>
              <div role="columnheader">{t.done.colModified}</div>
            </div>
            {path && (
              <div className="frow" role="row">
                <div role="cell" />
                <div className="fname" role="cell">
                  <button type="button" className="link-btn" onClick={() => open(path.split('/').slice(0, -1).join('/'))}>
                    <IconFolder size={16} style={{ color: 'var(--muted-2)' }} />
                    <span>..</span>
                  </button>
                </div>
              </div>
            )}
            {entries.map((e) => {
              const state = folderState(e, path === '', t);
              const progress = live.extractPaths.get(e.path) ?? e.extracting ?? undefined;
              const error = e.error ?? e.package?.extractError ?? null;
              return (
                <div key={e.path}>
                  <div className={`frow${selected.has(e.path) ? ' selected' : ''}`} role="row">
                    <div role="cell">
                      <input type="checkbox" className="row-check" aria-label={t.done.select(e.name)} checked={selected.has(e.path)} onChange={() => toggle(e.path)} />
                    </div>
                    <div className="fname" role="cell">
                      {e.dir ? (
                        <button type="button" className="link-btn" onClick={() => open(e.path)}>
                          <IconFolder size={16} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                          <span>{e.name}</span>
                          <IconChevron size={12} open={false} />
                        </button>
                      ) : (
                        <label className="file-label" htmlFor={undefined} onClick={() => toggle(e.path)}>
                          <span className="mono file-name">{e.name}</span>
                        </label>
                      )}
                    </div>
                    <div role="cell" className="fstate">
                      {progress !== undefined ? (
                        <div className="progress" role="progressbar" aria-label={t.done.beingExtracted(e.name)} aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
                          <div className="bar">
                            <div style={{ width: `${progress}%`, background: 'var(--accent)' }} />
                          </div>
                          <span className="pct">{progress} %</span>
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
                      {bytes(e.size)}
                    </div>
                    <div role="cell" className="cell-mono">
                      {date(e.modified)}
                    </div>
                  </div>
                  {error && progress === undefined && (
                    <div className="pkg-error" role="row">
                      <span role="alert">{error}</span>
                    </div>
                  )}
                </div>
              );
            })}
            {data && entries.length === 0 && (
              <div className="empty">
                <strong>{t.done.empty}</strong>
                {path ? t.done.emptyFolder : t.done.emptyRoot}
              </div>
            )}
          </div>
        </div>
      </div>

      <NewFolderDialog open={dialog === 'mkdir'} parent={path} onClose={() => setDialog('none')} />
      <MoveDialog
        open={dialog === 'move'}
        selected={chosen}
        current={path}
        onClose={() => setDialog('none')}
        onMoved={() => setSelected(new Set())}
      />
    </>
  );
}
