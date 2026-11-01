import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Cloud } from 'lucide-react';
import { useState } from 'react';
import { render } from '../../utils';
import { MobileTabs } from '../../../components/mobile/MobileTabs';

const WIDTH = 390;
let widthSpy: PropertyDescriptor | undefined;
const scrollLeftStub: PropertyDescriptor & ThisType<HTMLElement & { __sl?: number }> = {
  configurable: true,
  get() { return this.__sl ?? 0; },
  set(value: number) { this.__sl = value; },
};
beforeEach(() => {
  widthSpy = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => WIDTH });
  Object.defineProperty(HTMLElement.prototype, 'scrollLeft', scrollLeftStub);
});
afterEach(() => {
  if (widthSpy) Object.defineProperty(HTMLElement.prototype, 'clientWidth', widthSpy);
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollLeft;
});

type Id = 'a' | 'b' | 'c' | 'd';
// Icon-less tabs with a badge, as Settings and Calculator pass them.
const tabs = [
  { id: 'a' as const, label: 'Alpha', icon: Cloud, count: 2 },
  { id: 'b' as const, label: 'Beta', extra: <span data-testid="dot" /> },
  { id: 'c' as const, label: 'Gamma' },
  { id: 'd' as const, label: 'Delta' },
];

function Harness() {
  const [active, setActive] = useState<Id>('a');
  return (
    <MobileTabs
      tabs={tabs}
      activeTab={active}
      onTabChange={setActive}
      toolbar={<input aria-label="Search" />}
      renderTab={(id) => <p>content:{id}</p>}
    />
  );
}

describe('MobileTabs', () => {
  it('names the current tab, keeps the toolbar fixed and renders neighbours only', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: /Alpha.*2.*Switch tab/ })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Search' })).toBeInTheDocument();
    expect(screen.getAllByTestId(/^mobile-tabs-page-/)).toHaveLength(4);
    expect(screen.getByText('content:a')).toBeInTheDocument();
    expect(screen.getByText('content:b')).toBeInTheDocument();
    expect(screen.queryByText('content:c')).not.toBeInTheDocument();
  });

  it("switches tabs from the sheet, showing each tab's badge", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: /Switch tab/ }));
    const sheet = screen.getByRole('dialog', { name: 'Tabs' });
    expect(within(sheet).getByTestId('dot')).toBeInTheDocument();
    await user.click(within(sheet).getByRole('button', { name: /Delta/ }));
    expect(screen.getByRole('button', { name: /Delta.*Switch tab/ })).toBeInTheDocument();
    expect(screen.getByText('content:d')).toBeInTheDocument();
    expect(screen.queryByText('content:a')).not.toBeInTheDocument();
    expect(screen.getByTestId('mobile-tabs-pager').scrollLeft).toBe(WIDTH * 3);
  });
});
