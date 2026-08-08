/** The hold-to-restore button's recipe, shared by `DoneGrid` and `TrashGrid`.
 *
 *  Both archives restore a card with the same gray-icon-that-goes-white hold
 *  button and the same 500ms hold; only the label text differs (finish vs.
 *  delete undo), so that stays a call-site prop while the rest is one recipe. */
export const restoreButtonCls =
  'p-1 -m-1 text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary focus-visible:ring-bambu-green/40 data-[holding=true]:text-white';

export const restoreHoldDurationMs = 500;
