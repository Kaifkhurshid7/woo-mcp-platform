/**
 * Audit log page: every tool call with user, source, server, tool, duration and outcome (filterable).
 */
import React, { useState } from 'react';
import { api } from '../api.js';
import { Badge, ErrorNote, fmtTime, useAsync } from '../ui.jsx';

export default function Audit({ user }) {
  const isAdmin = user.role === 'admin';
  const [outcome, setOutcome] = useState('');
  const [server, setServer] = useState('');
  const [live, setLive] = useState(true);
  const qs = new URLSearchParams({ limit: '200', ...(outcome && { outcome }), ...(server && { server }) }).toString();
  const { data, error, loading, reload } = useAsync(() => api.get(`/audit?${qs}`), [qs], { every: live ? 4000 : undefined });
  const entries = data?.entries || [];

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Audit log</h1>
          <p className="muted">
            {isAdmin
              ? 'Every tool call made through the gateway, by anyone.'
              : 'Every tool call you made, from the chat or from MCP clients.'}
          </p>
        </div>
        <div className="filters">
          <input placeholder="server (e.g. woo)" value={server} onChange={(e) => setServer(e.target.value.trim())} />
          <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            <option value="">All outcomes</option>
            {['success', 'error', 'timeout', 'unreachable', 'rejected', 'rate_limited'].map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
          <label className="check">
            <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Live
          </label>
          <button className="small ghost" onClick={reload}>
            Refresh
          </button>
        </div>
      </header>
      <ErrorNote error={error} />
      <section className="card flush">
        <table className="audit">
          <thead>
            <tr>
              <th>When</th>
              {isAdmin && <th>User</th>}
              <th>Via</th>
              <th>Server</th>
              <th>Tool</th>
              <th className="right">Duration</th>
              <th>Outcome</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="nowrap">{fmtTime(e.ts)}</td>
                {isAdmin && <td>{e.user || <span className="muted">unknown</span>}</td>}
                <td>
                  <span className="tag">{e.source}</span>
                </td>
                <td>{e.server ? <code>{e.server}</code> : <span className="muted">—</span>}</td>
                <td className="mono">{e.tool || '—'}</td>
                <td className="right">{e.durationMs != null ? `${e.durationMs} ms` : '—'}</td>
                <td>
                  <Badge kind={e.outcome === 'unreachable' ? 'unreachable_call' : e.outcome} />
                </td>
                <td className="details" title={`${e.args || ''}\n${e.error || ''}`}>
                  {e.error ? <span className="why">{e.error}</span> : <span className="muted mono">{e.args || ''}</span>}
                </td>
              </tr>
            ))}
            {!loading && entries.length === 0 && (
              <tr>
                <td colSpan="8" className="muted">
                  Nothing logged yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </>
  );
}
