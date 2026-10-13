/**
 * DialogShell (portal + backdrop + form card) and the shared dialog styles:
 * the structure OrderPickerDialog and ResliceDialog rely on (a modal form
 * dialog portalled to <body> over a full-screen backdrop), which element wears
 * which shared style, backdrop-click close, card clicks contained, and stopDrag.
 * Class strings are not re-stated: only the tokens that carry a behavior
 * (covers the screen, stacks above the page, centres, touch-target height) are.
 */
import { describe, it, expect, vi } from 'vitest';
import { createRef } from 'react';
import type { DragEvent } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { DialogShell } from '../../../components/projects/DialogShell';
import { DIALOG_CARD_CLS, OVERLAY_CLS, RADIO_ROW_CLS, stopDrag } from '../../../components/projects/dialogStyles';

const tokens = (cls: string) => cls.split(' ');

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
  it('the backdrop covers the viewport above the page and centres its card', () => {
    expect(tokens(OVERLAY_CLS)).toEqual(
      expect.arrayContaining(['fixed', 'inset-0', 'z-50', 'flex', 'items-center', 'justify-center']),
    );
  });

  it('the card is full-width up to a cap and drops the focus outline it takes programmatically', () => {
    expect(tokens(DIALOG_CARD_CLS)).toEqual(expect.arrayContaining(['w-full', 'focus:outline-none']));
    expect(tokens(DIALOG_CARD_CLS).some((t) => t.startsWith('max-w-'))).toBe(true);
  });

  it('a radio row is a 44px touch target, clickable as a whole, marked when its radio is checked', () => {
    const row = tokens(RADIO_ROW_CLS);
    expect(row).toEqual(expect.arrayContaining(['min-h-[44px]', 'cursor-pointer']));
    expect(row.some((t) => t.startsWith('has-[:checked]:'))).toBe(true);
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
  it('portals a modal form dialog, inside its backdrop, to document.body', () => {
    const { ref, getByTestId } = renderShell();
    const dialog = screen.getByRole('dialog', { name: 'Pick one' });
    expect(getByTestId('host')).toBeEmptyDOMElement();
    expect(dialog.parentElement!.parentElement).toBe(document.body);
    expect(ref.current).toBe(dialog);
    // A <form>, so Enter in a field and the submit button go through onSubmit.
    expect(dialog.tagName).toBe('FORM');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-label', 'Pick one');
    // Programmatically focusable (the caller focuses it), but out of the tab order.
    expect(dialog).toHaveAttribute('tabindex', '-1');
    dialog.focus();
    expect(dialog).toHaveFocus();
    // The children render inside the card, and the card is the backdrop's only child.
    expect(within(dialog).getByRole('button', { name: 'Go' })).toBeInTheDocument();
    expect(dialog.parentElement!.children).toHaveLength(1);
  });

  it('the backdrop wears the overlay style and the form the card style', () => {
    renderShell();
    const dialog = screen.getByRole('dialog', { name: 'Pick one' });
    const backdrop = dialog.parentElement!;
    expect(backdrop).toHaveClass(...tokens(OVERLAY_CLS));
    expect(dialog).toHaveClass(...tokens(DIALOG_CARD_CLS));
    expect(backdrop).not.toHaveClass(...tokens(DIALOG_CARD_CLS));
    expect(dialog).not.toHaveClass('fixed', 'inset-0');
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
