import React, { useCallback, useEffect, useState } from 'react';
import { api, setUnauthorizedHandler } from './api.js';
import { ErrorNote } from './ui.jsx';
import Servers from './pages/Servers.jsx';
import Team from './pages/Team.jsx';
import Keys from './pages/Keys.jsx';
import Audit from './pages/Audit.jsx';
import Chat from './pages/Chat.jsx';

const useHash = () => {
  const [hash, setHash] = useState(window.location.hash.slice(1) || '/servers');
  useEffect(() => {
    const h = () => setHash(window.location.hash.slice(1) || '/servers');
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);
  return hash;
};

function AuthScreen({ onSignedIn, inviteToken }) {
  const [invite, setInvite] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!inviteToken) return;
    api.get(`/auth/invite?token=${encodeURIComponent(inviteToken)}`).then((i) => (setInvite(i), setName(i.name || ''))).catch((e) => setError(e.message));
  }, [inviteToken]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = inviteToken
        ? await api.post('/auth/accept-invite', { token: inviteToken, password, name })
        : await api.post('/auth/login', { email, password });
      if (inviteToken) window.location.hash = '/servers';
      onSignedIn(res.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <form className="card auth-card" onSubmit={submit}>
        <div className="logo big">M</div>
        <h1>{inviteToken ? 'Join the gateway' : 'MCP Gateway'}</h1>
        <p className="muted">{inviteToken ? (invite ? `Set a password for ${invite.email}.` : 'Checking your invitation…') : 'Sign in to manage servers, keys and chat with your tools.'}</p>
        <ErrorNote error={error} />
        {inviteToken ? (
          invite && (
            <>
              <label>Your name<input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></label>
              <label>Password (min. 10 characters)<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required minLength={10} /></label>
            </>
          )
        ) : (
          <>
            <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required autoFocus /></label>
            <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></label>
          </>
        )}
        {(!inviteToken || invite) && <button className="primary" disabled={busy}>{busy ? 'Please wait…' : inviteToken ? 'Create account' : 'Sign in'}</button>}
      </form>
    </div>
  );
}

const NAV = [
  ['/servers', 'Servers', false],
  ['/chat', 'Chat', false],
  ['/keys', 'API keys', false],
  ['/audit', 'Audit log', false],
  ['/team', 'Team', true],
];

export default function App() {
  const hash = useHash();
  const [user, setUser] = useState(undefined); // undefined = loading, null = signed out
  const [config, setConfig] = useState(null);

  const signedOut = useCallback(() => setUser(null), []);
  useEffect(() => setUnauthorizedHandler(signedOut), [signedOut]);
  useEffect(() => {
    api.get('/auth/me').then((r) => setUser(r.user)).catch(() => setUser(null));
  }, []);
  useEffect(() => {
    if (user) api.get('/config').then(setConfig).catch(() => {});
  }, [user]);

  const inviteMatch = /^\/invite\?token=(.+)$/.exec(hash);
  if (user === undefined) return <div className="auth"><div className="muted">Loading…</div></div>;
  if (!user || inviteMatch) return <AuthScreen inviteToken={inviteMatch ? decodeURIComponent(inviteMatch[1]) : null} onSignedIn={setUser} />;

  const route = hash.split('?')[0];
  const isAdmin = user.role === 'admin';
  const Page = { '/servers': Servers, '/chat': Chat, '/keys': Keys, '/audit': Audit, '/team': Team }[route] || Servers;

  const logout = async () => {
    await api.post('/auth/logout').catch(() => {});
    setUser(null);
  };

  return (
    <div className="shell">
      <aside>
        <div className="brand"><div className="logo">M</div><div><strong>MCP Gateway</strong><span>one endpoint, every tool</span></div></div>
        <nav>
          {NAV.filter(([, , adminOnly]) => !adminOnly || isAdmin).map(([to, label]) => (
            <a key={to} href={`#${to}`} className={route === to || (route === '/' && to === '/servers') ? 'active' : ''}>{label}</a>
          ))}
        </nav>
        <div className="me">
          <div className="who"><strong>{user.name || user.email}</strong><span>{user.email}</span></div>
          <div className="role">{user.role}</div>
          <button className="small ghost" onClick={logout}>Sign out</button>
        </div>
      </aside>
      <main>
        <Page user={user} config={config} />
      </main>
    </div>
  );
}
