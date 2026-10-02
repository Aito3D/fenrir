/** Inline arithmetic for number fields: "4/2" → 2, "1247-250" → 997.
 *
 *  A small recursive-descent parser over + - * / and brackets — never `eval`.
 *  Accepts a decimal comma ("1,5"), spaces as digit grouping ("10 000") and
 *  x/X/×/÷ as operators. `literal` tells a plain number apart from a
 *  calculation, so a field can pass plain numbers through while typing and
 *  only resolve calculations when the user leaves it. */

export interface EvaluatedExpression {
  value: number;
  /** True when the text is just a number (optionally signed), not a calculation. */
  literal: boolean;
}

const MAX_LENGTH = 100;
const LITERAL_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;

function normalize(text: string): string {
  return text
    .replace(/\s/g, '') // \s covers NBSP and the narrow NBSP of fr-FR grouping
    .replace(/,/g, '.')
    .replace(/[xX×]/g, '*')
    .replace(/÷/g, '/');
}

export function evaluateExpression(text: string): EvaluatedExpression | null {
  if (text.length > MAX_LENGTH) return null;
  const src = normalize(text);
  if (src === '') return null;
  let pos = 0;

  const fail = (): never => {
    throw new SyntaxError();
  };

  const parseNumber = (): number => {
    const match = /^(\d+\.?\d*|\.\d+)/.exec(src.slice(pos));
    if (!match) fail();
    pos += match![0].length;
    return Number(match![0]);
  };

  const parseFactor = (): number => {
    const ch = src[pos];
    if (ch === '-' || ch === '+') {
      pos++;
      const inner = parseFactor();
      return ch === '-' ? -inner : inner;
    }
    if (ch === '(') {
      pos++;
      const inner = parseSum();
      if (src[pos] !== ')') fail();
      pos++;
      return inner;
    }
    return parseNumber();
  };

  const parseProduct = (): number => {
    let acc = parseFactor();
    while (src[pos] === '*' || src[pos] === '/') {
      const op = src[pos++];
      const rhs = parseFactor();
      if (op === '/' && rhs === 0) fail();
      acc = op === '*' ? acc * rhs : acc / rhs;
    }
    return acc;
  };

  function parseSum(): number {
    let acc = parseProduct();
    while (src[pos] === '+' || src[pos] === '-') {
      const op = src[pos++];
      const rhs = parseProduct();
      acc = op === '+' ? acc + rhs : acc - rhs;
    }
    return acc;
  }

  try {
    const raw = parseSum();
    if (pos !== src.length || !Number.isFinite(raw)) return null;
    // 0.1+0.2 → 0.3: drop the binary-float tail before it reaches a field.
    const value = Number(raw.toPrecision(15)) || 0;
    return { value, literal: LITERAL_RE.test(src) };
  } catch {
    return null;
  }
}
