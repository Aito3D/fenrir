/**
 * Tests for TagFilterRail (#1268 follow-up) — the File Manager tag filter
 * that was designed but never rendered in the original #1268 ship.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TagFilterRail } from '../../components/TagFilterRail';
import type { LibraryTag } from '../../api/client';

const mockOnToggle = vi.fn();
const mockOnClearAll = vi.fn();

function makeTag(id: number, name: string, file_count = 0): LibraryTag {
  return { id, name, file_count, created_at: '2026-01-01', updated_at: '2026-01-01' };
}

function renderRail(tags: LibraryTag[], selectedTagIds: number[] = []) {
  return render(
    <TagFilterRail
      tags={tags}
      selectedTagIds={selectedTagIds}
      onToggle={mockOnToggle}
      onClearAll={mockOnClearAll}
    />,
  );
}

describe('TagFilterRail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when the catalog is empty', () => {
    renderRail([]);
    expect(screen.queryByTestId('tag-filter-rail')).not.toBeInTheDocument();
  });

  it('renders a chip per tag with its file count', () => {
    renderRail([makeTag(1, 'toy', 4), makeTag(2, 'petg', 2)]);
    expect(screen.getByRole('button', { name: /toy/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /petg/ })).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('clicking a chip toggles it into the filter', async () => {
    const user = userEvent.setup();
    renderRail([makeTag(1, 'toy', 4)]);
    await user.click(screen.getByRole('button', { name: /toy/ }));
    expect(mockOnToggle).toHaveBeenCalledWith(1);
  });

  it('active chips are pressed and show the filter label + Clear all', async () => {
    const user = userEvent.setup();
    renderRail([makeTag(1, 'toy', 4), makeTag(2, 'petg', 2)], [1]);

    const active = screen.getByRole('button', { name: /toy/ });
    expect(active).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /petg/ })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Filtering by:')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(mockOnClearAll).toHaveBeenCalled();
  });

  it('hides the filter label and Clear all when nothing is selected', () => {
    renderRail([makeTag(1, 'toy', 4)]);
    expect(screen.queryByText('Filtering by:')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear all' })).not.toBeInTheDocument();
  });

  it('collapses past the limit behind a "+N more" expander', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 15 }, (_, i) => makeTag(i + 1, `tag-${String(i + 1).padStart(2, '0')}`, 15 - i));
    renderRail(many);

    // 12 visible + expander; the 3 lowest-usage tags are hidden.
    expect(screen.queryByRole('button', { name: /tag-13/ })).not.toBeInTheDocument();
    const expander = screen.getByRole('button', { name: '+3 more' });

    await user.click(expander);
    expect(screen.getByRole('button', { name: /tag-15/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument();
  });

  it('active tags sort first so they never collapse', () => {
    const many = Array.from({ length: 15 }, (_, i) => makeTag(i + 1, `tag-${String(i + 1).padStart(2, '0')}`, 15 - i));
    // Select the lowest-usage tag — without active-first sorting it would be hidden.
    renderRail(many, [15]);
    expect(screen.getByRole('button', { name: /tag-15/ })).toHaveAttribute('aria-pressed', 'true');
  });
});
