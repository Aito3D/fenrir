/**
 * The chevron toggle shared by the files panel's section blocks and its
 * "other sections" block: button markup, aria-expanded, the toggle callback
 * and the count after the label.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { CollapsibleHeader } from '../../../../components/projects/files/CollapsibleHeader';
import { focusRingCls } from '../../../../components/formStyles';

function Harness({ onToggle }: { onToggle: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <CollapsibleHeader
      open={open}
      onToggle={() => {
        onToggle();
        setOpen((o) => !o);
      }}
      label="Impression"
      count={3}
    />
  );
}

describe('CollapsibleHeader', () => {
  it('renders the button, a chevron, the label, a space and the count', () => {
    const { container } = render(<CollapsibleHeader open={false} onToggle={() => {}} label="Impression" count={3} />);
    const button = screen.getByRole('button', { name: 'Impression 3' });
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button.className).toBe(
      `flex min-h-[44px] w-full items-center gap-1.5 rounded-lg text-left md:min-h-0 ${focusRingCls}`,
    );
    expect(container.childNodes).toHaveLength(1);
    const nodes = Array.from(button.childNodes);
    expect(nodes).toHaveLength(4);
    expect((nodes[0] as Element).tagName.toLowerCase()).toBe('svg');
    expect((nodes[0] as Element).getAttribute('class')).toContain('h-4 w-4 shrink-0 text-bambu-gray');
    expect((nodes[0] as Element).getAttribute('class')).toContain('lucide-chevron-right');
    expect(nodes[1].textContent).toBe('Impression');
    expect((nodes[1] as Element).tagName).toBe('SPAN');
    expect((nodes[1] as Element).getAttribute('class')).toBeNull();
    expect(nodes[2].nodeType).toBe(Node.TEXT_NODE);
    expect(nodes[2].textContent).toBe(' ');
    expect((nodes[3] as Element).outerHTML).toBe('<span class="text-xs font-normal text-bambu-gray">3</span>');
  });

  it('shows the down chevron when open', () => {
    render(<CollapsibleHeader open onToggle={() => {}} label="Docs" count={0} />);
    const button = screen.getByRole('button', { name: 'Docs 0' });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(button.querySelector('svg')?.getAttribute('class')).toContain('lucide-chevron-down');
  });

  it('calls onToggle on each click and reflects the owner state in aria-expanded', async () => {
    const onToggle = vi.fn();
    render(<Harness onToggle={onToggle} />);
    const button = screen.getByRole('button', { name: 'Impression 3' });
    await userEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(2);
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });
});
