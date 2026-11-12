import type { FilamentPreset } from '../../api/client';

/**
 * Derives a safe, flat ZIP entry name for a preset's stored `filename`
 * (spec §5.9 / T-029). Legacy rows created before the create/update
 * validator existed can still carry path-shaped or traversal-shaped
 * filenames (e.g. `../../x.json`); writing those straight into the archive
 * would produce entries that escape the extraction directory in extractors
 * that don't sanitise themselves. This takes the last non-empty path
 * segment (splitting on both `/` and `\`, and dropping `.`/`..` segments);
 * if nothing valid remains, it falls back to a name derived from the
 * preset's id. Already-bare filenames pass through unchanged.
 */
function deriveZipEntryName(filename: string, presetId: number): string {
  const segments = filename
    .split(/[/\\]+/)
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..');
  const last = segments[segments.length - 1];
  return last || `preset-${presetId}.json`;
}

/**
 * Returns a version of `name` guaranteed not to already be in `usedNames`,
 * suffixing deterministically (`-2`, `-3`, ...) before the extension when
 * flattening two legacy filenames collides. Mutates `usedNames` to record
 * the name it returns.
 */
function uniqueZipEntryName(name: string, usedNames: Set<string>): string {
  if (!usedNames.has(name)) {
    usedNames.add(name);
    return name;
  }
  const dotIndex = name.lastIndexOf('.');
  const base = dotIndex > 0 ? name.slice(0, dotIndex) : name;
  const ext = dotIndex > 0 ? name.slice(dotIndex) : '';
  let suffix = 2;
  let candidate = `${base}-${suffix}${ext}`;
  while (usedNames.has(candidate)) {
    suffix += 1;
    candidate = `${base}-${suffix}${ext}`;
  }
  usedNames.add(candidate);
  return candidate;
}

/** Downloads every preset that has a filename and content as one ZIP (spec §5.9). */
export async function exportPresetsZip(presets: FilamentPreset[]): Promise<void> {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const usedNames = new Set<string>();
  presets.forEach((p) => {
    zip.file(uniqueZipEntryName(deriveZipEntryName(p.filename, p.id), usedNames), p.content);
  });
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'filament-presets.zip';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
