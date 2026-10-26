import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Badge } from '../ui.jsx';

const SUGGESTIONS = [
  'List the products in the store',
  'Create a product called "Filter Coffee 250g" priced at 349',
  'What orders came in today?',
  'Find the price of the Filter Coffee product and add 18% GST to it',
];

function ToolTrace({ calls }) {
  const [open, setOpen] = useState(null);
  return (
    <div className="trace">
      <div className="trace-title">Tools called</div>
      {calls.map((c, i) => (
        <div key={i} className={`call ${c.isError ? 'err' : ''}`}>
          <button className="callhead" onClick={() => setOpen(open === i ? null : i)}>
            <code>{c.name}</code>
            <Badge kind={c.isError ? 'error' : 'success'} />
          </button>
          {open === i && (
            <div className="calldetail">
              <div className="muted small-text">Arguments</div>
              <pre>{JSON.stringify(c.args, null, 2)}</pre>
              <div className="muted small-text">Result</div>
              <pre>{c.output}</pre>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default function Chat({ config }) {
  const [msgs, setMsgs] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef(null);
  useEffect(() => end.current?.scrollIntoView({ behavior: 'smooth' }), [msgs, busy]);
  const llm = config?.llm;

  const send = async (text) => {
    const message = (text ?? input).trim();
    if (!message || busy) return;
    setInput('');
    const history = msgs.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content }));
    setMsgs((m) => [...m, { role: 'user', content: message }]);
    setBusy(true);
    try {
      const r = await api.post('/chat', { message, history });
      setMsgs((m) => [...m, { role: 'assistant', content: r.reply, toolCalls: r.toolCalls }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: 'assistant', content: e.message, error: true }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="chat">
      <header className="page-head">
        <div><h1>Chat</h1><p className="muted">Ask in plain language. The agent calls your team's tools through the gateway, as you, so every call shows up in the audit log under your name.</p></div>
        {msgs.length > 0 && <button className="small ghost" onClick={() => setMsgs([])}>Clear</button>}
      </header>
      {llm && !llm.configured && <div className="note warn">The chat model is not configured: {llm.reason}</div>}
      <div className="thread card">
        {msgs.length === 0 && (
          <div className="empty-chat">
            <p className="muted">Try one of these{llm?.configured ? ` (model: ${llm.provider}/${llm.model})` : ''}:</p>
            {SUGGESTIONS.map((s) => <button key={s} className="suggest" onClick={() => send(s)} disabled={!llm?.configured}>{s}</button>)}
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role} ${m.error ? 'error' : ''}`}>
            <div className="bubble">{m.content}</div>
            {m.toolCalls?.length > 0 && <ToolTrace calls={m.toolCalls} />}
          </div>
        ))}
        {busy && <div className="msg assistant"><div className="bubble typing"><span /><span /><span /></div></div>}
        <div ref={end} />
      </div>
      <form className="composer" onSubmit={(e) => (e.preventDefault(), send())}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={llm?.configured ? 'Ask about products, orders, notes…' : 'Chat model not configured'} disabled={busy || !llm?.configured} autoFocus />
        <button className="primary" disabled={busy || !input.trim() || !llm?.configured}>Send</button>
      </form>
    </div>
  );
}
