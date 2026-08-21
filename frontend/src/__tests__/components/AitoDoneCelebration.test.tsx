/**
 * When the board celebrates, and when it must not.
 *
 * The rule lives in `useColumnMoveMutation` because that hook is the board's
 * ONE manual transition and both surfaces that offer it — the card's check and
 * the detail panel's pill — go through it. Testing it at the hook is testing
 * it for both.
 *
 * The canvas itself is not exercised here: jsdom has no 2d context, so the
 * renderer is a documented no-op there (see render.ts). What is exercised is
 * everything around it — which move fires a burst, where the burst starts, and
 * the reduced-motion gate, which is the one behaviour a user can actually be
 * harmed by getting wrong.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useContext } from 'react';
import { render, screen, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CelebrationProvider } from '../../components/aito/celebration/CelebrationLayer';
import { CelebrationContext } from '../../components/aito/celebration/context';
import { useColumnMoveMutation } from '../../hooks/useColumnMoveMutation';
import { api, type AitoProject } from '../../api/client';

const celebrateSpy = vi.fn();

// The provider is mounted for the reduced-motion suite below and stubbed for
// the trigger suite: what the trigger owes is a CALL with the right origin,
// and asserting that through a canvas jsdom cannot draw would test nothing.
vi.mock('../../components/aito/celebration/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components/aito/celebration/context')>();
  return { ...actual, useCelebration: () => celebrateSpy };
});

vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

function project(overrides: Partial<AitoProject> = {}): AitoProject {
  return {
    id: 7,
    description: 'Support de caméra',
    column: 'finish',
    move_lock: null,
    version: 1,
    ...overrides,
  } as AitoProject;
}

const CARD_RECT = { left: 100, top: 200, width: 300, height: 120 } as DOMRect;

function Harness({ column, origin }: { column: 'done' | 'finish'; origin?: () => DOMRect | null }) {
  const move = useColumnMoveMutation(project(), column, origin);
  return (
    <button type="button" onClick={() => move.mutate()}>
      move
    </button>
  );
}

function renderHarness(column: 'done' | 'finish', origin?: () => DOMRect | null) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Harness column={column} origin={origin} />
    </QueryClientProvider>,
  );
}

describe('the board celebrates a project reaching Done', () => {
  beforeEach(() => {
    celebrateSpy.mockClear();
    vi.spyOn(api, 'moveAitoProject').mockResolvedValue(project({ column: 'done' }));
  });

  afterEach(() => vi.restoreAllMocks());

  it('fires from the card that was archived', async () => {
    renderHarness('done', () => CARD_RECT);
    await act(async () => {
      screen.getByText('move').click();
    });
    expect(celebrateSpy).toHaveBeenCalledTimes(1);
    // The card's own rect, not the viewport centre: the burst has to come out
    // of the thing that was finished.
    expect(celebrateSpy).toHaveBeenCalledWith(CARD_RECT);
  });

  it('does not fire when a project is pulled back OUT of Done', async () => {
    // Un-archiving is the same hook and the same endpoint. Celebrating it
    // would reward undoing the thing being rewarded.
    renderHarness('finish', () => CARD_RECT);
    await act(async () => {
      screen.getByText('move').click();
    });
    expect(celebrateSpy).not.toHaveBeenCalled();
  });

  it('archives normally when the caller has no origin to offer', async () => {
    // The done grid and any future caller: the move must still work, it just
    // has nowhere to celebrate from.
    renderHarness('done');
    await act(async () => {
      screen.getByText('move').click();
    });
    expect(api.moveAitoProject).toHaveBeenCalledWith(7, { column: 'done', position: 0 });
    expect(celebrateSpy).not.toHaveBeenCalled();
  });
});

describe('the celebration layer honours reduced motion', () => {
  const matchMedia = (reduce: boolean) =>
    vi.fn().mockImplementation((query: string) => ({
      matches: reduce && query.includes('reduce'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }));

  function Trigger() {
    // Straight off the context, not through `useCelebration`: that hook is
    // stubbed for the trigger suite above, and this suite is about what the
    // real provider puts INTO the context.
    const celebrate = useContext(CelebrationContext);
    return (
      <button type="button" onClick={() => celebrate({ x: 10, y: 10 })}>
        fire
      </button>
    );
  }

  afterEach(() => vi.restoreAllMocks());

  it('starts a frame loop for a normal user', () => {
    window.matchMedia = matchMedia(false);
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
    render(
      <CelebrationProvider>
        <Trigger />
      </CelebrationProvider>,
    );
    act(() => screen.getByText('fire').click());
    expect(raf).toHaveBeenCalled();
  });

  it('does nothing at all when the OS asks for reduced motion', () => {
    window.matchMedia = matchMedia(true);
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
    render(
      <CelebrationProvider>
        <Trigger />
      </CelebrationProvider>,
    );
    act(() => screen.getByText('fire').click());
    // Not a shorter burst, not a static flash: no work is scheduled at all.
    expect(raf).not.toHaveBeenCalled();
  });
});
