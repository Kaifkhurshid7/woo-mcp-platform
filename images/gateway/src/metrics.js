// Tiny Prometheus text-format registry (counters, histograms, gauge callbacks). No dependencies.

const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const fmt = (labels) => {
  const parts = Object.entries(labels || {}).map(([k, v]) => `${k}="${esc(v)}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
};
const key = (labels) => JSON.stringify(Object.entries(labels || {}).sort());

export function createMetrics() {
  const counters = new Map(); // name -> { help, series: Map(key -> {labels, value}) }
  const histos = new Map(); // name -> { help, series: Map(key -> {labels, counts[], sum, count}) }
  const gauges = new Map(); // name -> { help, fn }

  return {
    inc(name, help, labels = {}, by = 1) {
      if (!counters.has(name)) counters.set(name, { help, series: new Map() });
      const c = counters.get(name);
      const k = key(labels);
      const s = c.series.get(k) || { labels, value: 0 };
      s.value += by;
      c.series.set(k, s);
    },
    observe(name, help, labels, seconds) {
      if (!histos.has(name)) histos.set(name, { help, series: new Map() });
      const h = histos.get(name);
      const k = key(labels);
      const s = h.series.get(k) || { labels, counts: BUCKETS.map(() => 0), sum: 0, count: 0 };
      BUCKETS.forEach((b, i) => {
        if (seconds <= b) s.counts[i]++;
      });
      s.sum += seconds;
      s.count++;
      h.series.set(k, s);
    },
    gauge(name, help, fn) {
      gauges.set(name, { help, fn });
    },
    render() {
      const out = [];
      for (const [name, c] of counters) {
        out.push(`# HELP ${name} ${c.help}`, `# TYPE ${name} counter`);
        for (const s of c.series.values()) out.push(`${name}${fmt(s.labels)} ${s.value}`);
      }
      for (const [name, h] of histos) {
        out.push(`# HELP ${name} ${h.help}`, `# TYPE ${name} histogram`);
        for (const s of h.series.values()) {
          BUCKETS.forEach((b, i) => out.push(`${name}_bucket${fmt({ ...s.labels, le: b })} ${s.counts[i]}`));
          out.push(`${name}_bucket${fmt({ ...s.labels, le: '+Inf' })} ${s.count}`);
          out.push(`${name}_sum${fmt(s.labels)} ${s.sum}`, `${name}_count${fmt(s.labels)} ${s.count}`);
        }
      }
      for (const [name, g] of gauges) {
        out.push(`# HELP ${name} ${g.help}`, `# TYPE ${name} gauge`);
        for (const s of g.fn()) out.push(`${name}${fmt(s.labels)} ${s.value}`);
      }
      return out.join('\n') + '\n';
    },
  };
}
