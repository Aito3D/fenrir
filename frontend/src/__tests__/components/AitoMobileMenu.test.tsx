import { describe, it, expect, vi } from 'vitest';
import { createRef } from 'react';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Archive, Trash2 } from 'lucide-react';
import { render } from '../utils';
import { MobileMenu } from '../../components/aito/MobileMenu';

function setup() {
  const onDone = vi.fn();
  const onTrash = vi.fn();
  const onClose = vi.fn();
  render(
    <MobileMenu
      label="More options"
      anchorRef={createRef()}
      placement="below"
      caption={<span>52 in production</span>}
      items={[
        { key: 'done', icon: Archive, label: 'Show done', trailing: '153', onSelect: onDone },
        { key: 'trash', icon: Trash2, label: 'Trash', onSelect: onTrash },
      ]}
      onClose={onClose}
    />,
  );
  return { onDone, onTrash, onClose };
}

describe('MobileMenu', () => {
  it('is a labelled menu that takes focus, with a caption', () => {
    setup();
    const menu = screen.getByRole('menu', { name: 'More options' });
    expect(menu).toHaveFocus();
    expect(screen.getByText('52 in production')).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem')).toHaveLength(2);
    expect(screen.getByRole('menuitem', { name: /Show done/ })).toHaveTextContent('153');
  });

  it('selecting an item runs it and closes', async () => {
    const user = userEvent.setup();
    const { onTrash, onClose } = setup();
    await user.click(screen.getByRole('menuitem', { name: 'Trash' }));
    expect(onTrash).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  // One close per mount: in the page the menu unmounts on its first close.
  it('closes on the scrim', async () => {
    const user = userEvent.setup();
    const { onClose } = setup();
    await user.click(screen.getByTestId('aito-mobile-menu-scrim'));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it('closes on Escape', async () => {
    const { onClose } = setup();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it('opens below its anchor, aligned to its right edge', () => {
    const anchor = document.createElement('button');
    anchor.getBoundingClientRect = () => ({ top: 60, bottom: 96, left: 330, right: 366, width: 36, height: 36, x: 330, y: 60, toJSON: () => ({}) });
    const ref = { current: anchor };
    render(<MobileMenu label="m" anchorRef={ref} placement="below" items={[]} onClose={() => {}} />);
    const menu = screen.getByRole('menu');
    expect(menu.style.top).toBe('102px');
    expect(menu.style.right).toBe(`${window.innerWidth - 366}px`);
  });
});
