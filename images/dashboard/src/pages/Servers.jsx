import React, { useState } from 'react';
import { api } from '../api.js';
import { ago, Badge, ErrorNote, Modal, useAsync } from '../ui.jsx';

const EMPTY = { name: '', url: '', credType: 'none', token: '', headerName: '', headerValue: '', adminOnlyTools: '', clearCred: false };

function ServerForm({ server, onClose, onSaved }) {
  const editing = !!server;
  const [f, setF] = useState(editing ? { ...EMPTY, name: server.name, url: server.url, adminOnlyTools: server.adminOnlyTools || '', credType: 'keep', headerName: server.credentialHeader || '' } : EMPTY);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const credential = () => {
    if (f.credType === 'keep') return undefined;
    if (f.credType === 'none') return { type: 'none' };
    if (f.credType === 'bearer') return { type: 'bearer', token: f.token };
    return { type: 'header', name: f.headerName, value: f.headerValue };
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = { name: f.name, url: f.url, adminOnlyTools: f.adminOnlyTools, credential: credential() };
      if (editing) await api.put(`/servers/${server.id}`, body);
      else await api.post('/servers', body);
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={editing ? `Edit ${server.name}` : 'Add MCP server'} onClose={onClose}>
      <form onSubmit={submit} className="form">
        <ErrorNote error={error} />
        <label>Name<input value={f.name} onChange={set('name')} required placeholder="Inventory service" /></label>
        <label>MCP URL (Streamable HTTP)<input value={f.url} onChange={set('url')} required placeholder="http://my-server.my-namespace.svc:3000/mcp" /></label>
        {editing && <p className="hint">The short name <code>{server.slug}</code> prefixes its tools and cannot be changed.</p>}
        <label>Credential
          <select value={f.credType} onChange={set('credType')}>
            {editing && <option value="keep">{server.hasCredential ? `Keep current (${server.credentialType})` : 'Keep current (none)'}</option>}
            <option value="none">None</option>
            <option value="bearer">Bearer token</option>
            <option value="header">Custom header</option>
          </select>
        </label>
        {f.credType === 'bearer' && <label>Token<input type="password" value={f.token} onChange={set('token')} autoComplete="off" required /></label>}
        {f.credType === 'header' && (
          <div className="row2">
            <label>Header name<input value={f.headerName} onChange={set('headerName')} placeholder="X-Api-Key" required /></label>
            <label>Header value<input type="password" value={f.headerValue} onChange={set('headerValue')} autoComplete="off" required /></label>
          </div>
        )}
        <p className="hint">Credentials are encrypted at rest and only ever used by the gateway. They are never shown again, not even to admins.</p>
        <label>Admin-only tools <span className="muted">(optional)</span>
          <input value={f.adminOnlyTools} onChange={set('adminOnlyTools')} placeholder="create_*, update_order_status" />
        </label>
        <p className="hint">Comma-separated tool names or patterns (<code>*</code> wildcard) that members cannot see or call.</p>
        <div className="actions"><button type="button" className="ghost" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{busy ? 'Checking server…' : editing ? 'Save' : 'Add server'}</button></div>
      </form>
    </Modal>
  );
}

export default function Servers({ user }) {
  const isAdmin = user.role === 'admin';
  const { data, error, loading, reload } = useAsync(() => api.get('/servers'), [], { every: 5000 });
  const [form, setForm] = useState(null); // null | 'new' | server
  const [open, setOpen] = useState({});
  const [msg, setMsg] = useState('');

  const act = async (fn) => {
    setMsg('');
    try {
      await fn();
      reload();
    } catch (e) {
      setMsg(e.message);
    }
  };

  const servers = data?.servers || [];
  const total = servers.filter((s) => s.status === 'connected').reduce((n, s) => n + s.tools.length, 0);

  return (
    <>
      <header className="page-head">
        <div><h1>MCP servers</h1><p className="muted">{servers.length} registered · {total} tools available to your team through one endpoint</p></div>
        {isAdmin && <button className="primary" onClick={() => setForm('new')}>Add server</button>}
      </header>
      <ErrorNote error={error || msg} />
      {loading && !data && <p className="muted">Loading…</p>}
      <div className="stack">
        {servers.map((s) => (
          <section key={s.id} className={`card server ${s.status}`}>
            <div className="server-row">
              <div className="grow">
                <div className="title"><strong>{s.name}</strong><code>{s.slug}</code></div>
                {isAdmin && <div className="muted small-text mono">{s.url}</div>}
                {isAdmin && s.status === 'unreachable' && s.error && <div className="why">Why: {s.error}</div>}
              </div>
              <Badge kind={s.status} />
              <div className="meta"><span>{s.tools.length} tools</span><span>checked {ago(s.lastCheckedAt)}{s.latencyMs != null ? ` · ${s.latencyMs} ms` : ''}</span></div>
              <button className="small ghost" onClick={() => setOpen({ ...open, [s.id]: !open[s.id] })}>{open[s.id] ? 'Hide tools' : 'Tools'}</button>
              {isAdmin && (
                <div className="btns">
                  <button className="small ghost" onClick={() => act(() => api.post(`/servers/${s.id}/refresh`))}>Refresh</button>
                  <button className="small ghost" onClick={() => setForm(s)}>Edit</button>
                  <button className="small ghost" onClick={() => act(() => api.put(`/servers/${s.id}`, { enabled: !s.enabled }))}>{s.enabled ? 'Disable' : 'Enable'}</button>
                  <button className="small danger" onClick={() => window.confirm(`Remove ${s.name}? Its tools disappear for everyone.`) && act(() => api.del(`/servers/${s.id}`))}>Remove</button>
                </div>
              )}
            </div>
            {open[s.id] && (
              <ul className="tools">
                {s.tools.length === 0 && <li className="muted">{s.status === 'disabled' ? 'Disabled servers expose no tools.' : 'No tools known yet.'}</li>}
                {s.tools.map((t) => (
                  <li key={t.name}><code>{t.exposedName}</code><span>{t.description}</span></li>
                ))}
              </ul>
            )}
          </section>
        ))}
        {!loading && servers.length === 0 && <div className="card empty">No servers yet. {isAdmin ? 'Add the first one.' : 'Ask an admin to add one.'}</div>}
      </div>
      {form && <ServerForm server={form === 'new' ? null : form} onClose={() => setForm(null)} onSaved={() => (setForm(null), reload())} />}
    </>
  );
}
