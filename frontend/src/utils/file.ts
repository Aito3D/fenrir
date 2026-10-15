/**
 * Formats a byte count into a human-readable string (e.g. `1.5 MB`).
 *
 * @param bytes - The number of bytes to format.
 * @returns A formatted string with the appropriate unit (B, KB, MB, GB, or TB).
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  // Clamp so fractional values below 1 B stay in the B unit instead of indexing units[-1].
  const i = Math.min(Math.max(Math.floor(Math.log(bytes) / Math.log(k)), 0), units.length - 1);

  const size = bytes / Math.pow(k, i);

  // No decimals for bytes, 1 decimal for larger units
  return i === 0
    ? `${size} ${units[i]}`
    : `${size.toFixed(1)} ${units[i]}`;
}
