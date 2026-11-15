/**
 * Browser-side collection of preset JSON files from an <input type="file">
 * pick — the upload fallback used when the backend host has no Bambu Studio
 * install (remote deploys). Accepts plain .json files and .zip archives
 * (e.g. the page's own Export ZIP), unpacking the latter with JSZip and
 * keeping only top-level *.json entries (the export writes a flat zip).
 */
import type { BambuScanFile } from '../../api/client';

/** Read a picked File as UTF-8 text. Prefers Blob.text(), with a FileReader
 *  fallback for environments that lack it (jsdom in tests). */
export function readFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
    reader.readAsText(file);
  });
}

/** Flatten picked files into deduped {filename, content} pairs. Non-JSON,
 *  non-ZIP files are silently skipped; an empty result means the selection
 *  held nothing usable. */
export async function collectPresetFiles(picked: File[]): Promise<BambuScanFile[]> {
  const collected: BambuScanFile[] = [];
  const seen = new Set<string>();
  for (const file of picked) {
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.zip')) {
      const { default: JSZip } = await import('jszip');
      const zip = await JSZip.loadAsync(file);
      for (const entry of Object.values(zip.files)) {
        const entryLower = entry.name.toLowerCase();
        if (entry.dir || entry.name.includes('/') || !entryLower.endsWith('.json')) continue;
        if (seen.has(entry.name)) continue;
        seen.add(entry.name);
        collected.push({ filename: entry.name, content: await entry.async('string') });
      }
    } else if (lower.endsWith('.json')) {
      if (seen.has(file.name)) continue;
      seen.add(file.name);
      collected.push({ filename: file.name, content: await readFileText(file) });
    }
  }
  return collected;
}
