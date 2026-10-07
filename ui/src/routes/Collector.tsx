import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { api, post, type Package } from '../api';
import { PageHeader, usePackages } from '../components/Layout';
import { IconPlay, IconRefresh, IconTrash } from '../components/icons';
import { partialArchives } from '../components/archive';
import { loadUnchecked, pruneUnchecked, saveUnchecked, type Unchecked } from '../components/unchecked';
import { describe, toneColor } from '../components/status';
import { bytes } from '../format';
import { localize } from '../i18n';
import * as m from '../paraglide/messages';

function AddLinksForm() {
  const navigate = useNavigate();
  const [links, setLinks] = useState('');
  const [packageName, setPackageName] = useState('');
  const [targetDir, setTargetDir] = useState('');
  // One password for the protected download and the archive; the server uses it as both.
  const [password, setPassword] = useState('');
  const [start, setStart] = useState(false);
  const add = useMutation({
    mutationFn: () => post<{ packageId: number }>('/links', { links, packageName, targetDir, password, start }),
    onSuccess: () => {
      setLinks('');
      setPackageName('');
      setTargetDir('');
      setPassword('');
      if (start) navigate({ to: '/' });
    },
  });
  const count = links.split(/\s+/).filter((l) => /^https?:\/\//.test(l)).length;

  function submit(e: FormEvent) {
    e.preventDefault();
    add.mutate();
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>{m.collector_paste()}</h2>
      <div className="field">
        <label htmlFor="links">{m.collector_linksLabel()}</label>
        <textarea
          id="links"
          className="textarea"
          placeholder={m.collector_linksPlaceholder()}
          value={links}
          onChange={(e) => setLinks(e.target.value)}
          required
        />
      </div>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="pkg">{m.collector_packageName()}</label>
          <input id="pkg" className="input" placeholder={m.collector_packageNamePlaceholder()} value={packageName} onChange={(e) => setPackageName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="dir">{m.collector_targetDir()}</label>
          <input id="dir" className="input" placeholder={m.collector_targetDirPlaceholder()} value={targetDir} onChange={(e) => setTargetDir(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="pw">{m.collector_password()}</label>
        <input
          id="pw"
          className="input"
          autoComplete="off"
          placeholder={m.collector_passwordPlaceholder()}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <span className="help">{m.collector_passwordHelp()}</span>
      </div>
      {add.error && <div className="notice" role="alert">{add.error.message}</div>}
      <div className="toolbar">
        <label className="checkbox">
          <input type="checkbox" checked={start} onChange={(e) => setStart(e.target.checked)} />
          {m.collector_startNow()}
        </label>
        <div className="spacer" />
        <button type="submit" className="btn primary" disabled={add.isPending || count === 0}>
          {count > 0 ? m.collector_addN({ n: count }) : m.collector_add()}
        </button>
      </div>
    </form>
  );
}

// Unchecked files per package (components/unchecked): everything starts checked (like JD's
// Linkgrabber), so "start" without touching a checkbox loads the whole package.

/** Starts the checked files of a package; all checked: the whole package. */
function startPackage(pkg: Package, unchecked: Set<number>) {
  const checked = pkg.downloads.filter((d) => !unchecked.has(d.id));
  if (checked.length === pkg.downloads.length) return post(`/packages/${pkg.id}/start`);
  return post(`/packages/${pkg.id}/start`, { downloadIds: checked.map((d) => d.id) });
}

function CollectedPackage({ pkg, unchecked, setUnchecked }: { pkg: Package; unchecked: Set<number>; setUnchecked: (s: Set<number>) => void }) {
  const [name, setName] = useState(pkg.name);
  const [targetDir, setTargetDir] = useState(pkg.targetDir);
  const last = useRef<number | null>(null);
  // Each field follows the server on its own: a new folder must not reset a name being typed.
  useEffect(() => setName(pkg.name), [pkg.name]);
  useEffect(() => setTargetDir(pkg.targetDir), [pkg.targetDir]);

  const save = useMutation({ mutationFn: (body: object) => api(`/packages/${pkg.id}`, { method: 'PATCH', body }) });
  const act = useMutation({ mutationFn: (path: string) => post(path) });
  const start = useMutation({ mutationFn: () => startPackage(pkg, unchecked), onSuccess: () => setUnchecked(new Set()) });
  const remove = useMutation({ mutationFn: () => api(`/packages/${pkg.id}`, { method: 'DELETE' }) });
  const removeOne = useMutation({ mutationFn: (id: number) => api(`/downloads/${id}`, { method: 'DELETE' }) });
  const failed = [start, save, act, remove, removeOne].find((x) => x.error)?.error;

  const total = pkg.downloads.reduce((n, d) => n + (d.size ?? 0), 0);
  const offline = pkg.downloads.filter((d) => d.online === 'offline').length;
  const checked = pkg.downloads.filter((d) => !unchecked.has(d.id));
  const allChecked = checked.length === pkg.downloads.length;
  const startable = checked.filter((d) => d.online !== 'offline').length;
  const online = pkg.downloads.length - offline;
  const partial = partialArchives(pkg.downloads, unchecked);

  /** Click (or shift-click for the range since the last click) flips the files' checkboxes. */
  function toggle(i: number, range: boolean) {
    const on = unchecked.has(pkg.downloads[i].id);
    const from = range && last.current !== null ? Math.min(last.current, i) : i;
    const to = range && last.current !== null ? Math.max(last.current, i) : i;
    const next = new Set(unchecked);
    for (let k = from; k <= to; k++) {
      const id = pkg.downloads[k]?.id;
      if (id === undefined) continue;
      if (on) next.delete(id);
      else next.add(id);
    }
    last.current = i;
    setUnchecked(next);
  }

  return (
    <section className="card" aria-label={m.collector_packageAria({ name: pkg.name })}>
      <div className="grid-2">
        <div className="field">
          <label htmlFor={`name-${pkg.id}`}>{m.collector_packageName()}</label>
          <input
            id={`name-${pkg.id}`}
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name !== pkg.name && save.mutate({ name })}
          />
        </div>
        <div className="field">
          <label htmlFor={`dir-${pkg.id}`}>{m.collector_target()}</label>
          <input
            id={`dir-${pkg.id}`}
            className="input mono"
            value={targetDir}
            onChange={(e) => setTargetDir(e.target.value)}
            onBlur={() => targetDir !== pkg.targetDir && save.mutate({ targetDir })}
          />
        </div>
      </div>
      <div className="subtitle" style={{ fontSize: 13 }}>
        {pkg.source === 'cnl' ? "Click'n'Load" : pkg.source === 'extension' ? m.collector_extension() : m.collector_manual()}
        {pkg.sourcePage && (
          <>
            {' '}
            {m.collector_from()} <span className="mono">{pkg.sourcePage}</span>
          </>
        )}
        {' · '}
        {m.common_files({ n: pkg.downloads.length })} · {bytes(total)}
        {pkg.hasPasswords && ` · ${m.collector_withPassword()}`}
        {offline > 0 && <span style={{ color: 'var(--err)' }}> · {m.collector_offline({ n: offline })}</span>}
      </div>
      <div className="list">
        {pkg.downloads.length > 1 && (
          <label className="list-row pick-all">
            <input
              type="checkbox"
              className="row-check"
              checked={allChecked}
              ref={(el) => {
                if (el) el.indeterminate = checked.length > 0 && !allChecked;
              }}
              onChange={() => {
                last.current = null;
                setUnchecked(allChecked ? new Set(pkg.downloads.map((d) => d.id)) : new Set());
              }}
            />
            <span className="grow">
              <span className="title">{m.collector_checkAll()}</span>
            </span>
            <span className="subtitle" style={{ fontSize: 13 }}>
              {m.collector_checkedOf({ n: checked.length, total: pkg.downloads.length })}
            </span>
          </label>
        )}
        {pkg.downloads.map((d, i) => {
          const s = describe(d);
          const on = !unchecked.has(d.id);
          return (
            <div className={`list-row pick${on ? '' : ' unchecked'}`} key={d.id} onClick={(e) => toggle(i, e.shiftKey)}>
              <input
                type="checkbox"
                className="row-check"
                aria-label={m.collector_include({ name: d.name })}
                checked={on}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(i, e.shiftKey);
                }}
                onChange={() => {}}
              />
              <div className="grow">
                <span className="cell-name">{d.name}</span>
                <span className="sub mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {d.url}
                </span>
              </div>
              <span className="pill">{d.pluginId ?? 'http'}</span>
              <span className="cell-mono" style={{ width: 80 }}>{bytes(d.size)}</span>
              <div className="status" style={{ color: toneColor[s.tone].color, width: 140 }} title={localize(d.error) ?? s.label}>
                <span className="dot" style={{ background: toneColor[s.tone].color }} />
                <span>{s.label}</span>
              </div>
              <button
                type="button"
                className="icon-btn"
                aria-label={m.common_remove({ name: d.name })}
                onClick={(e) => {
                  e.stopPropagation();
                  removeOne.mutate(d.id);
                }}
              >
                <IconTrash size={16} />
              </button>
            </div>
          );
        })}
      </div>
      {partial.map((a) => (
        <div className="notice" role="status" key={a.label}>
          {m.collector_partialArchive({ name: a.label, n: a.checked, total: a.total })}{' '}
          <button
            type="button"
            className="btn small"
            onClick={() => {
              const next = new Set(unchecked);
              a.ids.forEach((id) => next.delete(id));
              setUnchecked(next);
            }}
          >
            {m.collector_checkAllParts()}
          </button>
        </div>
      ))}
      {failed && <div className="notice" role="alert">{localize(failed.message)}</div>}
      <div className="toolbar">
        <button type="button" className="btn small" onClick={() => act.mutate(`/packages/${pkg.id}/check`)}>
          <IconRefresh size={16} />
          {m.collector_check()}
        </button>
        <button type="button" className="btn small danger" onClick={() => remove.mutate()}>
          <IconTrash size={16} />
          {m.collector_discard()}
        </button>
        <div className="spacer" />
        <button type="button" className="btn primary small" disabled={startable === 0 || start.isPending} onClick={() => start.mutate()}>
          <IconPlay size={16} />
          {!allChecked ? m.collector_startSome({ n: startable, total: online }) : offline > 0 ? m.collector_startN({ n: startable }) : m.collector_start()}
        </button>
      </div>
    </section>
  );
}

export function CollectorPage() {
  const { data: packages = [], isSuccess } = usePackages('collector');
  // Kept in this browser, so a reload does not check everything again.
  const [unchecked, setUnchecked] = useState<Unchecked>(loadUnchecked);
  useEffect(() => saveUnchecked(unchecked), [unchecked]);
  // Started, discarded or deleted: forget their checkboxes (only once the list is loaded).
  useEffect(() => {
    if (isSuccess) setUnchecked((prev) => pruneUnchecked(prev, packages));
  }, [isSuccess, packages]);
  const uncheckedOf = (p: Package) => unchecked.get(p.id) ?? new Set<number>();
  const someUnchecked = packages.some((p) => p.downloads.some((d) => uncheckedOf(p).has(d.id)));
  const startAll = useMutation({
    mutationFn: async () => {
      for (const p of packages) {
        if (p.downloads.every((d) => uncheckedOf(p).has(d.id))) continue;
        await startPackage(p, uncheckedOf(p));
      }
    },
    onSuccess: () => setUnchecked(new Map()),
  });
  const links = packages.reduce((n, p) => n + p.downloads.length, 0);
  return (
    <>
      <PageHeader
        title={m.collector_title()}
        subtitle={m.collector_subtitle({ packages: packages.length, links })}
      >
        {packages.length > 0 && (
          <button type="button" className="btn primary" onClick={() => startAll.mutate()} disabled={startAll.isPending}>
            <IconPlay size={16} />
            {someUnchecked ? m.collector_startChecked() : m.collector_startAll()}
          </button>
        )}
      </PageHeader>
      <div className="content">
        <AddLinksForm />
        {packages.map((p) => (
          <CollectedPackage
            key={p.id}
            pkg={p}
            unchecked={uncheckedOf(p)}
            setUnchecked={(s) => setUnchecked((prev) => new Map(prev).set(p.id, s))}
          />
        ))}
      </div>
    </>
  );
}
