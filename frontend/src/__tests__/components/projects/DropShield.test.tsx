/**
 * DropShield: portals its children to document.body inside a bare <div> (the
 * exact element PrintRevisionFlow, TaskProjectRow and RevisionBlock rendered
 * inline before) and keeps React dragover/drop from bubbling to the drop zone
 * the dialog was opened from.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DropShield } from '../../../components/projects/DropShield';

function renderInZone() {
  const onDragOver = vi.fn();
  const onDrop = vi.fn();
  const utils = render(
    <div data-testid="zone" onDragOver={onDragOver} onDrop={onDrop}>
      <DropShield>
        <button type="button">Inside</button>
      </DropShield>
    </div>,
  );
  return { ...utils, onDragOver, onDrop };
}

describe('DropShield', () => {
  it('portals a bare div holding the children to document.body', () => {
    const { container } = renderInZone();
    const button = screen.getByRole('button', { name: 'Inside' });
    expect(container.contains(button)).toBe(false);
    const wrapper = button.parentElement as HTMLElement;
    expect(wrapper.parentElement).toBe(document.body);
    expect(wrapper.outerHTML).toBe('<div><button type="button">Inside</button></div>');
    expect(screen.getByTestId('zone').innerHTML).toBe('');
  });

  it('stops dragover and drop from reaching the outer drop zone', () => {
    const { onDragOver, onDrop } = renderInZone();
    const button = screen.getByRole('button', { name: 'Inside' });
    fireEvent.dragOver(button);
    fireEvent.drop(button);
    expect(onDragOver).not.toHaveBeenCalled();
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('lets other events bubble through the portal to the React parent', () => {
    const onClick = vi.fn();
    render(
      <div onClick={onClick}>
        <DropShield>
          <button type="button">Inside</button>
        </DropShield>
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Inside' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
