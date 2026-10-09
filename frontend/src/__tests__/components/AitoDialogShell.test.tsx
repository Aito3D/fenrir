import { describe, it, expect, vi } from 'vitest';
import { createRef } from 'react';
import { fireEvent, screen } from '@testing-library/react';
import { Merge } from 'lucide-react';
import { render } from '../utils';
import { AitoDialogShell } from '../../components/aito/AitoDialogShell';

function shell(over: Partial<React.ComponentProps<typeof AitoDialogShell>> = {}) {
  const requestClose = vi.fn();
  const onWindowKey = vi.fn();
  window.addEventListener('keydown', onWindowKey);
  const props = {
    label: 'Merge cards',
    testId: 'shell',
    icon: Merge,
    subtitle: 'Pick one',
    closing: false,
    requestClose,
    dialogRef: createRef<HTMLDivElement>(),
    maxWidthCls: 'max-w-[560px]',
    ...over,
  } as React.ComponentProps<typeof AitoDialogShell>;
  const r = render(
    <AitoDialogShell {...props}>
      <p>body</p>
    </AitoDialogShell>,
  );
  return { ...r, requestClose, onWindowKey, cleanup: () => window.removeEventListener('keydown', onWindowKey) };
}

describe('AitoDialogShell', () => {
  it('renders the standard header and the dialog frame', () => {
    const { cleanup } = shell();
    const dialog = screen.getByRole('dialog', { name: 'Merge cards' });
    expect(dialog).toHaveAttribute('data-testid', 'shell');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).not.toHaveAttribute('aria-busy');
    expect(dialog.className).toContain('w-full max-w-[560px] flex flex-col focus:outline-none animate-modal-in');
    expect(dialog.firstElementChild?.className).toContain('p-0 flex flex-col');
    expect(dialog.firstElementChild?.className).not.toContain('min-h-0');
    expect(screen.getByRole('heading', { level: 2, name: 'Merge cards' })).toBeInTheDocument();
    expect(screen.getByText('Pick one').className).toBe('mt-0.5 text-xs text-bambu-gray leading-snug');
    expect(screen.getByText('body')).toBeInTheDocument();
    cleanup();
  });

  it('caps the height, truncates the subtitle and flags aria-busy on request', () => {
    const { cleanup } = shell({ capHeight: true, truncateSubtitle: true, ariaBusy: true });
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-busy', 'true');
    expect(dialog.className).toContain('w-full max-w-[560px] max-h-[88vh] flex flex-col');
    expect(dialog.firstElementChild?.className).toContain('p-0 flex flex-col min-h-0');
    expect(screen.getByText('Pick one').className).toBe('mt-0.5 text-xs text-bambu-gray leading-snug truncate');
    cleanup();
  });

  it('renders a custom header instead of the standard one', () => {
    const { cleanup } = shell({ icon: undefined, subtitle: undefined, header: <header>custom</header> } as never);
    expect(screen.getByText('custom')).toBeInTheDocument();
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Merge cards' })).toBeInTheDocument();
    cleanup();
  });

  it('closes on Escape, the X and the backdrop, but not on a click inside', () => {
    const { requestClose, onWindowKey, container, cleanup } = shell();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(requestClose).toHaveBeenCalledTimes(1);
    expect(onWindowKey).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' });
    expect(requestClose).toHaveBeenCalledTimes(1);
    expect(onWindowKey).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('body'));
    expect(requestClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(requestClose).toHaveBeenCalledTimes(2);
    fireEvent.click(container.firstElementChild as Element);
    expect(requestClose).toHaveBeenCalledTimes(3);
    cleanup();
  });

  it('swallows Escape without closing while busy or already closing', () => {
    const busy = shell({ busy: true });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(busy.requestClose).not.toHaveBeenCalled();
    expect(busy.onWindowKey).not.toHaveBeenCalled();
    busy.cleanup();
    busy.unmount();

    const closing = shell({ closing: true });
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('animate-modal-out');
    expect(dialog.parentElement?.className).toContain('animate-overlay-out pointer-events-none');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(closing.requestClose).not.toHaveBeenCalled();
    closing.cleanup();
  });
});
