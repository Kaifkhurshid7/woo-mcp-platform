// Day-window helpers in an arbitrary IANA timezone, without external dependencies.

function partsInTz(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute, ss: +p.second };
}

// Offset (ms) of `tz` from UTC at the instant `date`.
function tzOffsetMs(date, tz) {
  const p = partsInTz(date, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(date.getTime() / 1000) * 1000;
}

// UTC instant of local midnight for y-m-d in tz.
function localMidnightUtc(y, m, d, tz) {
  const guess = new Date(Date.UTC(y, m - 1, d));
  return new Date(guess.getTime() - tzOffsetMs(guess, tz));
}

/**
 * Resolve "today" | "yesterday" | "YYYY-MM-DD" into a [start, end) ISO window in UTC.
 * Returns null when the input is not understood.
 */
export function resolveDateRange(input, tz = 'UTC', now = new Date()) {
  let y;
  let m;
  let d;
  const key = String(input).trim().toLowerCase();
  if (key === 'today' || key === 'yesterday') {
    const p = partsInTz(now, tz);
    const base = new Date(Date.UTC(p.y, p.m - 1, p.d - (key === 'yesterday' ? 1 : 0)));
    y = base.getUTCFullYear();
    m = base.getUTCMonth() + 1;
    d = base.getUTCDate();
  } else {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
    if (!match) return null;
    [y, m, d] = [+match[1], +match[2], +match[3]];
    const check = new Date(Date.UTC(y, m - 1, d));
    if (check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  }
  const start = localMidnightUtc(y, m, d, tz);
  const end = localMidnightUtc(y, m, d + 1, tz);
  return { start: start.toISOString(), end: end.toISOString() };
}
