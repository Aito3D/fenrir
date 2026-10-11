import type { DragEvent } from 'react';

/** The projects dialogs' backdrop: full-screen, centred, dimmed. */
export const OVERLAY_CLS = 'fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 animate-overlay-in';

/** The projects dialogs' card (a `max-w-lg` stacked form or panel). */
export const DIALOG_CARD_CLS =
  'w-full max-w-lg space-y-4 rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary p-5 focus:outline-none';

/** One radio choice row (a `<label>` wrapping the radio) in the pickers. */
export const RADIO_ROW_CLS =
  'flex min-h-[44px] cursor-pointer items-center gap-3 rounded-lg border border-bambu-dark-tertiary px-3 py-2 text-sm text-white hover:bg-bambu-dark-tertiary has-[:checked]:border-bambu-green/60';

/** Portalled dialogs still bubble React drag events to the drop zone they were
 *  opened from: wrap them in `<div onDragOver={stopDrag} onDrop={stopDrag}>` so a
 *  stray drag over a dialog never uploads files. */
export const stopDrag = (e: DragEvent) => e.stopPropagation();
