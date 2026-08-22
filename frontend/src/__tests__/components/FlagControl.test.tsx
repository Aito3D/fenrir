import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, act, within } from '@testing-library/react';
import { render } from '../utils';
import { FlagControl } from '../../components/aito/FlagControl';
import { api } from '../../api/client';
import type { AitoProject } from '../../api/client';

// A project with every field the board cache needs, defaulted so a test can
// override only what it cares about — mirrors AitoQuoteStatusActions.test.tsx's
// `makeProject`, since `FlagControl` (like `QuoteStatusActions`) needs a full
// `AitoProject`, not just the `flag` field it reads.
const baseProject: AitoProject = {
  id: 12,
  description: 'Support de caméra',
  column: 'devis',
  position: 0,
  status: 'active',
  client_id: 'z1',
  client_name: 'ACME SARL',
  client_phone: '+689-87123456',
  client_email: 'hi@acme.pf',
  client_is_company: true,
  client_social_network: null,
  client_social_handle: null,
  quote_id: null,
  quote_number: null,
  quote_date: null,
  quote_total: null,
  quote_url: null,
  quote_salesperson: null,
  quote_status: null,
  quote_accepted_at: null,
  quote_sync_state: 'idle',
  quote_invoiced: false,
  flag: null,
  client_contacted_at: null,
  quote_sync_error: null,
  quote_status_block: null,
  quote_status_remote: null,
  created_by: null,
  task_count: 0,
  tasks_total: 0,
  task_services: [],
  task_pending: [],
  steps_total: 0,
  steps_done: 0,
  task_steps: [],
  move_lock: null,
  shipping_island: null,
  shipping_service: null,
  shipping_first_name: null,
  shipping_last_name: null,
  shipping_phone: null,
  shipping_price: null,
  shipping_service_name: null,
  created_at: '2026-07-27T00:00:00',
  updated_at: '2026-07-27T00:00:00',
};

// `/marquer|mark/i` as a substring test also matches "Mark urgent" and
// "Mark returned" (the segments' own labels, present but collapsed/disabled
// in the DOM) once the render locale is English — this shared test render
// helper initialises i18next with no saved language, so jsdom's default
// `navigator.language` ("en-US") resolves to English rather than French.
// Anchored to the exact `aito.markFlag` string ("Mark") for that locale,
// rather than loosened further, per the resting chip's own accessible name.
const openControl = () => {
  fireEvent.click(screen.getByRole('button', { name: /^mark$/i }));
};

// The `flag-segment-{kind}` testid lands on the collapsing wrapper `<span>`,
// not on `HoldButton`'s own `<button>` — that span is a unit for the
// collapse/expand assertions, and pointer events dispatched at an ANCESTOR
// never reach a DESCENDANT's handler (DOM events only bubble upward from
// their target). `within(...).getByRole('button')` scopes to the segment
// and finds the actionable element inside it, which is what a real pointer
// press — hit-testing whatever is visually on top — would actually reach.
const segment = (kind: 'urgent' | 'sav' | 'pause') =>
  within(screen.getByTestId(`flag-segment-${kind}`)).getByRole('button');

