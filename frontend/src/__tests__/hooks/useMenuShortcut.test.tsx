/**
 * Tests for the useMenuShortcut hook: a bare key opens a menu unless the
 * operator is typing.
 */

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useMenuShortcut } from '../../hooks/useMenuShortcut';

function Host({ enabled, open }: { enabled: boolean; open: () => void }) {
  useMenuShortcut('.', enabled, open);
  return (
    <div>
      <textarea aria-label="Notes" />
      <button type="button">Other</button>
    </div>
  );
}

describe('useMenuShortcut', () => {
  it('opens on the key when nothing editable has focus', () => {
    const open = vi.fn();
    render(<Host enabled open={open} />);
    fireEvent.keyDown(document.body, { key: '.' });
    expect(open).toHaveBeenCalledOnce();
  });

  it('opens while a button has focus', () => {
    const open = vi.fn();
    render(<Host enabled open={open} />);
    screen.getByRole('button', { name: 'Other' }).focus();
    fireEvent.keyDown(document.activeElement!, { key: '.' });
    expect(open).toHaveBeenCalledOnce();
  });

  it('ignores the key while a textarea has focus', () => {
    const open = vi.fn();
    render(<Host enabled open={open} />);
    const textarea = screen.getByRole('textbox', { name: 'Notes' });
    textarea.focus();
    fireEvent.keyDown(textarea, { key: '.' });
    expect(open).not.toHaveBeenCalled();
  });

  it('ignores the key with a modifier held', () => {
    const open = vi.fn();
    render(<Host enabled open={open} />);
    fireEvent.keyDown(document.body, { key: '.', metaKey: true });
    expect(open).not.toHaveBeenCalled();
  });

  it('does nothing when disabled', () => {
    const open = vi.fn();
    render(<Host enabled={false} open={open} />);
    fireEvent.keyDown(document.body, { key: '.' });
    expect(open).not.toHaveBeenCalled();
  });
});
