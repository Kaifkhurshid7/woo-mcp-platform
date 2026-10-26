/**
 * Form to deploy an MCP server from a container image (admin only).
 */
import React, { useState } from 'react';
import { api } from '../api.js';
import { ErrorNote, Modal } from '../ui.jsx';

/** Deploy an MCP server from a container image into the cluster (its own namespace, Secret, limits and NetworkPolicy). */
export default function HostedForm({ onClose, onSaved }) {
  const [f, setF] = useState({ name: '', image: '', port: '3000', path: '/mcp', tokenEnv: 'MCP_AUTH_TOKEN', env: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const env = Object.fromEntries(
        f.env
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
      );
      await api.post('/hosted', { name: f.name, image: f.image, port: Number(f.port), path: f.path, tokenEnv: f.tokenEnv, env });
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Host an MCP server from an image" onClose={onClose}>
      <form onSubmit={submit} className="form">
        <ErrorNote error={error} />
        <label>
          Name
          <input value={f.name} onChange={set('name')} required placeholder="Weather tools" />
        </label>
        <label>
          Container image
          <input value={f.image} onChange={set('image')} required placeholder="woo-platform/demo-mcp:dev" />
        </label>
        <div className="row2">
          <label>
            Port
            <input value={f.port} onChange={set('port')} required inputMode="numeric" />
          </label>
          <label>
            MCP path
            <input value={f.path} onChange={set('path')} required />
          </label>
        </div>
        <label>
          Token env variable <span className="muted">(receives a generated bearer token; empty = none)</span>
          <input value={f.tokenEnv} onChange={set('tokenEnv')} placeholder="MCP_AUTH_TOKEN" />
        </label>
        <label>
          Environment <span className="muted">(one NAME=value per line)</span>
          <textarea rows={3} value={f.env} onChange={set('env')} placeholder="KIND=utils" />
        </label>
        <p className="hint">
          The platform creates a dedicated namespace with a Secret, CPU/memory limits and a NetworkPolicy that only lets the gateway call
          it, then registers it automatically.
        </p>
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Deploying…' : 'Deploy'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
