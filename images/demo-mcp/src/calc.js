// Tiny safe arithmetic evaluator (no eval). Supports + - * / % ^ ( ), unary minus, decimals,
// and a few constants/functions. Throws on anything else.

const FUNCS = { sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil };
const CONSTS = { pi: Math.PI, e: Math.E };

export function calculate(input) {
  const src = String(input);
  if (src.length > 200) throw new Error('Expression too long');
  let i = 0;
  const peek = () => src[i];
  const skip = () => {
    while (src[i] === ' ') i++;
  };

  function number() {
    skip();
    const m = /^\d+(\.\d+)?|^\.\d+/.exec(src.slice(i));
    if (!m) throw new Error(`Unexpected "${src[i] ?? 'end of input'}" at position ${i}`);
    i += m[0].length;
    return parseFloat(m[0]);
  }

  function primary() {
    skip();
    const c = peek();
    if (c === '(') {
      i++;
      const v = expr();
      skip();
      if (peek() !== ')') throw new Error('Missing closing parenthesis');
      i++;
      return v;
    }
    if (c === '-') {
      i++;
      return -power();
    }
    if (c === '+') {
      i++;
      return power();
    }
    const id = /^[a-z]+/i.exec(src.slice(i));
    if (id) {
      const name = id[0].toLowerCase();
      i += name.length;
      if (name in CONSTS) return CONSTS[name];
      if (name in FUNCS) {
        skip();
        if (peek() !== '(') throw new Error(`${name} needs parentheses`);
        i++;
        const v = expr();
        skip();
        if (peek() !== ')') throw new Error('Missing closing parenthesis');
        i++;
        return FUNCS[name](v);
      }
      throw new Error(`Unknown identifier "${name}"`);
    }
    return number();
  }

  function power() {
    const base = primary();
    skip();
    if (peek() === '^') {
      i++;
      return Math.pow(base, power());
    }
    return base;
  }

  function term() {
    let v = power();
    for (;;) {
      skip();
      const c = peek();
      if (c === '*') {
        i++;
        v *= power();
      } else if (c === '/') {
        i++;
        const d = power();
        if (d === 0) throw new Error('Division by zero');
        v /= d;
      } else if (c === '%') {
        i++;
        const d = power();
        if (d === 0) throw new Error('Division by zero');
        v %= d;
      } else return v;
    }
  }

  function expr() {
    let v = term();
    for (;;) {
      skip();
      const c = peek();
      if (c === '+') {
        i++;
        v += term();
      } else if (c === '-') {
        i++;
        v -= term();
      } else return v;
    }
  }

  const result = expr();
  skip();
  if (i < src.length) throw new Error(`Unexpected "${src[i]}" at position ${i}`);
  if (!Number.isFinite(result)) throw new Error('Result is not a finite number');
  return Number(result.toPrecision(12)); // hide binary floating-point noise (11.799999999999999 -> 11.8)
}
