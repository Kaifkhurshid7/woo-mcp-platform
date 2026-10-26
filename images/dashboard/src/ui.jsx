import React, { useEffect, useRef, useState } from 'react';

export const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString() : '—');
export const ago = (ts) => {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

const STATUS = {
  connected: ['ok', 'Connected'],
  unreachable: ['bad', 'Unreachable'],
  disabled: ['muted', 'Disabled'],
  checking: ['warn', 'Checking…'],
  success: ['ok', 'success'],
  error: ['bad', 'error'],
  timeout: ['warn', 'timeout'],
  unreachable_call: ['bad', 'unreachable'],
  rejected: ['bad', 'rejected'],
  rate_limited: ['warn', 'rate limited'],
};

export function Badge({ kind, children }) {
  const [tone, label] = STATUS[kind] || ['muted', kind];
  return (
    <span className={`badge ${tone}`}>
      <i />
      {children ?? label}
    </span>
  );
}

export function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const h = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function CopyBox({ value, label }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const t = document.createElement('textarea');
      t.value = value;
      document.body.appendChild(t);
      t.select();
      document.execCommand('copy');
      t.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="copybox">
      {label && <div className="copylabel">{label}</div>}
      <pre>{value}</pre>
      <button className="small" onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export function useAsync(fn, deps = [], { every } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const alive = useRef(true);
  const load = React.useCallback(async (silent) => {
    if (!silent) setState((s) => ({ ...s, loading: true }));
    try {
      const data = await fn();
      if (alive.current) setState({ data, error: null, loading: false });
    } catch (e) {
      if (alive.current) setState((s) => ({ data: silent ? s.data : null, error: e.message, loading: false }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    alive.current = true;
    load(false);
    let t;
    if (every) t = setInterval(() => load(true), every);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [load, every]);
  return { ...state, reload: () => load(true) };
}

export const ErrorNote = ({ error }) => (error ? <div className="note error">{error}</div> : null);
