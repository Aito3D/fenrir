/** The dashed "drop to create" cell at the end of a section's card row: its picker, its drop
 *  highlight, and its slot in the first-render cascade. */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../../utils';
import { NewItemDropCard } from '../../../../components/projects/files/NewItemDropCard';

const button = () => screen.getByRole('button', { name: /Drop a \.3mf or click/ });

describe('NewItemDropCard', () => {
  it('a click opens the hidden picker; the picked files go to onFiles and the input is reset so the same file can be picked again', async () => {
    const onFiles = vi.fn();
    render(<ul><NewItemDropCard section="impression" onFiles={onFiles} /></ul>);
    const input = screen.getByTestId('new-item-drop-input-impression') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    await userEvent.click(button());
    expect(click).toHaveBeenCalledTimes(1);
    const f = new File(['x'], 'lid.3mf');
    const setValue = vi.spyOn(input, 'value', 'set');
    fireEvent.change(input, { target: { files: [f] } });
    expect(onFiles).toHaveBeenCalledWith([f]);
    expect(setValue).toHaveBeenCalledWith('');
    // An empty pick (the dialog was cancelled) sends nothing.
    fireEvent.change(input, { target: { files: [] } });
    expect(onFiles).toHaveBeenCalledTimes(1);
  });

  it('highlights while a file is dragged over it and drops the files, stopping the drag at this cell', () => {
    const onFiles = vi.fn();
    const outer = vi.fn();
    render(<ul onDragOver={outer} onDrop={outer}><NewItemDropCard section="impression" onFiles={onFiles} /></ul>);
    expect(button().className).toContain('border-bambu-dark-tertiary');
    fireEvent.dragOver(button(), { dataTransfer: { types: ['Files'], files: [] } });
    expect(button().className).toContain('border-bambu-green');
    fireEvent.dragLeave(button(), { relatedTarget: document.body });
    expect(button().className).toContain('border-bambu-dark-tertiary');
    const f = new File(['x'], 'lid.3mf');
    fireEvent.drop(button(), { dataTransfer: { types: ['Files'], files: [f] } });
    expect(onFiles).toHaveBeenCalledWith([f]);
    // The section's own zone never sees the drag: the cell is the one that takes it.
    expect(outer).not.toHaveBeenCalled();
  });

  it('settles in at once by default, and joins the cascade at its slot when given one', () => {
    const { unmount } = render(<ul><NewItemDropCard section="impression" onFiles={vi.fn()} /></ul>);
    const cell = () => screen.getByTestId('new-item-drop-input-impression').parentElement as HTMLElement;
    expect(cell()).not.toHaveClass('catalog-card-in');
    expect(cell().style.getPropertyValue('--reveal-delay')).toBe('');
    unmount();
    render(<ul><NewItemDropCard section="impression" onFiles={vi.fn()} revealSlot={3} /></ul>);
    expect(cell()).toHaveClass('catalog-card-in');
    expect(cell().style.getPropertyValue('--reveal-delay')).toBe('75ms');
  });
});
