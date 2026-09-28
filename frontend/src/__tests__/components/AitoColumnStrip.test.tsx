import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { ColumnStrip } from '../../components/aito/ColumnStrip';
import { COLUMNS } from '../../components/aito/columns';
import type { ColumnSummary } from '../../utils/aitoMobileBoard';

const cols: ColumnSummary[] = COLUMNS.map((column, i) => ({ column, count: i + 1, oldestDays: null, oldestCls: '' }));

describe('ColumnStrip', () => {
  it('lights every column of the window and only those', () => {
    render(<ColumnStrip columns={cols} from={1} to={3} onJump={() => {}} />);
    const lit = COLUMNS.map((c) => screen.getByTestId(`aito-mobile-segment-${c.id}`).getAttribute('aria-current'));
    expect(lit).toEqual([null, 'true', 'true', 'true', null, null]);
  });

  it('grows each segment with its count and jumps on tap', async () => {
    const onJump = vi.fn();
    render(<ColumnStrip columns={cols} from={0} to={0} onJump={onJump} />);
    expect(screen.getByTestId('aito-mobile-segment-print').style.flexGrow).toBe('5');
    await userEvent.setup().click(screen.getByTestId('aito-mobile-segment-print'));
    expect(onJump).toHaveBeenCalledWith(4);
  });
});
