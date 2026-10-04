/** String normalisation for the Aito board search. Pure, no React. */

/** Lowercase and strip combining marks, so `camera` finds `caméra` — applied
 *  to both the query and the card text. */
export function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

/** `fold`, plus where each folded character came from, so a match found in
 *  folded text can be highlighted in the original. Folds one code point at
 *  a time; a code point that folds to several characters maps them all to
 *  its own index. */
export function foldWithMap(value: string): { text: string; map: number[] } {
  let text = '';
  const map: number[] = [];
  for (let i = 0; i < value.length; ) {
    const char = String.fromCodePoint(value.codePointAt(i)!);
    const folded = fold(char);
    for (let k = 0; k < folded.length; k++) map.push(i);
    text += folded;
    i += char.length;
  }
  return { text, map };
}

export function digits(value: string): string {
  return value.replace(/\D/g, '');
}

/** French Polynesia numbers are 8 digits; a longer one starting with the 689
 *  country code is the same number dialled from abroad. */
export function phoneDigits(value: string): string {
  const all = digits(value);
  return all.length > 8 && all.startsWith('689') ? all.slice(3) : all;
}

/** Folded letters and digits only: `DEV-00123` → `dev00123`. */
export function alnum(value: string): string {
  return fold(value).replace(/[^a-z0-9]/g, '');
}

export function stripZeros(value: string): string {
  return value.replace(/^0+(?=\d)/, '');
}

/** The last run of digits, leading zeros dropped: what people read out of a
 *  document number (`INV-000123` → `123`). '' when there is none. */
export function numericTail(value: string): string {
  const match = /(\d+)\D*$/.exec(value);
  return match ? stripZeros(match[1]) : '';
}

/** Optimal-string-alignment distance ≤ 1: one insertion, deletion,
 *  substitution or adjacent swap. */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  if (a.length === b.length) {
    while (i < a.length && a[i] === b[i]) i++;
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return i + 1 < a.length && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  while (i < short.length && short[i] === long[i]) i++;
  return short.slice(i) === long.slice(i + 1);
}
