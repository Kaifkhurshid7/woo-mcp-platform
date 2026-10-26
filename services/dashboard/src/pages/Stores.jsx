/**
 * Stores page: create and delete WooCommerce stores, each in its own namespace.
 */
import React, { useState } from 'react';
import { api } from '../api.js';
import { ago, ErrorNote, PhaseBadge, useAsync } from '../ui.jsx';

/**
 * Multi-store provisioning: each store is a WooCommerce store in its own Kubernetes namespace, with its own
 * database, volumes, Secrets and ingress host, connected to the gateway automatically.
 */
export default function Stores({ user, config }) {
  const { data, error, loading, reload } = useAsync(() => api.get('/stores'), [], { every: 4000 });
  const [name, setName] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const stores = data?.stores || [];

  const act = async (fn) => {
    setMsg('');
    try {
      await fn();
      reload();
    } catch (e) {
      setMsg(e.message);
    }
  };

  const create = async (e) => {
    e.preventDefault();
    setBusy(true);
    // One idempotency key per submit: a double click or a retry resolves to the same store.
    await act(() => api.post('/stores', { name }).then(() => setName('')));
    setBusy(false);
  };

  if (config && !config.provisioner) {
    return (
      <section className="card empty">Multi-store provisioning is not enabled in this installation (provisioner.enabled=false).</section>
    );
  }

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Stores</h1>
          <p className="muted">
            Create a WooCommerce store in its own namespace. Its MCP server is registered in the gateway automatically, so the chat agent
            and your MCP clients can use it as soon as it is Ready.
          </p>
        </div>
      </header>
      <section className="card">
        <h3>New store</h3>
        <form className="inline" onSubmit={create}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Store name, e.g. Acme Coffee"
            minLength={2}
            maxLength={40}
            required
          />
          <button className="primary" disabled={busy}>
            Create store
          </button>
        </form>
        <p className="hint">Each user may own a limited number of stores. Provisioning takes a few minutes (WordPress installs itself).</p>
      </section>
      <ErrorNote error={error || msg} />
      {loading && !data && <p className="muted">Loading…</p>}
      <section className="card flush">
        <table>
          <thead>
            <tr>
              <th>Store</th>
              <th>Status</th>
              <th>URL</th>
              <th>MCP server</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {stores.map((s) => (
              <tr key={s.id}>
                <td>
                  <strong>{s.name}</strong>
                  {user.role === 'admin' && <div className="muted small-text">{s.owner}</div>}
                </td>
                <td>
                  <PhaseBadge phase={s.phase} reason={s.reason} />
                </td>
                <td>
                  {s.url ? (
                    <a href={s.url} target="_blank" rel="noreferrer">
                      {s.url.replace(/^https?:\/\//, '')}
                    </a>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  <code>{s.slug}</code>
                </td>
                <td className="nowrap">{ago(s.createdAt)}</td>
                <td className="right">
                  <div className="btns">
                    {s.phase === 'Failed' && (
                      <button className="small ghost" onClick={() => act(() => api.post(`/stores/${s.id}/retry`))}>
                        Retry
                      </button>
                    )}
                    <button
                      className="small danger"
                      disabled={s.phase === 'Deleting'}
                      onClick={() =>
                        window.confirm(
                          `Delete ${s.name}? Its namespace, database, volumes, Secrets and MCP tools are removed permanently.`,
                        ) && act(() => api.del(`/stores/${s.id}`))
                      }
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!loading && stores.length === 0 && (
              <tr>
                <td colSpan="6" className="muted">
                  No stores yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </>
  );
}
