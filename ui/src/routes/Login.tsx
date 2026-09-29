import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { post } from '../api';
import { Logo } from '../components/icons';
import { LanguageSwitch } from '../components/Layout';
import { useT } from '../i18n';

export function Login({ setup }: { setup: boolean }) {
  const qc = useQueryClient();
  const t = useT();
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post(setup ? '/auth/setup' : '/auth/login', { user, password });
      await qc.invalidateQueries();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form onSubmit={submit}>
        <div className="brand" style={{ padding: 0 }}>
          <Logo />
          <div className="brand-name">Haul</div>
          <LanguageSwitch />
        </div>
        <div className="subtitle">
          {setup ? t.login.setup : t.login.title}
        </div>
        <div className="field">
          <label htmlFor="user">{t.login.userName}</label>
          <input id="user" className="input" autoComplete="username" value={user} onChange={(e) => setUser(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="password">{t.common.password}</label>
          <input
            id="password"
            className="input"
            type="password"
            autoComplete={setup ? 'new-password' : 'current-password'}
            minLength={setup ? 8 : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {setup && <span className="help">{t.login.minLength}</span>}
        </div>
        {error && <div className="notice" role="alert">{error}</div>}
        <button className="btn primary" type="submit" disabled={busy}>
          {setup ? t.login.createUser : t.login.submit}
        </button>
      </form>
    </div>
  );
}
