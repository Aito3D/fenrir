import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { ColumnList } from '../../components/aito/ColumnList';
import { COLUMNS } from '../../components/aito/columns';
import type { ColumnSummary } from '../../utils/aitoMobileBoard';

const cols: ColumnSummary[] = COLUMNS.map((column, i) => ({ column, count: i, oldestDays: i ? 3 : null, oldestCls: '' }));

describe('ColumnList', () => {
  it('marks the whole window current and picks by index', async () => {
    const onPick = vi.fn();
    const { container } = render(<ColumnList columns={cols} from={2} to={4} pending={false} onPick={onPick} />);
    const rows = [...container.querySelectorAll('button[data-column]')];
    expect(rows.map((r) => r.getAttribute('aria-current'))).toEqual([null, null, 'true', 'true', 'true', null]);
    await userEvent.setup().click(rows[5]);
    expect(onPick).toHaveBeenCalledWith(5);
  });
});
