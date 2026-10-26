/**
 * Per-server call counts, error rate and latency, computed from the audit log.
 */
import React, { useState } from 'react';
import { api } from '../api.js';
import { ErrorNote, useAsync } from '../ui.jsx';

const WINDOWS = [
  [1, 'Last hour'],
  [24, 'Last 24 hours'],
  [168, 'Last 7 days'],
];

const pct = (x) => `${(x * 100).toFixed(x > 0 && x < 0.01 ? 1 : 0)}%`;

/** Calls, error rate and latency per upstream server, computed from the audit log. */
export default function Metrics() {
  const [hours, setHours] = useState(24);
  const { data, error } = useAsync(() => api.get(`/stats?hours=${hours}`), [hours], { every: 10000 });
  const servers = [...(data?.servers || [])].sort((a, b) => b.calls - a.calls);
  const max = Math.max(1, ...servers.map((s) => s.calls));

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Metrics</h1>
          <p className="muted">
            Tool calls, error rate and latency per server. Prometheus scrapes the same numbers from the gateway's /metrics endpoint.
          </p>
        </div>
        <select value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label="Time window">
          {WINDOWS.map(([h, label]) => (
            <option key={h} value={h}>
              {label}
            </option>
          ))}
        </select>
      </header>
      <ErrorNote error={error} />
      <section className="card flush">
        <table>
          <thead>
            <tr>
              <th>Server</th>
              <th>Calls</th>
              <th style={{ width: '30%' }} />
              <th>Error rate</th>
              <th>p50</th>
              <th>p95</th>
            </tr>
          </thead>
          <tbody>
            {servers.map((s) => (
              <tr key={s.server}>
                <td>
                  <code>{s.server}</code>
                </td>
                <td>{s.calls}</td>
                <td>
                  <div style={{ background: 'var(--soft)', borderRadius: 4, height: 8 }}>
                    <div style={{ width: `${(s.calls / max) * 100}%`, background: 'var(--brand)', borderRadius: 4, height: 8 }} />
                  </div>
                </td>
                <td className={s.errorRate > 0.1 ? 'why' : ''}>{pct(s.errorRate)}</td>
                <td>{s.p50Ms ?? '—'} ms</td>
                <td>{s.p95Ms ?? '—'} ms</td>
              </tr>
            ))}
            {data && servers.length === 0 && (
              <tr>
                <td colSpan="6" className="muted">
                  No tool calls in this window.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </>
  );
}
