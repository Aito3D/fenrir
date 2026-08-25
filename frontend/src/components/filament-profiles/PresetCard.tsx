import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MoreVertical, Pencil, Copy, Trash2 } from 'lucide-react';

import type { FilamentPreset } from '../../api/client';
import {
  parsePresetChips,
  parseNozzleFromCompatible,
  displayMaterial,
  displayColorLabel,
  parseColorFromContent,
} from './presetJson';
import { materialFamilyClass } from './constants';

export interface PresetCardProps {
  preset: FilamentPreset;
  onOpen: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

/**
 * Horizontal card for a single filament preset: color swatch strip, brand/material/color
 * summary, spec chips parsed from the raw preset JSON, and a hover-revealed action menu.
 */
export function PresetCard({ preset, onOpen, onEdit, onDuplicate, onDelete }: PresetCardProps) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [menuOpen]);

  const chips = parsePresetChips(preset.content);
  const hasChips = !!chips && (chips.temp !== undefined || chips.flow !== undefined || chips.pa !== undefined);
  const nozzle = parseNozzleFromCompatible(preset.content);
  const material = displayMaterial(preset.name, preset.brand, preset.material);
  // The stored column when the editor filled it; otherwise the colour lives
  // only inside the imported preset's JSON (`default_filament_colour`).
  const swatchColor = preset.color_hex || parseColorFromContent(preset.content);
  const colorLabel = displayColorLabel(preset.name, preset.color);

  const handleMenuToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen((open) => !open);
  };

  const handleEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(false);
    onEdit();
  };

  const handleDuplicate = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(false);
    onDuplicate();
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(false);
    onDelete();
  };

  return (
    <div
      onClick={onOpen}
      className={`relative flex min-h-24 cursor-pointer group rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary transition-all hover:-translate-y-0.5 hover:shadow-lg hover:border-bambu-green/60 ${menuOpen ? 'z-20' : ''}`}
    >
      <div
        className="w-16 shrink-0 rounded-l-xl"
        style={{ backgroundColor: swatchColor || '#444' }}
        title={swatchColor}
      />
      <div className="flex flex-1 min-w-0 items-center justify-between gap-2 px-4 py-2">
        <div className="min-w-0 flex-1">
          {preset.brand !== '' && (
            <div className="text-xs font-bold uppercase tracking-wide text-bambu-gray/60">{preset.brand}</div>
          )}
          <div className={`truncate font-bold ${materialFamilyClass(material)}`}>{material}</div>
          {colorLabel !== '' && <div className="truncate text-sm text-bambu-gray-light">{colorLabel}</div>}
          {hasChips && (
            <div className="mt-1 flex flex-wrap items-center gap-1.5 font-mono text-xs">
              {chips!.temp !== undefined && (
                <span className="rounded bg-rose-500/10 px-1.5 py-0.5 text-rose-300">{chips!.temp}°C</span>
              )}
              {chips!.flow !== undefined && (
                <span className="rounded bg-sky-500/10 px-1.5 py-0.5 text-sky-300">×{chips!.flow}</span>
              )}
              {chips!.pa !== undefined && (
                <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-300">PA {chips!.pa}</span>
              )}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-start gap-1">
          {nozzle !== null && (
            <span className="rounded bg-bambu-green/10 px-1.5 py-0.5 font-mono text-xs text-bambu-green">
              ⌀{nozzle}mm
            </span>
          )}
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={handleMenuToggle}
              aria-label={t('filamentProfiles.menu')}
              className="rounded p-1 text-bambu-gray/60 opacity-0 transition-opacity hover:bg-bambu-dark-tertiary hover:text-white focus:opacity-100 group-hover:opacity-100"
            >
              <MoreVertical className="h-4 w-4" />
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-full z-30 mt-1 w-36 overflow-hidden rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary shadow-lg">
                <button
                  type="button"
                  onClick={handleEdit}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-white hover:bg-bambu-dark-tertiary"
                >
                  <Pencil className="h-3.5 w-3.5" />
                  {t('filamentProfiles.edit')}
                </button>
                <button
                  type="button"
                  onClick={handleDuplicate}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-white hover:bg-bambu-dark-tertiary"
                >
                  <Copy className="h-3.5 w-3.5" />
                  {t('filamentProfiles.duplicate')}
                </button>
                <div className="border-t border-bambu-dark-tertiary" />
                <button
                  type="button"
                  onClick={handleDelete}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-400 hover:bg-bambu-dark-tertiary"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t('filamentProfiles.delete')}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
