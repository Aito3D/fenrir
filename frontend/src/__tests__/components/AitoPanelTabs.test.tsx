import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { PanelTabs } from '../../components/aito/PanelTabs';

const TABS = [
  { id: 'details', label: 'Details' },
  { id: 'activity', label: 'Activity' },
];

afterEach(cleanup);

describe('PanelTabs', () => {
  it('renders a tablist where only the selected tab is in the tab order', () => {
    render(<PanelTabs tabs={TABS} selected="details" onSelect={vi.fn()} attentionLabel="Needs attention" />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Details', 'Activity']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[0]).toHaveAttribute('tabindex', '0');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false');
    expect(tabs[1]).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('tablist')).toBeInTheDocument();
  });

  it('points each tab at its panel so assistive technology can pair them', () => {
    render(<PanelTabs tabs={TABS} selected="details" onSelect={vi.fn()} attentionLabel="Needs attention" />);
    const tab = screen.getByRole('tab', { name: 'Activity' });
    expect(tab).toHaveAttribute('id', 'panel-tab-activity');
    expect(tab).toHaveAttribute('aria-controls', 'panel-tabpanel-activity');
  });

  it('selects a tab on click', () => {
    const onSelect = vi.fn();
    render(<PanelTabs tabs={TABS} selected="details" onSelect={onSelect} attentionLabel="Needs attention" />);
    fireEvent.click(screen.getByRole('tab', { name: 'Activity' }));
    expect(onSelect).toHaveBeenCalledWith('activity');
  });

  it('moves between tabs with the arrow keys, wrapping at both ends', () => {
    const onSelect = vi.fn();
    render(<PanelTabs tabs={TABS} selected="details" onSelect={onSelect} attentionLabel="Needs attention" />);
    const details = screen.getByRole('tab', { name: 'Details' });
    details.focus();
    fireEvent.keyDown(details, { key: 'ArrowRight' });
    expect(onSelect).toHaveBeenLastCalledWith('activity');
    expect(screen.getByRole('tab', { name: 'Activity' })).toHaveFocus();
    fireEvent.keyDown(details, { key: 'ArrowLeft' });
    expect(onSelect).toHaveBeenLastCalledWith('activity');
  });

  it('marks a tab that needs attention with a labelled dot, and only that tab', () => {
    render(
      <PanelTabs
        tabs={[{ ...TABS[0], attention: true }, TABS[1]]}
        selected="activity"
        onSelect={vi.fn()}
        attentionLabel="Needs attention"
      />,
    );
    const dots = screen.getAllByTestId('panel-tab-attention');
    expect(dots).toHaveLength(1);
    expect(dots[0]).toHaveAttribute('aria-label', 'Needs attention');
    expect(screen.getByRole('tab', { name: /Details/ })).toContainElement(dots[0]);
  });

  it('renders no dot at all when nothing needs attention', () => {
    render(<PanelTabs tabs={TABS} selected="details" onSelect={vi.fn()} attentionLabel="Needs attention" />);
    expect(screen.queryByTestId('panel-tab-attention')).not.toBeInTheDocument();
  });
});
