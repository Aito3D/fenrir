export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const fold = (text: string) => text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/**
 * Token search: every whitespace-separated token must match (accent-insensitively,
 * any order) one haystack. In multi-word haystacks a token must start a word;
 * space-free haystacks (SKUs) match as plain substrings.
 */
export function createSearchMatcher(query: string): (...haystacks: (string | null | undefined)[]) => boolean {
  const tokens = fold(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return () => true;
  const wordStartRes = tokens.map((t) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(t)}`, "u"));
  return (...haystacks) => {
    const folded = haystacks.filter((h): h is string => !!h).map(fold);
    return tokens.every((t, i) => folded.some((h) => (h.includes(" ") ? wordStartRes[i].test(h) : h.includes(t))));
  };
}
