import { useEffect, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { api, post, type Package } from '../api';
import { PageHeader, usePackages } from '../components/Layout';
import { IconPlay, IconRefresh, IconTrash } from '../components/icons';
import { describe, toneColor } from '../components/status';
import { bytes } from '../format';

function AddLinksForm() {
  const navigate = useNavigate();
  const [links, setLinks] = useState('');
  const [packageName, setPackageName] = useState('');
  const [targetDir, setTargetDir] = useState('');
  const [passwords, setPasswords] = useState('');
  const [start, setStart] = useState(false);
  const add = useMutation({
    mutationFn: () => post<{ packageId: number }>('/links', { links, packageName, targetDir, passwords, start }),
    onSuccess: () => {
      setLinks('');
      setPackageName('');
      setTargetDir('');
      setPasswords('');
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
      <h2>Links einfügen</h2>
      <div className="field">
        <label htmlFor="links">Links, einer pro Zeile oder beliebig gemischter Text</label>
        <textarea
          id="links"
          className="textarea"
          placeholder={'https://ddownload.com/abc123def456\nhttps://example.org/datei.iso'}
          value={links}
          onChange={(e) => setLinks(e.target.value)}
          required
        />
      </div>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="pkg">Paketname</label>
          <input id="pkg" className="input" placeholder="aus Dateinamen ableiten" value={packageName} onChange={(e) => setPackageName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="dir">Zielordner (relativ zu fertig)</label>
          <input id="dir" className="input" placeholder="= Paketname" value={targetDir} onChange={(e) => setTargetDir(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="pw">Archiv-Passwörter, eines pro Zeile</label>
        <textarea id="pw" className="textarea" style={{ minHeight: 64 }} value={passwords} onChange={(e) => setPasswords(e.target.value)} />
      </div>
      {add.error && <div className="notice" role="alert">{add.error.message}</div>}
      <div className="toolbar">
        <label className="checkbox">
          <input type="checkbox" checked={start} onChange={(e) => setStart(e.target.checked)} />
          Direkt starten, ohne Linksammler
        </label>
        <div className="spacer" />
        <button type="submit" className="btn primary" disabled={add.isPending || count === 0}>
          {count > 0 ? `${count} ${count === 1 ? 'Link' : 'Links'} hinzufügen` : 'Links hinzufügen'}
        </button>
      </div>
    </form>
  );
}

function CollectedPackage({ pkg }: { pkg: Package }) {
  const [name, setName] = useState(pkg.name);
  const [targetDir, setTargetDir] = useState(pkg.targetDir);
  useEffect(() => {
    setName(pkg.name);
    setTargetDir(pkg.targetDir);
  }, [pkg.name, pkg.targetDir]);

  const save = useMutation({ mutationFn: (body: object) => api(`/packages/${pkg.id}`, { method: 'PATCH', body }) });
  const act = useMutation({ mutationFn: (path: string) => post(path) });
  const remove = useMutation({ mutationFn: () => api(`/packages/${pkg.id}`, { method: 'DELETE' }) });

  const total = pkg.downloads.reduce((n, d) => n + (d.size ?? 0), 0);
  const offline = pkg.downloads.filter((d) => d.online === 'offline').length;
  const startable = pkg.downloads.length - offline;

  return (
    <section className="card" aria-label={`Paket ${pkg.name}`}>
      <div className="grid-2">
        <div className="field">
          <label htmlFor={`name-${pkg.id}`}>Paketname</label>
          <input
            id={`name-${pkg.id}`}
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name !== pkg.name && save.mutate({ name })}
          />
        </div>
        <div className="field">
          <label htmlFor={`dir-${pkg.id}`}>Zielordner</label>
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
        {pkg.source === 'cnl' ? "Click'n'Load" : 'manuell'}
        {pkg.sourcePage && (
          <>
            {' '}
            von <span className="mono">{pkg.sourcePage}</span>
          </>
        )}
        {' · '}
        {pkg.downloads.length} Dateien · {bytes(total)}
        {pkg.hasPasswords && ' · mit Passwort'}
        {offline > 0 && <span style={{ color: 'var(--err)' }}> · {offline} offline</span>}
      </div>
      <div className="list">
        {pkg.downloads.map((d) => {
          const s = describe(d);
          return (
            <div className="list-row" key={d.id}>
              <div className="grow">
                <span className="cell-name">{d.name}</span>
                <span className="sub mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {d.url}
                </span>
              </div>
              <span className="pill">{d.pluginId ?? 'http'}</span>
              <span className="cell-mono" style={{ width: 80 }}>{bytes(d.size)}</span>
              <div className="status" style={{ color: toneColor[s.tone].color, width: 140 }} title={d.error ?? s.label}>
                <span className="dot" style={{ background: toneColor[s.tone].color }} />
                <span>{s.label}</span>
              </div>
              <button type="button" className="icon-btn" aria-label={`${d.name} entfernen`} onClick={() => api(`/downloads/${d.id}`, { method: 'DELETE' })}>
                <IconTrash size={16} />
              </button>
            </div>
          );
        })}
      </div>
      <div className="toolbar">
        <button type="button" className="btn small" onClick={() => act.mutate(`/packages/${pkg.id}/check`)}>
          <IconRefresh size={16} />
          Online-Check
        </button>
        <button type="button" className="btn small danger" onClick={() => remove.mutate()}>
          <IconTrash size={16} />
          Verwerfen
        </button>
        <div className="spacer" />
        <button type="button" className="btn primary small" disabled={startable === 0} onClick={() => act.mutate(`/packages/${pkg.id}/start`)}>
          <IconPlay size={16} />
          {offline > 0 ? `${startable} starten` : 'Starten'}
        </button>
      </div>
    </section>
  );
}

export function CollectorPage() {
  const { data: packages = [] } = usePackages('collector');
  const startAll = useMutation({
    mutationFn: async () => {
      for (const p of packages) await post(`/packages/${p.id}/start`);
    },
  });
  const links = packages.reduce((n, p) => n + p.downloads.length, 0);
  return (
    <>
      <PageHeader
        title="Linksammler"
        subtitle={`${packages.length} ${packages.length === 1 ? 'Paket' : 'Pakete'} · ${links} Links · Click'n'Load landet hier und startet nie automatisch`}
      >
        {packages.length > 0 && (
          <button type="button" className="btn primary" onClick={() => startAll.mutate()}>
            <IconPlay size={16} />
            Alle starten
          </button>
        )}
      </PageHeader>
      <div className="content">
        <AddLinksForm />
        {packages.map((p) => (
          <CollectedPackage key={p.id} pkg={p} />
        ))}
      </div>
    </>
  );
}
