import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { TaskStepFields } from '../../components/aito/TaskStepFields';
import { emptyTaskDraft } from '../../utils/taskDraft';
import type { TaskDraft } from '../../utils/taskDraft';
import { formatMoney } from '../../utils/pricing';

/** Feeds `onChange` back into state so a multi-keystroke `user.type` on a
 *  controlled input accumulates instead of each keystroke starting from the
 *  same stale prop value (a bare `vi.fn()` would only ever see the LAST
 *  character typed). */
function ControlledTaskStepFields({
  initial,
  onChangeSpy,
}: {
  initial: TaskDraft;
  onChangeSpy: (next: TaskDraft) => void;
}) {
  const [task, setTask] = useState(initial);
  return (
    <TaskStepFields
      task={task}
      onChange={(next) => {
        onChangeSpy(next);
        setTask(next);
      }}
    />
  );
}

describe('TaskStepFields', () => {
  it('shows all four services as chips even when no step exists yet', () => {
    // Every service starts as a chip, not a rendered block, on an empty
    // draft — but the chip itself still carries the service's label, so the
    // name stays discoverable.
    render(<TaskStepFields task={emptyTaskDraft()} onChange={vi.fn()} />);
    for (const label of ['Scan', 'Modeling', 'Printing', 'Machining']) {
      expect(screen.getByRole('button', { name: `Add ${label}` })).toBeInTheDocument();
    }
    // No cost input renders until its chip is switched on.
    expect(screen.queryByLabelText(/scan cost/i)).not.toBeInTheDocument();
  });

  it('clearing a cost emits null, not zero — absent is not free', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    // A non-null cost seeds the chip open, so the input is already there.
    render(<TaskStepFields task={{ ...emptyTaskDraft(), scanCost: 1200 }} onChange={onChange} />);

    await user.clear(screen.getByLabelText(/scan cost/i));
    expect(onChange.mock.calls.at(-1)?.[0].scanCost).toBeNull();
  });

  it('switching a chip off emits null for that service, not zero — the service stops existing', async () => {
    // Same null-vs-0 rule the clear-a-cost test above pins, but through the
    // chip: toggling a priced service off must report its cost as null, the
    // value that disables it everywhere else, never 0 (a real free step).
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TaskStepFields task={{ ...emptyTaskDraft(), scanCost: 1200 }} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: 'Remove Scan' }));
    expect(onChange.mock.calls.at(-1)?.[0].scanCost).toBeNull();
  });

  it('labels an enabled chip Remove and a disabled one Add', () => {
    // The two aria-label variants (aito.removeServiceChip / aito.addService)
    // are what tell a screen reader which way the toggle goes — aria-pressed
    // carries the state alongside.
    render(<TaskStepFields task={{ ...emptyTaskDraft(), scanCost: 1200 }} onChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Remove Scan' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Add Modeling' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('button', { name: 'Add Scan' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Modeling' })).not.toBeInTheDocument();
  });

  it('printing: cost and quantity stay editable side by side on an unconfigured install', () => {
    // No calculator queries are mocked in this file, so ImpressionFields
    // renders with an empty printer/filament list — there is only one render
    // path now, so the cost/quantity fields still land in the block's grid
    // (an imported cost has to stay editable).
    render(<TaskStepFields task={{ ...emptyTaskDraft(), impressionCost: 500 }} onChange={vi.fn()} />);
    const topRow = within(screen.getByTestId('impression-grid'));
    expect(topRow.getByLabelText(/printing cost/i)).toBeInTheDocument();
    // Qualified accessible name, not the bare visible "Quantity" label — see
    // QuantityInput's doc on why (two services priced at once would
    // otherwise share one ambiguous "Quantity" name).
    expect(topRow.getByLabelText('Printing Quantity')).toBeInTheDocument();
  });

  it('printing: the cost input edits the UNIT price — stored cost stays unit × quantity', () => {
    const onChange = vi.fn();
    render(
      <TaskStepFields
        task={{
          ...emptyTaskDraft(),
          impressionCost: 1000,
          impression: { ...emptyTaskDraft().impression, quantity: 2 },
        }}
        onChange={onChange}
      />,
    );
    // Stored total 1000 across 2 units reads back as 500 apiece.
    const cost = screen.getByLabelText(/printing cost/i);
    expect(cost).toHaveValue(500);
    // Typing a new unit price stores the multiplied total.
    fireEvent.change(cost, { target: { value: '250' } });
    expect(onChange.mock.calls.at(-1)?.[0].impressionCost).toBe(500);
  });

  it('printing: changing quantity rescales the total so the unit price holds', () => {
    const onChange = vi.fn();
    render(
      <TaskStepFields
        task={{ ...emptyTaskDraft(), impressionCost: 500 }}
        onChange={onChange}
      />,
    );
    // No calculator configured (nothing mocked here), so no repricing can
    // interfere: 500 apiece × 3 must become a stored total of 1500.
    fireEvent.change(screen.getByLabelText('Printing Quantity'), { target: { value: '3' } });
    const next = onChange.mock.calls.at(-1)?.[0];
    expect(next.impression.quantity).toBe(3);
    expect(next.impressionCost).toBe(1500);
  });

  it('printing: discount sits in the block\'s grid beside quantity; material and color under it', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TaskStepFields task={{ ...emptyTaskDraft(), impressionCost: 500 }} onChange={onChange} />);

    // All four are reachable straight away (nothing is mocked here, and
    // there is no disclosure to open).
    const topRow = within(screen.getByTestId('impression-grid'));
    topRow.getByLabelText('Printing Quantity');
    const discount = topRow.getByLabelText('Printing Discount');
    // Material (the filament select, moved out of the calculator) and color
    // are on screen too — before it, in DOM order.
    const material = screen.getByRole('combobox', { name: /material/i });
    const color = screen.getByLabelText('Colour');
    expect(material.compareDocumentPosition(color) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.selectOptions(discount, '10');
    expect(onChange.mock.calls.at(-1)?.[0].impressionDiscountPct).toBe(10);
  });

  it('printing: clearing the discount emits null, not 0', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TaskStepFields
        task={{ ...emptyTaskDraft(), impressionCost: 500, impressionDiscountPct: 10 }}
        onChange={onChange}
      />,
    );
    await user.selectOptions(screen.getByLabelText('Printing Discount'), '');
    expect(onChange.mock.calls.at(-1)?.[0].impressionDiscountPct).toBeNull();
  });

  it('printing: the block shows the line total — unit x quantity minus the discount', () => {
    render(
      <TaskStepFields
        task={{ ...emptyTaskDraft(), impressionCost: 1000, impressionDiscountPct: 10 }}
        onChange={vi.fn()}
      />,
    );
    const totalRow = screen.getByText('Line total').parentElement!;
    expect(totalRow).toHaveTextContent(formatMoney(900, 'USD'));
  });

  it('printing: a discount also states what one part now costs', () => {
    // 1000 stored over 4 parts is 250 apiece; less 20% the line is 800 and a
    // part is 200. Only the 800 used to be on screen, leaving the operator to
    // divide by the quantity to quote a per-piece rate.
    render(
      <TaskStepFields
        task={{
          ...emptyTaskDraft(),
          impression: { ...emptyTaskDraft().impression, quantity: 4 },
          impressionCost: 1000,
          impressionDiscountPct: 20,
        }}
        onChange={vi.fn()}
      />,
    );
    const totalRow = screen.getByText('Line total').parentElement!;
    expect(totalRow).toHaveTextContent(formatMoney(800, 'USD'));
    expect(totalRow).toHaveTextContent(`${formatMoney(200, 'USD')} per part`);
  });

  it('printing: no per-part line without a discount — the cost field already says it', () => {
    render(
      <TaskStepFields
        task={{
          ...emptyTaskDraft(),
          impression: { ...emptyTaskDraft().impression, quantity: 4 },
          impressionCost: 1000,
        }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText('Line total').parentElement!).not.toHaveTextContent('per part');
  });

  it('machining: a unit price times the quantity is what gets stored', () => {
    const onChange = vi.fn();
    // usinageCost: 0 seeds the chip open (0 !== null) without implying a
    // discount or a rescale — quantity defaults to 1, so unit === total.
    render(<TaskStepFields task={{ ...emptyTaskDraft(), usinageCost: 0 }} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText(/machining cost/i), { target: { value: '12000' } });
    expect(onChange.mock.calls.at(-1)?.[0].usinageCost).toBe(12000);
  });

  it('machining: editing the quantity rescales the stored cost so the unit price holds', () => {
    const onChange = vi.fn();
    const task = { ...emptyTaskDraft(), usinageCost: 12000, usinageQuantity: 1 };
    render(<TaskStepFields task={task} onChange={onChange} />);

    // Qualified accessible name ("Machining Quantity"), not the bare visible
    // "Quantity" label — see QuantityInput's doc: two services priced at
    // once would otherwise share one ambiguous "Quantity" name.
    fireEvent.change(screen.getByLabelText('Machining Quantity'), { target: { value: '3' } });
    const next = onChange.mock.calls.at(-1)?.[0];
    expect(next.usinageQuantity).toBe(3);
    expect(next.usinageCost).toBe(36000);
  });

  it('machining: clearing the unit price disables the service rather than zeroing it', () => {
    const onChange = vi.fn();
    const task = { ...emptyTaskDraft(), usinageCost: 12000, usinageQuantity: 3 };
    render(<TaskStepFields task={task} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText(/machining cost/i), { target: { value: '' } });
    expect(onChange.mock.calls.at(-1)?.[0].usinageCost).toBeNull();
  });

  it('machining: the footer states the discounted line total and the per-part rate', () => {
    // 12000/unit x 3 stored as 36000; less 10% the line is 32400, and spread
    // back over 3 parts that is 10800 apiece.
    const task = {
      ...emptyTaskDraft(),
      usinageCost: 36000,
      usinageQuantity: 3,
      usinageDiscountPct: 10,
    };
    render(<TaskStepFields task={task} onChange={vi.fn()} />);

    // Not `toHaveTextContent`: jest-dom normalizes whitespace before
    // comparing, which folds `formatMoney`'s thin-space (U+202F) thousands
    // separator into a plain space and breaks a literal match against a
    // four-digit figure. Reading `textContent` directly compares the same
    // raw string the component actually renders.
    const footer = screen.getByTestId('service-footer-usinage');
    expect(footer.textContent).toContain(formatMoney(32400, 'USD'));
    expect(footer.textContent).toContain(`${formatMoney(10800, 'USD')} per part`);
  });

  it('scan: the same ServicePriceFooter states the line total and per-part rate', () => {
    // Undiscounted, so the line total and the unit rate coincide once
    // divided back by quantity — 900 stored over 3 units is 300 apiece.
    const task = { ...emptyTaskDraft(), scanCost: 900, scanQuantity: 3 };
    render(<TaskStepFields task={task} onChange={vi.fn()} />);

    const footer = screen.getByTestId('service-footer-scan');
    expect(footer).toHaveTextContent(formatMoney(900, 'USD'));
    expect(footer).toHaveTextContent(`${formatMoney(300, 'USD')} per part`);
  });

  it('typing 0 emits 0, which is a real free step', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TaskStepFields task={emptyTaskDraft()} onChange={onChange} />);

    // Machining is a chip on an empty draft; enable it to reach its cost
    // input — enabling must not itself invent a price.
    await user.click(screen.getByRole('button', { name: 'Add Machining' }));
    await user.type(screen.getByLabelText(/machining cost/i), '0');
    expect(onChange.mock.calls.at(-1)?.[0].usinageCost).toBe(0);
  });

  it('edits a per-service description inside the service block', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    // A non-null cost seeds the scan chip open, so its block (and the
    // description textarea inside it) is already on screen.
    render(
      <ControlledTaskStepFields
        initial={{ ...emptyTaskDraft(), scanCost: 1200 }}
        onChangeSpy={onChange}
      />,
    );

    const textarea = screen.getByLabelText(/Scan.*[Dd]escription/);
    await user.type(textarea, 'Scanner la pièce');
    expect(onChange.mock.calls.at(-1)?.[0].scanDescription).toBe('Scanner la pièce');
  });

  it('renders exactly one description textarea per enabled service and none at task level', () => {
    render(
      <TaskStepFields
        task={{ ...emptyTaskDraft(), scanCost: 1200, usinageCost: 50 }}
        onChange={vi.fn()}
      />,
    );
    // No task-level description textarea (the bare placeholder label alone).
    expect(screen.queryByLabelText(/^Optional description$/)).toBeNull();
    // Exactly one per enabled service (scan, usinage) — none for the
    // disabled ones (modelisation, impression).
    expect(screen.getByLabelText(/Scan.*[Dd]escription/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Machining.*[Dd]escription/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Modeling.*[Dd]escription/)).toBeNull();
    expect(screen.queryByLabelText(/Printing.*[Dd]escription/)).toBeNull();
  });
});
