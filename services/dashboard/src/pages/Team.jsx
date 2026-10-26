/**
 * Team page: invite members, change roles, disable or remove users (admin only).
 */
import React, { useState } from 'react';
import { api } from '../api.js';
import { CopyBox, ErrorNote, fmtTime, Modal, useAsync } from '../ui.jsx';

export default function Team({ user }) {
  const users = useAsync(() => api.get('/users'), []);
  const keys = useAsync(() => api.get('/keys?all=1'), []);
  const [f, setF] = useState({ email: '', name: '', role: 'member' });
  const [err, setErr] = useState('');
  const [invite, setInvite] = useState(null);
  const [issued, setIssued] = useState(null);

  const run = async (fn) => {
    setErr('');
    try {
      return await fn();
    } catch (e) {
      setErr(e.message);
    }
  };
  const reloadAll = () => (users.reload(), keys.reload());
  const link = (token) => `${window.location.origin}/#/invite?token=${token}`;

  const doInvite = (e) => {
    e.preventDefault();
    run(async () => {
      const r = await api.post('/users', f);
      setInvite({ email: r.user.email, link: link(r.inviteToken) });
      setF({ email: '', name: '', role: 'member' });
      reloadAll();
    });
  };

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Team</h1>
          <p className="muted">Invite people, change roles and control API keys.</p>
        </div>
      </header>
      <ErrorNote error={err || users.error} />
      <section className="card">
        <h3>Invite a team member</h3>
        <form className="inline" onSubmit={doInvite}>
          <input type="email" placeholder="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />
          <input placeholder="name (optional)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
          <button className="primary">Create invite</button>
        </form>
        <p className="hint">You get a one-time invite link to send to them (no email server needed). It is valid for 7 days.</p>
      </section>
      <section className="card flush">
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Role</th>
              <th>Status</th>
              <th>Active keys</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(users.data?.users || []).map((u) => (
              <tr key={u.id} className={u.disabled ? 'dim' : ''}>
                <td>
                  <strong>{u.name || '—'}</strong>
                  <div className="muted small-text">{u.email}</div>
                </td>
                <td>
                  <select
                    value={u.role}
                    disabled={u.id === user.id}
                    onChange={(e) => run(async () => (await api.patch(`/users/${u.id}`, { role: e.target.value }), reloadAll()))}
                  >
                    <option value="member">member</option>
                    <option value="admin">admin</option>
                  </select>
                </td>
                <td>{u.disabled ? 'disabled' : u.pendingInvite ? 'invited' : 'active'}</td>
                <td>{u.activeKeys}</td>
                <td className="right btns">
                  {u.pendingInvite && (
                    <button
                      className="small ghost"
                      onClick={() =>
                        run(async () => {
                          const r = await api.post(`/users/${u.id}/invite`);
                          setInvite({ email: u.email, link: link(r.inviteToken) });
                        })
                      }
                    >
                      Invite link
                    </button>
                  )}
                  {!u.pendingInvite && !u.disabled && (
                    <button
                      className="small ghost"
                      onClick={() =>
                        run(async () => {
                          const r = await api.post('/keys', { name: 'Issued by admin', userId: u.id });
                          setIssued({ email: u.email, key: r.key });
                          reloadAll();
                        })
                      }
                    >
                      Issue key
                    </button>
                  )}
                  {u.id !== user.id && (
                    <button
                      className="small ghost"
                      onClick={() => run(async () => (await api.patch(`/users/${u.id}`, { disabled: !u.disabled }), reloadAll()))}
                    >
                      {u.disabled ? 'Enable' : 'Disable'}
                    </button>
                  )}
                  {u.id !== user.id && (
                    <button
                      className="small danger"
                      onClick={() =>
                        window.confirm(`Delete ${u.email} and all of their keys?`) &&
                        run(async () => (await api.del(`/users/${u.id}`), reloadAll()))
                      }
                    >
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="card flush">
        <h3 className="pad">All API keys</h3>
        <table>
          <thead>
            <tr>
              <th>Owner</th>
              <th>Name</th>
              <th>Key</th>
              <th>Created</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(keys.data?.keys || []).map((k) => (
              <tr key={k.id} className={k.revokedAt ? 'dim' : ''}>
                <td>{k.owner}</td>
                <td>{k.name}</td>
                <td className="mono">{k.prefix}…</td>
                <td>{fmtTime(k.createdAt)}</td>
                <td>{k.lastUsedAt ? fmtTime(k.lastUsedAt) : 'never'}</td>
                <td className="right">
                  {k.revokedAt ? (
                    <span className="muted">revoked</span>
                  ) : (
                    <button
                      className="small danger"
                      onClick={() =>
                        window.confirm(`Revoke ${k.owner}'s key "${k.name}"?`) &&
                        run(async () => (await api.del(`/keys/${k.id}`), keys.reload()))
                      }
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {invite && (
        <Modal title={`Invitation for ${invite.email}`} onClose={() => setInvite(null)}>
          <p>Send this link to the new member. It can be used once.</p>
          <CopyBox value={invite.link} />
          <div className="actions">
            <button className="primary" onClick={() => setInvite(null)}>
              Done
            </button>
          </div>
        </Modal>
      )}
      {issued && (
        <Modal title={`New key for ${issued.email}`} onClose={() => setIssued(null)}>
          <p className="note warn">Shown once. Hand it to the user over a secure channel.</p>
          <CopyBox value={issued.key} />
          <div className="actions">
            <button className="primary" onClick={() => setIssued(null)}>
              Done
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
