/**
 * Guard for archive external/MakerWorld links before they reach
 * `window.open` (#T-034). The backend stores `external_url` as a free-text
 * field with no scheme enforcement (github_restore.py writes it straight
 * from a backup JSON, bypassing the ArchiveUpdate schema entirely), so a
 * crafted `javascript:` or `data:` value can reach this component. This is
 * the actual security boundary -- everything upstream of it may still hand
 * back an unsafe string.
 *
 * A scheme-less value (e.g. "printables.com/model/12345", which the
 * backend now also normalises on write) is treated as shorthand for an
 * https:// URL rather than rejected, matching how a browser address bar
 * behaves. Only http:// and https:// are ever allowed through.
 */
export function toSafeExternalUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  // Any other explicit scheme (javascript:, data:, vbscript:, file:, etc.)
  // is unsafe to hand to window.open -- refuse it outright.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return null;
  }

  // No scheme at all -- normalise to https:// instead of dropping it.
  return `https://${trimmed}`;
}

/** Open an archive's external/MakerWorld link in a new tab, refusing anything
 * that isn't a normal http(s) URL. No-op if the value is unsafe or empty. */
export function openSafeExternalUrl(url: string | null | undefined): void {
  const safe = toSafeExternalUrl(url);
  if (safe) window.open(safe, '_blank');
}
