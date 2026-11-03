import { describe, it, expect, vi } from 'vitest';
import { createRef } from 'react';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '../../../utils';
import { CatalogToolbar } from '../../../../components/projects/catalog/CatalogToolbar';
import { EMPTY_FILTERS } from '../../../../components/projects/catalog/catalogRules';
import type { ProjectTagCount } from '../../../../api/client';

function setup() {
  const handlers = {
    onQChange: vi.fn(), onToggleChip: vi.fn(), onToggleMaterial: vi.fn(), onSortChange: vi.fn(), onStatusChange: vi.fn(),
    onToggleTag: vi.fn(),
  };
  const usedTags = [{ id: 4, name: 'auto', color: null, count: 2 }] as unknown as ProjectTagCount[];
  render(
    <CatalogToolbar searchRef={createRef()} q="" filters={EMPTY_FILTERS} materials={['ASA']} sort="activity" status="active"
      usedTags={usedTags} tagIds={[]} {...handlers} />,
  );
  return handlers;
}

describe('CatalogToolbar', () => {
  it('lists the four sorts and the four statuses, and reports a change of either', () => {
    const h = setup();
    const sort = screen.getByRole('combobox', { name: 'Sort: last activity' });
    expect([...sort.querySelectorAll('option')].map((o) => o.value)).toEqual(['activity', 'code', 'name', 'printed']);
    fireEvent.change(sort, { target: { value: 'printed' } });
    expect(h.onSortChange).toHaveBeenCalledWith('printed');
    const status = screen.getAllByRole('combobox')[1];
    expect([...status.querySelectorAll('option')].map((o) => o.value)).toEqual(['active', 'completed', 'archived', 'all']);
    fireEvent.change(status, { target: { value: 'archived' } });
    expect(h.onStatusChange).toHaveBeenCalledWith('archived');
  });

  it('the chips, a material and a tag each report their own toggle', () => {
    const h = setup();
    fireEvent.click(screen.getByRole('button', { name: 'In production' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ready to print' }));
    fireEvent.click(screen.getByRole('button', { name: 'No file yet' }));
    expect(h.onToggleChip.mock.calls).toEqual([['production'], ['ready'], ['nofile']]);
    fireEvent.click(screen.getByRole('button', { name: 'ASA' }));
    expect(h.onToggleMaterial).toHaveBeenCalledWith('ASA');
    fireEvent.click(screen.getByRole('button', { name: '#auto' }));
    expect(h.onToggleTag).toHaveBeenCalledWith(4);
  });
});
