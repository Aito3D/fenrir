import { createRef } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { RevenueMenu } from '../../../components/revenue/RevenueMenu';

function setup() {
  const onRebuild = vi.fn();
  render(
    <RevenueMenu canExport={false} canSync ready rebuildBusy={false} reviewCount={0} targetsOpen={false}
      onTargets={vi.fn()} onReview={vi.fn()} onCopy={vi.fn()} onExport={vi.fn()} onRebuild={onRebuild} triggerRef={createRef<HTMLButtonElement>()} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
  return { onRebuild };
}

const item = (name: string) => within(screen.getByRole('menu')).getByRole('menuitem', { name });
const focused = () => document.activeElement as HTMLElement;
/** What a browser does on Enter over a focused button: keydown, then a click (detail 0) unless the keydown was prevented. */
function pressEnter(repeat = false) {
  const el = focused();
  if (fireEvent.keyDown(el, { key: 'Enter', repeat })) fireEvent.click(el, { detail: 0 });
}

describe('RevenueMenu — rebuild confirmation', () => {
  it('focuses Cancel when the confirmation opens, so Enter twice never confirms', () => {
    const { onRebuild } = setup();
    item('Rebuild').focus();
    pressEnter();
    expect(screen.getByText(/Reload every day from Zoho/)).toBeInTheDocument();
    expect(item('Cancel')).toHaveFocus();
    pressEnter();
    expect(onRebuild).not.toHaveBeenCalled();
    expect(screen.queryByText(/Reload every day from Zoho/)).toBeNull();
  });

  it('ignores the auto-repeat of a held key', () => {
    const { onRebuild } = setup();
    item('Rebuild').focus();
    pressEnter();
    fireEvent.keyDown(focused(), { key: 'ArrowUp' });
    expect(item('Yes, rebuild')).toHaveFocus();
    pressEnter(true);
    pressEnter(true);
    expect(onRebuild).not.toHaveBeenCalled();
    expect(screen.getByText(/Reload every day from Zoho/)).toBeInTheDocument();
  });

  it('a held key on Rebuild never reaches the confirmation', () => {
    const { onRebuild } = setup();
    item('Rebuild').focus();
    pressEnter();
    for (let i = 0; i < 5; i++) pressEnter(true);
    expect(onRebuild).not.toHaveBeenCalled();
    expect(item('Cancel')).toHaveFocus();
  });

  it('confirms once when Yes is reached deliberately', () => {
    const { onRebuild } = setup();
    item('Rebuild').focus();
    pressEnter();
    fireEvent.keyDown(focused(), { key: 'ArrowUp' });
    pressEnter();
    expect(onRebuild).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('ignores the second click of a double click', () => {
    const { onRebuild } = setup();
    fireEvent.click(item('Rebuild'), { detail: 1 });
    fireEvent.click(item('Yes, rebuild'), { detail: 2 });
    expect(onRebuild).not.toHaveBeenCalled();
    fireEvent.click(item('Yes, rebuild'), { detail: 1 });
    expect(onRebuild).toHaveBeenCalledTimes(1);
  });

  it('describes Yes with the confirmation question', () => {
    setup();
    fireEvent.click(item('Rebuild'));
    expect(item('Yes, rebuild')).toHaveAccessibleDescription('Reload every day from Zoho (~1 h)?');
  });
});
