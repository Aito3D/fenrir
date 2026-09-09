export const CODE_LENGTH = 6;
// The server's alphabet (services/aito_tracking.py): Crockford's base32,
// no I, L, O or U. The three look-alikes it leaves out are read as the
// digits they resemble, so a client never loses to their own handwriting.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ALIASES: Record<string, string> = { I: '1', L: '1', O: '0' };

/** What a typed or pasted string means as a code: uppercased, look-alikes
 *  folded, anything else (spaces, hyphens, punctuation) dropped, cut at six.
 *  The client-side twin of the server's normalize_token, so what the
 *  squares show is exactly what the server will look up. */
export function normalizeCode(raw: string): string {
  let out = '';
  for (const ch of raw.toUpperCase()) {
    const c = ALIASES[ch] ?? ch;
    if (ALPHABET.includes(c)) out += c;
    if (out.length === CODE_LENGTH) break;
  }
  return out;
}

export type CodeState = 'idle' | 'checking' | 'found' | 'error';
