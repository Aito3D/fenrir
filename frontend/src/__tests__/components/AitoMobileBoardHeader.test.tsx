import { describe, it, expect, vi } from 'vitest';
import { createRef, useState } from 'react';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { makeProject } from '../fixtures/aitoProject';
import { searchProjects } from '../../utils/aitoSearch';
import { AitoSearchContext } from '../../components/aito/search/AitoSearchContext';
import { MobileBoardHeader } from '../../components/aito/MobileBoardHeader';
import { COLUMNS } from '../../components/aito/columns';
import type { ColumnSummary } from '../../utils/aitoMobileBoard';

const summaries: ColumnSummary[] = COLUMNS.map((column, i) => ({
  column, count: i === 0 ? 6 : i, oldestDays: i === 0 ? 9 : null, oldestCls: i === 0 ? 'text-amber-400' : '',
}));

function Harness(overrides: { onJump?: (i: number) => void; onOpenColumns?: () => void; onOpenMore?: () => void; current?: number }) {
  const [search, setSearch] = useState('');
  return (
    <MobileBoardHeader
      columns={summaries}
      current={overrides.current ?? 0}
      pending={false}
      search={search}
      onSearchChange={setSearch}
      onJump={overrides.onJump ?? (() => {})}
      onOpenColumns={overrides.onOpenColumns ?? (() => {})}
      columnsOpen={false}
      onOpenMore={overrides.onOpenMore ?? (() => {})}
      moreOpen={false}
      pickerRef={createRef()}
      moreRef={createRef()}
    />
  );
}

describe('MobileBoardHeader', () => {
  it('shows the current column, its count and the oldest card', () => {
    render(<Harness />);
    // `expanded: false` selects the picker: the strip segment "Quote, 6 projects"
    // also matches /Quote/ but carries no aria-expanded.
    const picker = screen.getByRole('button', { name: /Quote/, expanded: false });
    expect(picker).toHaveTextContent('6');
    expect(picker).toHaveAttribute('aria-haspopup', 'dialog');
    expect(screen.getByTestId('aito-mobile-oldest')).toHaveTextContent('9 d');
    expect(screen.getByTestId('aito-mobile-oldest')).toHaveClass('text-amber-400');
  });

  it('hides the oldest chip for an empty column', () => {
    render(<Harness current={1} />);
    expect(screen.queryByTestId('aito-mobile-oldest')).toBeNull();
  });

  it('opens the search row focused; Escape closes it and keeps the query with a dot', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const toggle = screen.getByRole('button', { name: 'Search' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const input = screen.getByTestId('aito-mobile-search');
    expect(input).toHaveFocus();
    await user.type(input, 'onati');
    await user.keyboard('{Escape}');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(input).toHaveValue('onati');
    expect(screen.getByTestId('aito-mobile-search-dot')).toBeInTheDocument();
    expect(toggle).toHaveFocus();
  });

  it('clear empties the query and closes the row', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.type(screen.getByTestId('aito-mobile-search'), 'x');
    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByTestId('aito-mobile-search')).toHaveValue('');
    expect(screen.queryByTestId('aito-mobile-search-dot')).toBeNull();
    expect(screen.getByRole('button', { name: 'Search' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('segments jump, carry a label, and grow with the count', async () => {
    const user = userEvent.setup();
    const onJump = vi.fn();
    render(<Harness onJump={onJump} />);
    const seg = screen.getByTestId('aito-mobile-segment-print');
    expect(seg).toHaveAccessibleName('Printing & Machining, 4 projects');
    expect(seg.style.flexGrow).toBe('4');
    expect(screen.getByTestId('aito-mobile-segment-devis')).toHaveAttribute('aria-current', 'true');
    await user.click(seg);
    expect(onJump).toHaveBeenCalledWith(4);
  });

  it('opens the sheet and the menu', async () => {
    const user = userEvent.setup();
    const onOpenColumns = vi.fn();
    const onOpenMore = vi.fn();
    render(<Harness onOpenColumns={onOpenColumns} onOpenMore={onOpenMore} />);
    await user.click(screen.getByRole('button', { name: /Quote/, expanded: false }));
    await user.click(screen.getByRole('button', { name: 'More options' }));
    expect(onOpenColumns).toHaveBeenCalledOnce();
    expect(onOpenMore).toHaveBeenCalledOnce();
  });

  it('shows the smart-search dropdown below the row, and an IME-cancel Escape does not fold it', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const projects = [makeProject({ id: 5, description: 'Support GoPro', client_name: 'Dupont' })];
    function WithSearch() {
      const [q, setQ] = useState('');
      return (
        <AitoSearchContext.Provider
          value={{ hits: q.trim() ? searchProjects(projects, q) : [], trash: 'ready', onSelect }}
        >
          <MobileBoardHeader
            columns={summaries}
            current={0}
            pending={false}
            search={q}
            onSearchChange={setQ}
            onJump={() => {}}
            onOpenColumns={() => {}}
            columnsOpen={false}
            onOpenMore={() => {}}
            moreOpen={false}
            pickerRef={createRef()}
            moreRef={createRef()}
          />
        </AitoSearchContext.Provider>
      );
    }
    render(<WithSearch />);
    const toggle = screen.getByRole('button', { name: 'Search' });
    await user.click(toggle);
    const input = screen.getByTestId('aito-mobile-search');
    await user.type(input, 'gopro');
    expect(await screen.findByRole('option', { name: /Support GoPro/ })).toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'Escape', isComposing: true });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await user.click(screen.getByRole('option', { name: /Support GoPro/ }));
    expect(onSelect).toHaveBeenCalledWith(5);
  });
});
