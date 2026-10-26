import React, { useState } from 'react';
import { api } from '../api.js';
import { CopyBox, ErrorNote, fmtTime, Modal, useAsync } from '../ui.jsx';

function Snippets({ url, apiKey }) {
  const claude = `claude mcp add --transport http team-gateway ${url} --header "Authorization: Bearer ${apiKey}"`;
  const cursor = JSON.stringify({ mcpServers: { 'team-gateway': { url, headers: { Authorization: `Bearer ${apiKey}` } } } }, null, 2);
  const inspector = `npx @modelcontextprotocol/inspector\n# Transport: Streamable HTTP\n# URL: ${url}\n# Header: Authorization = Bearer ${apiKey}`;
  return (
    <div className="stack">
      <CopyBox label="Claude Code" value={claude} />
      <CopyBox label="Cursor (.cursor/mcp.json)" value={cursor} />
      <CopyBox label="MCP Inspector" value={inspector} />
    </div>
  );
}

export default function Keys({ config }) {
  const { data, error, reload } = useAsync(() => api.get('/keys'), []);
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState(null);
  const [err, setErr] = useState('');
  const url = config?.mcpUrl || `${window.location.origin}/mcp`;

  const create = async (e) => {
    e.preventDefault();
    setErr('');
    try {
      const r = await api.post('/keys', { name });
      setFresh(r.key);
      setName('');
      reload();
    } catch (e2) {
      setErr(e2.message);
    }
  };
  const revoke = async (k) => {
    if (!window.confirm(`Revoke "${k.name}"? Clients using it will be rejected immediately.`)) return;
    try {
      await api.del(`/keys/${k.id}`);
      reload();
    } catch (e2) {
      setErr(e2.message);
    }
  };

  return (
    <>
      <header className="page-head"><div><h1>API keys</h1><p className="muted">Use your own key to connect Claude Code, Cursor or any MCP client to every enabled server. Nothing else to configure.</p></div></header>
      <section className="card">
        <h3>Gateway endpoint</h3>
        <CopyBox value={url} />
      </section>
      <section className="card">
        <h3>Create a key</h3>
        <form className="inline" onSubmit={create}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Claude Code on my laptop" maxLength={80} />
          <button className="primary">Generate key</button>
        </form>
        <ErrorNote error={err || error} />
      </section>
      <section className="card">
        <h3>Your keys</h3>
        <table>
          <thead><tr><th>Name</th><th>Key</th><th>Created</th><th>Last used</th><th /></tr></thead>
          <tbody>
            {(data?.keys || []).map((k) => (
              <tr key={k.id} className={k.revokedAt ? 'dim' : ''}>
                <td>{k.name}</td><td className="mono">{k.prefix}…</td><td>{fmtTime(k.createdAt)}</td><td>{k.lastUsedAt ? fmtTime(k.lastUsedAt) : 'never'}</td>
                <td className="right">{k.revokedAt ? <span className="muted">revoked</span> : <button className="small danger" onClick={() => revoke(k)}>Revoke</button>}</td>
              </tr>
            ))}
            {data && data.keys.length === 0 && <tr><td colSpan="5" className="muted">No keys yet.</td></tr>}
          </tbody>
        </table>
      </section>
      {fresh && (
        <Modal title="Your new API key" onClose={() => setFresh(null)} wide>
          <p className="note warn">Copy it now. For your security only a hash is stored, so this key cannot be shown again.</p>
          <CopyBox label="API key" value={fresh} />
          <h3>Connect a client</h3>
          <Snippets url={url} apiKey={fresh} />
          <div className="actions"><button className="primary" onClick={() => setFresh(null)}>Done</button></div>
        </Modal>
      )}
    </>
  );
}
