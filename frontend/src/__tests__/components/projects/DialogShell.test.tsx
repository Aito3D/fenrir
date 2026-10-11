/**
 * DialogShell (portal + backdrop + form card) and the shared dialog styles:
 * the exact markup OrderPickerDialog and ResliceDialog rendered inline before,
 * backdrop-click close, card clicks contained, and stopDrag.
 */
import { describe, it, expect, vi } from 'vitest';
import { createRef } from 'react';
import type { DragEvent } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { DialogShell } from '../../../components/projects/DialogShell';
import { DIALOG_CARD_CLS, OVERLAY_CLS, RADIO_ROW_CLS, stopDrag } from '../../../components/projects/dialogStyles';

const OVERLAY = 'fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 animate-overlay-in';
const CARD = 'w-full max-w-lg space-y-4 rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary p-5 focus:outline-none';
const ROW =
  'flex min-h-[44px] cursor-pointer items-center gap-3 rounded-lg border border-bambu-dark-tertiary px-3 py-2 text-sm text-white hover:bg-bambu-dark-tertiary has-[:checked]:border-bambu-green/60';

function renderShell(over: Partial<{ onClose: () => void; onSubmit: () => void }> = {}) {
  const onClose = over.onClose ?? vi.fn();
  const onSubmit = over.onSubmit ?? vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
  const ref = createRef<HTMLFormElement>();
  const utils = render(
    <div data-testid="host">
      <DialogShell dialogRef={ref} title="Pick one" onClose={onClose} onSubmit={onSubmit}>
        <button type="submit">Go</button>
      </DialogShell>
    </div>,
  );
  return { ...utils, onClose, onSubmit, ref };
}

describe('dialog styles', () => {
  it('keeps the exact class strings the dialogs used inline', () => {
    expect(OVERLAY_CLS).toBe(OVERLAY);
    expect(DIALOG_CARD_CLS).toBe(CARD);
    expect(RADIO_ROW_CLS).toBe(ROW);
  });

  it('stopDrag stops propagation and nothing else', () => {
    const e = { stopPropagation: vi.fn(), preventDefault: vi.fn() };
    stopDrag(e as unknown as DragEvent);
    expect(e.stopPropagation).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('stopDrag keeps a drop on a wrapped child from reaching the outer handler', () => {
    const outer = vi.fn();
    render(
      <div onDrop={outer} onDragOver={outer}>
        <div onDragOver={stopDrag} onDrop={stopDrag}>
          <span data-testid="inner">x</span>
        </div>
      </div>,
    );
    fireEvent.dragOver(screen.getByTestId('inner'));
    fireEvent.drop(screen.getByTestId('inner'));
    expect(outer).not.toHaveBeenCalled();
  });
});

describe('DialogShell', () => {
  it('portals the exact backdrop + form markup to document.body', () => {
    const { ref, getByTestId } = renderShell();
    const dialog = screen.getByRole('dialog', { name: 'Pick one' });
    expect(getByTestId('host')).toBeEmptyDOMElement();
    expect(dialog.parentElement!.parentElement).toBe(document.body);
    expect(ref.current).toBe(dialog);
    expect(dialog.parentElement!.outerHTML).toBe(
      `<div class="${OVERLAY}"><form role="dialog" aria-modal="true" tabindex="-1" aria-label="Pick one" class="${CARD}">` +
        '<button type="submit">Go</button></form></div>',
    );
  });

  it('closes on a backdrop click, not on a click inside the card', () => {
    const { onClose } = renderShell();
    const dialog = screen.getByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(dialog.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('hands the submit to the caller', () => {
    const { onSubmit } = renderShell();
    fireEvent.submit(screen.getByRole('dialog'));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('leaves Escape to the caller', () => {
    const { onClose } = renderShell();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
