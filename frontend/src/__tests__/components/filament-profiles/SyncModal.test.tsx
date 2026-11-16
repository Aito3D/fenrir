import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { SyncModal } from '../../../components/filament-profiles/SyncModal';
import type { SyncModalProps } from '../../../components/filament-profiles/SyncModal';

const stats = { added: 2, updated: 3, removed: 1, unchanged: 5 };

function setup(props: Partial<SyncModalProps> & Pick<SyncModalProps, 'state'>) {
  const handlers = { onCancel: vi.fn(), onConfirm: vi.fn(), onClose: vi.fn() };
  render(<SyncModal {...handlers} {...props} />);
  return handlers;
}

describe('SyncModal', () => {
  afterEach(() => vi.useRealTimers());

  it('disables Sync and explains why when the user cannot delete', () => {
    const h = setup({ state: 'preview', stats, canConfirm: false });
    expect(screen.getByText('You do not have permission to delete existing presets')).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Sync' });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(h.onConfirm).not.toHaveBeenCalled();
  });

  it('confirms when allowed and there are changes', () => {
    const h = setup({ state: 'preview', stats });
    expect(screen.queryByText('You do not have permission to delete existing presets')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sync' }));
    expect(h.onConfirm).toHaveBeenCalledTimes(1);
  });

  it('shows up-to-date and disables Sync when nothing would change', () => {
    setup({ state: 'preview', stats: { added: 0, updated: 0, removed: 0, unchanged: 9 } });
    expect(screen.getByText('Everything is already up to date.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync' })).toBeDisabled();
  });

  it('disables Sync while stats are not loaded', () => {
    setup({ state: 'preview' });
    expect(screen.getByRole('button', { name: 'Sync' })).toBeDisabled();
  });

  it('calls onCancel after the close animation when Cancel is clicked', () => {
    vi.useFakeTimers();
    const h = setup({ state: 'preview', stats });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(h.onCancel).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1000));
    expect(h.onCancel).toHaveBeenCalledTimes(1);
  });

  it('ignores Escape and backdrop clicks while syncing', () => {
    vi.useFakeTimers();
    const h = setup({ state: 'syncing' });
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('sync-modal').parentElement!);
    act(() => void vi.advanceTimersByTime(1000));
    expect(h.onClose).not.toHaveBeenCalled();
    expect(h.onCancel).not.toHaveBeenCalled();
  });

  it('dismisses on Escape in the preview state', () => {
    vi.useFakeTimers();
    const h = setup({ state: 'preview', stats });
    fireEvent.keyDown(window, { key: 'Escape' });
    act(() => void vi.advanceTimersByTime(1000));
    expect(h.onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows the result counts and Close calls onClose when done', () => {
    vi.useFakeTimers();
    const h = setup({ state: 'done', stats });
    const modal = screen.getByTestId('sync-modal');
    expect(modal).toHaveTextContent('2');
    expect(modal).toHaveTextContent('3');
    expect(modal).toHaveTextContent('1');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    act(() => void vi.advanceTimersByTime(1000));
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });
});
