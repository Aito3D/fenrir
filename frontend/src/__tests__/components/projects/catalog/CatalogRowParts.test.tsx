/** The pieces both catalog lists build a project row from. */
import { describe, expect, it } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { render } from '../../../utils';
import type { ProjectCatalogItem } from '../../../../api/client';
import { CodeMark, InProductionFlame, PrintedCell, Thumb } from '../../../../components/projects/catalog/CatalogRowParts';

const item = (o: Partial<ProjectCatalogItem> = {}): ProjectCatalogItem => ({
  id: 1, code: 'P-0042', name: 'Cap', description: null, status: 'active', folder_id: null, tags: [], client_names: [],
  open_orders: [], files_count: 1, recommended: null, has_unsliced_only: false, printed_count: 0, target_count: null,
  last_activity: '2026-10-30T10:00:00Z', thumbnail_file_id: null, ...o,
});

describe('CatalogRowParts', () => {
  it('Thumb fades the thumbnail in once it loads, and on an error too', () => {
    const { container, rerender } = render(<Thumb item={item({ thumbnail_file_id: 7 })} className="h-10 w-10" />);
    const img = container.querySelector('img')!;
    expect(img).toHaveAttribute('src', expect.stringContaining('/7/thumbnail'));
    expect(img).toHaveClass('opacity-0');
    fireEvent.load(img);
    expect(img).toHaveClass('opacity-100');
    rerender(<Thumb key="other" item={item({ thumbnail_file_id: 8 })} className="h-10 w-10" />);
    const next = container.querySelector('img')!;
    expect(next).toHaveClass('opacity-0');
    fireEvent.error(next);
    expect(next).toHaveClass('opacity-100');
  });

  it('Thumb shows a cached thumbnail at once, and a placeholder without one', () => {
    const complete = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'complete');
    Object.defineProperty(HTMLImageElement.prototype, 'complete', { configurable: true, get: () => true });
    try {
      const { container } = render(<Thumb item={item({ thumbnail_file_id: 7 })} className="h-10 w-10" />);
      expect(container.querySelector('img')).toHaveClass('opacity-100');
    } finally {
      if (complete) Object.defineProperty(HTMLImageElement.prototype, 'complete', complete);
    }
    const { container } = render(<Thumb item={item()} className="h-10 w-10" />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('PrintedCell: green once the target is met, white below it, the bare count, a dash when never printed', () => {
    const text = (o: Partial<ProjectCatalogItem>) => {
      const { container, unmount } = render(<PrintedCell item={item(o)} />);
      const span = container.querySelector('span')!;
      const out = `${span.textContent}|${span.className}`;
      unmount();
      return out;
    };
    expect(text({ printed_count: 5, target_count: 3 })).toBe('5/3|text-bambu-green');
    expect(text({ printed_count: 2, target_count: 10 })).toBe('2/10|text-white');
    expect(text({ printed_count: 4 })).toBe('4|text-white');
    expect(text({})).toBe('—|text-bambu-gray/50');
  });

  it('CodeMark marks the search in the code and is absent without one; the flame shows with an open order only', () => {
    const { container, rerender } = render(<><CodeMark item={item()} q="0042" /><InProductionFlame item={item()} /></>);
    expect(container.querySelector('mark')).toHaveTextContent('0042');
    expect(screen.queryByLabelText('In production')).not.toBeInTheDocument();
    rerender(<><CodeMark item={item({ code: null })} q="" /><InProductionFlame item={item({ open_orders: [{ order_id: 3, client_name: null }] })} /></>);
    expect(container.querySelector('.font-mono')).toBeNull();
    expect(screen.getByLabelText('In production')).toBeInTheDocument();
  });
});
