import { useRef, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';

import { api } from '../../api/client';
import type { BambuScanFile, FilamentPreset, FilamentPresetPayload } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { collectPresetFiles } from './pickedFiles';
import { displayColorLabel, displayMaterial, errorMessage, parseColorFromContent } from './presetJson';

/** The page's import flows: the server-side Bambu Studio folder scan, and files picked or dropped in the browser. */
export function usePresetImport(presets: FilamentPreset[]) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast, showPersistentToast, dismissToast } = useToast();
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Import from disk (spec §5.7) ────────────────────────────────────────
  // Shared import core for both sources of preset files: the server-side
  // Bambu Studio folder scan and the browser file-picker fallback below.
  // Dedupe against loaded presets, then strictly sequential POSTs with a
  // progress toast — semantics must stay identical for both paths.
  const importPresetFiles = async (files: BambuScanFile[]) => {
    const existingFilenames = new Set(presets.map((p) => p.filename));
    const newFiles = files.filter((f) => !existingFilenames.has(f.filename));

    if (newFiles.length === 0) {
      showToast(t('filamentProfiles.allImported', { n: files.length }));
      return;
    }

    showPersistentToast('fp-import', t('filamentProfiles.importing', { current: 0, total: newFiles.length }), 'loading');
      try {
        let ok = 0;
        let failed = 0;
        for (let i = 0; i < newFiles.length; i++) {
          const file = newFiles[i];
          let payload: FilamentPresetPayload;
          try {
            const parsed = JSON.parse(file.content) as Record<string, unknown>;
            const vendor = Array.isArray(parsed.filament_vendor) ? parsed.filament_vendor[0] : undefined;
            const type = Array.isArray(parsed.filament_type) ? parsed.filament_type[0] : undefined;
            // Bambu Studio writes the colour as `default_filament_colour`;
            // parseColorFromContent reads that (and the older
            // `filament_colour`) and normalizes it to a CSS hex — the earlier
            // read of only `filament_colour` is why every imported preset's
            // swatch came out gray.
            const name = typeof parsed.name === 'string' && parsed.name ? parsed.name : file.filename.replace(/\.json$/, '');
            payload = {
              name,
              brand: vendor ? String(vendor) : '',
              // Presets that inherit `filament_type` still name their material: "Brand Material - Colour".
              material: type ? String(type) : vendor ? displayMaterial(name, String(vendor), '').replace('—', '') : '',
              // Slicer presets carry no separate label field — the label is
              // the part of the NAME after ' - ' ("eSUN PETG - Green").
              color: displayColorLabel(name, ''),
              color_hex: parseColorFromContent(file.content),
              filename: file.filename,
              content: file.content,
            };
          } catch {
            payload = {
              name: file.filename.replace(/\.json$/, ''),
              brand: '',
              material: '',
              color: '',
              color_hex: '',
              filename: file.filename,
              content: file.content,
            };
          }

          try {
            // Sequential and awaited — each POST must land before the next
            // starts (dedupe + progress-toast semantics depend on it).
            await api.createFilamentPreset(payload);
            ok += 1;
          } catch {
            failed += 1;
          }

          showPersistentToast(
            'fp-import',
            t('filamentProfiles.importing', { current: i + 1, total: newFiles.length }),
            'loading',
          );
        }

        if (failed === 0) {
          showToast(t('filamentProfiles.imported', { n: ok }));
        } else {
          showToast(t('filamentProfiles.importPartial', { ok, failed }), 'error');
        }
        await queryClient.invalidateQueries({ queryKey: ['filamentPresets'] });
      } finally {
        dismissToast('fp-import');
      }
  };

  const handleImport = async () => {
    if (importing) return;
    setImporting(true);
    try {
      // Only the scan call's failure is a "scanFailed" toast — per-file
      // create failures are counted and reported separately inside
      // importPresetFiles, and must never be mislabeled as a folder-read
      // error.
      let scanResult: { files: BambuScanFile[] };
      try {
        scanResult = await api.scanBambuStudioPresets();
      } catch (err) {
        showToast(t('filamentProfiles.scanFailed', { error: errorMessage(err) }), 'error');
        return;
      }

      if (scanResult.files.length === 0) {
        // Remote-deploy case: the backend host has no Bambu Studio install,
        // so the folder scan legitimately finds nothing. Fall back to a
        // browser-side file picker so the JSONs can come from the client
        // machine instead of the server's filesystem.
        showToast(t('filamentProfiles.noServerPresets'), 'info');
        fileInputRef.current?.click();
        return;
      }

      await importPresetFiles(scanResult.files);
    } finally {
      setImporting(false);
    }
  };

  // ── Import from browser files: the picker fallback, or a drop on the page ──
  const importFiles = async (files: File[]) => {
    if (files.length === 0 || importing) return;
    setImporting(true);
    try {
      const collected = await collectPresetFiles(files);

      if (collected.length === 0) {
        showToast(t('filamentProfiles.noJsonInSelection'), 'error');
        return;
      }

      await importPresetFiles(collected);
    } catch (err) {
      showToast(errorMessage(err), 'error');
    } finally {
      setImporting(false);
    }
  };

  const handleFilesSelected = (event: ChangeEvent<HTMLInputElement>) => {
    // Snapshot the live FileList before resetting the input — clearing
    // `value` empties `files`, and the reset is what lets picking the same
    // file(s) again re-fire the change event.
    const pickedFiles = Array.from(event.target.files ?? []);
    event.target.value = '';
    return importFiles(pickedFiles);
  };

  return { importing, fileInputRef, handleImport, handleFilesSelected, importFiles };
}