describe('FlagControl', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows only the resting chip until it is opened', () => {
    render(<FlagControl project={{ ...baseProject, flag: null }} />);
    expect(screen.getByTestId('flag-control')).toHaveAttribute('data-open', 'false');
  });

  it('sets urgent after a 500ms hold, and not before', async () => {
    vi.useFakeTimers();
    const setFlag = vi.spyOn(api, 'setAitoProjectFlag').mockResolvedValue({} as AitoProject);
    render(<FlagControl project={{ ...baseProject, flag: null }} />);

    fireEvent.focus(screen.getByTestId('flag-control'));
    fireEvent.pointerDown(segment('urgent'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(setFlag).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(setFlag).toHaveBeenCalledWith(baseProject.id, 'urgent');
  });

  it('sets sav from the other segment', async () => {
    vi.useFakeTimers();
    const setFlag = vi.spyOn(api, 'setAitoProjectFlag').mockResolvedValue({} as AitoProject);
    render(<FlagControl project={{ ...baseProject, flag: null }} />);

    fireEvent.focus(screen.getByTestId('flag-control'));
    fireEvent.pointerDown(segment('sav'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(setFlag).toHaveBeenCalledWith(baseProject.id, 'sav');
  });

  it('clears the live flag when its own segment is held', async () => {
    vi.useFakeTimers();
    const setFlag = vi.spyOn(api, 'setAitoProjectFlag').mockResolvedValue({} as AitoProject);
    render(<FlagControl project={{ ...baseProject, flag: 'sav' }} />);

    fireEvent.pointerDown(segment('sav'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(setFlag).toHaveBeenCalledWith(baseProject.id, null);
  });

  it('switches straight from urgent to sav without clearing first', async () => {
    vi.useFakeTimers();
    const setFlag = vi.spyOn(api, 'setAitoProjectFlag').mockResolvedValue({} as AitoProject);
    render(<FlagControl project={{ ...baseProject, flag: 'urgent' }} />);

    fireEvent.focus(screen.getByTestId('flag-control'));
    fireEvent.pointerDown(segment('sav'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(setFlag).toHaveBeenCalledTimes(1);
    expect(setFlag).toHaveBeenCalledWith(baseProject.id, 'sav');
  });

  it('offers a pause segment that holds to set', async () => {
    vi.useFakeTimers();
    const setFlag = vi.spyOn(api, 'setAitoProjectFlag').mockResolvedValue({} as AitoProject);
    render(<FlagControl project={{ ...baseProject, flag: null }} />);

    fireEvent.focus(screen.getByTestId('flag-control'));
    fireEvent.pointerDown(segment('pause'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(setFlag).toHaveBeenCalledWith(baseProject.id, 'pause');
  });

  it('holding the live pause segment clears it', async () => {
    vi.useFakeTimers();
    const setFlag = vi.spyOn(api, 'setAitoProjectFlag').mockResolvedValue({} as AitoProject);
    render(<FlagControl project={{ ...baseProject, flag: 'pause' }} />);

    fireEvent.focus(screen.getByTestId('flag-control'));
    expect(segment('pause')).toHaveAttribute('aria-pressed', 'true');

    fireEvent.pointerDown(segment('pause'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(setFlag).toHaveBeenCalledWith(baseProject.id, null);
  });

  it('switches straight from urgent to pause in one request', async () => {
    vi.useFakeTimers();
    const setFlag = vi.spyOn(api, 'setAitoProjectFlag').mockResolvedValue({} as AitoProject);
    render(<FlagControl project={{ ...baseProject, flag: 'urgent' }} />);

    fireEvent.focus(screen.getByTestId('flag-control'));
    fireEvent.pointerDown(segment('pause'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(setFlag).toHaveBeenCalledTimes(1);
    expect(setFlag).toHaveBeenCalledWith(baseProject.id, 'pause');
  });

  it('does not fire on a short tap', async () => {
    vi.useFakeTimers();
    const setFlag = vi.spyOn(api, 'setAitoProjectFlag').mockResolvedValue({} as AitoProject);
    render(<FlagControl project={{ ...baseProject, flag: 'urgent' }} />);

    const button = segment('urgent');
    fireEvent.pointerDown(button);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    fireEvent.pointerUp(button);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(setFlag).not.toHaveBeenCalled();
  });

  it('opens on focus so the second choice is reachable without a mouse', () => {
    render(<FlagControl project={{ ...baseProject, flag: null }} />);
    const root = screen.getByTestId('flag-control');
    expect(root).toHaveAttribute('data-open', 'false');
    fireEvent.focus(root);
    expect(root).toHaveAttribute('data-open', 'true');
  });

  it('opens when the resting chip is clicked, for touch', () => {
    render(<FlagControl project={{ ...baseProject, flag: null }} />);
    openControl();
    expect(screen.getByTestId('flag-control')).toHaveAttribute('data-open', 'true');
  });

  it('reports aria-pressed on each segment reflecting the live flag', () => {
    render(<FlagControl project={{ ...baseProject, flag: 'sav' }} />);
    fireEvent.focus(screen.getByTestId('flag-control'));
    expect(segment('sav')).toHaveAttribute('aria-pressed', 'true');
    expect(segment('urgent')).toHaveAttribute('aria-pressed', 'false');
  });

  it('keeps focus inside the control after a keyboard commit, instead of dropping it to <body>', async () => {
    vi.useFakeTimers();
    vi.spyOn(api, 'setAitoProjectFlag').mockResolvedValue({} as AitoProject);
    render(<FlagControl project={{ ...baseProject, flag: null }} />);

    const root = screen.getByTestId('flag-control');
    fireEvent.focus(root);
    const button = segment('urgent');
    button.focus();
    fireEvent.keyDown(button, { key: 'Enter' });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(document.activeElement).toBe(root);
    expect(document.activeElement).not.toBe(document.body);
  });

  it('opens on pointer hover and closes on pointer leave, for a mouse', () => {
    render(<FlagControl project={{ ...baseProject, flag: null }} />);
    const root = screen.getByTestId('flag-control');
    expect(root).toHaveAttribute('data-open', 'false');

    fireEvent.pointerEnter(root);
    expect(root).toHaveAttribute('data-open', 'true');

    fireEvent.pointerLeave(root);
    expect(root).toHaveAttribute('data-open', 'false');
  });

  // Pins the component's own docstring claim: "Touch has neither hover nor
  // pointerleave, so an outside press is the only thing that can close the
  // control there." Opened here the way touch actually opens it — a tap on
  // the resting chip, never pointerEnter or focus — so nothing but the
  // document-level outside-pointerdown listener is available to close it.
  it('closes on an outside pointerdown, the only close path touch has (no hover, no pointerleave)', () => {
    render(<FlagControl project={{ ...baseProject, flag: null }} />);
    openControl();
    const root = screen.getByTestId('flag-control');
    expect(root).toHaveAttribute('data-open', 'true');

    fireEvent.pointerDown(document.body);
    expect(root).toHaveAttribute('data-open', 'false');
  });

  it('does not close on a pointerdown that lands inside the control', () => {
    render(<FlagControl project={{ ...baseProject, flag: null }} />);
    openControl();
    const root = screen.getByTestId('flag-control');

    fireEvent.pointerDown(segment('urgent'));
    expect(root).toHaveAttribute('data-open', 'true');
  });

  it('keeps the resting chip visible while it holds focus, even once the control is open for everyone else', () => {
    render(<FlagControl project={{ ...baseProject, flag: null }} />);
    const root = screen.getByTestId('flag-control');
    const chip = screen.getByRole('button', { name: /^mark$/i });
    const chipWrapper = chip.parentElement as HTMLElement;

    fireEvent.pointerEnter(root);
    expect(root).toHaveAttribute('data-open', 'true');
    // Open for everyone else, and the chip itself has no focus yet, so it
    // collapses like the rest of the resting state does.
    expect(chipWrapper.className).toContain('max-w-0');

    fireEvent.focus(chip);
    // Focus pins it back open even though the control as a whole stays open.
    expect(chipWrapper.className).toContain('max-w-[9rem]');

    // `relatedTarget` lands inside the control (a segment), so this blur
    // is isolated to the chip's own focus tracking rather than also
    // closing the control via the root's onBlur — see the "keeps focus
    // inside the control" test above for that other path.
    fireEvent.blur(chip, { relatedTarget: segment('urgent') });
    expect(root).toHaveAttribute('data-open', 'true');
    // Losing focus lets it collapse again.
    expect(chipWrapper.className).toContain('max-w-0');
  });

  it('collapses onto the flagged segment when closed, leaving the other segment collapsed and disabled', () => {
    render(<FlagControl project={{ ...baseProject, flag: 'urgent' }} />);
    const root = screen.getByTestId('flag-control');
    expect(root).toHaveAttribute('data-open', 'false');

    const urgentWrapper = screen.getByTestId('flag-segment-urgent');
    expect(urgentWrapper.className).toContain('max-w-[9rem]');
    expect(urgentWrapper.className).toContain('opacity-100');
    expect(urgentWrapper).not.toHaveAttribute('aria-hidden');
    expect(within(urgentWrapper).getByRole('button')).not.toBeDisabled();

    const savWrapper = screen.getByTestId('flag-segment-sav');
    expect(savWrapper.className).toContain('max-w-0');
    expect(savWrapper.className).toContain('opacity-0');
    expect(savWrapper).toHaveAttribute('aria-hidden', 'true');
    expect(within(savWrapper).getByRole('button', { hidden: true })).toBeDisabled();
  });
});
