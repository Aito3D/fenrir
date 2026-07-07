/**
 * Tests for BulkTagsPickerModal (#1268).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BulkTagsPickerModal } from '../../components/BulkTagsPickerModal';
import { api } from '../../api/client';

const mockShowToast = vi.fn();
const mockOnClose = vi.fn();

vi.mock('../../api/client', () => ({
  api: {
    getLibraryTags: vi.fn(),
    createLibraryTag: vi.fn(),
    bulkAssignLibraryTags: vi.fn(),
  },
}));

vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}));

const tags = [
  { id: 1, name: 'toy', file_count: 2, created_at: '2026-01-01', updated_at: '2026-01-01' },
  { id: 2, name: 'petg', file_count: 7, created_at: '2026-01-01', updated_at: '2026-01-01' },
];

function renderModal(
  fileIds: number[] = [10, 11, 12],
  extraProps: { singleMode?: boolean; initialTagIds?: number[] } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <BulkTagsPickerModal open fileIds={fileIds} onClose={mockOnClose} {...extraProps} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('BulkTagsPickerModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.getLibraryTags as ReturnType<typeof vi.fn>).mockResolvedValue(tags);
    // Mock scrollIntoView which is not available in jsdom (keyboard
    // navigation keeps the highlighted row in view).
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('lists existing tags from the catalog', async () => {
    renderModal();
    expect(await screen.findByText('toy')).toBeInTheDocument();
    expect(screen.getByText('petg')).toBeInTheDocument();
  });

  it('checking a tag and clicking Add applies it via bulkAssignLibraryTags', async () => {
    (api.bulkAssignLibraryTags as ReturnType<typeof vi.fn>).mockResolvedValue({
      files_updated: 3,
      associations_added: 3,
      associations_removed: 0,
    });
    const user = userEvent.setup();
    renderModal([10, 11, 12]);
    await screen.findByText('toy');

    const toyCheckbox = screen
      .getAllByRole('checkbox')
      .find((el) => el.parentElement?.textContent?.includes('toy'));
    expect(toyCheckbox).toBeDefined();
    await user.click(toyCheckbox!);

    await user.click(screen.getByRole('button', { name: /Add tags/i }));
    await waitFor(() => {
      expect(api.bulkAssignLibraryTags).toHaveBeenCalledWith([10, 11, 12], [1], 'add');
    });
  });

  it('switching to Remove changes the apply action', async () => {
    (api.bulkAssignLibraryTags as ReturnType<typeof vi.fn>).mockResolvedValue({
      files_updated: 3,
      associations_added: 0,
      associations_removed: 3,
    });
    const user = userEvent.setup();
    renderModal([10, 11, 12]);
    await screen.findByText('toy');

    // Pick the Remove radio.
    await user.click(screen.getByRole('radio', { name: /Remove from selected files/i }));

    const petgCheckbox = screen
      .getAllByRole('checkbox')
      .find((el) => el.parentElement?.textContent?.includes('petg'));
    await user.click(petgCheckbox!);

    await user.click(screen.getByRole('button', { name: /Remove tags/i }));
    await waitFor(() => {
      expect(api.bulkAssignLibraryTags).toHaveBeenCalledWith([10, 11, 12], [2], 'remove');
    });
  });

  it('apply is disabled when no tag is selected', async () => {
    renderModal();
    await screen.findByText('toy');
    expect(screen.getByRole('button', { name: /Add tags/i })).toBeDisabled();
  });

  it('Enter on a novel name creates the tag and auto-selects it', async () => {
    (api.createLibraryTag as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 3,
      name: 'benchy',
      file_count: 0,
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    });
    const user = userEvent.setup();
    renderModal();
    await screen.findByText('toy');

    const input = screen.getByPlaceholderText('Filter tags...');
    await user.type(input, 'benchy{Enter}');

    await waitFor(() => {
      expect(api.createLibraryTag).toHaveBeenCalledWith('benchy');
    });
    // The created tag lands in the selection → apply becomes enabled.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Add tags/i })).toBeEnabled();
    });
  });

  it('Enter on an exact match toggles it instead of creating', async () => {
    const user = userEvent.setup();
    renderModal();
    await screen.findByText('toy');

    const input = screen.getByPlaceholderText('Filter tags...');
    await user.type(input, 'toy{Enter}');

    expect(api.createLibraryTag).not.toHaveBeenCalled();
    // toy got selected → apply enabled.
    expect(screen.getByRole('button', { name: /Add tags/i })).toBeEnabled();
  });

  it('single-file mode hides the radios, pre-selects, and applies with replace', async () => {
    (api.bulkAssignLibraryTags as ReturnType<typeof vi.fn>).mockResolvedValue({
      files_updated: 1,
      associations_added: 1,
      associations_removed: 0,
    });
    const user = userEvent.setup();
    renderModal([10], { singleMode: true, initialTagIds: [1] });
    await screen.findByText('petg');

    // No Add/Remove radios in single mode.
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();

    // Deselect the pre-seeded 'toy', select 'petg' instead.
    const boxes = screen.getAllByRole('checkbox');
    const toyBox = boxes.find((el) => el.parentElement?.textContent?.includes('toy'));
    const petgBox = boxes.find((el) => el.parentElement?.textContent?.includes('petg'));
    expect(toyBox).toBeChecked();
    await user.click(toyBox!);
    await user.click(petgBox!);

    await user.click(screen.getByRole('button', { name: /Save/i }));
    await waitFor(() => {
      expect(api.bulkAssignLibraryTags).toHaveBeenCalledWith([10], [2], 'replace');
    });
  });

  describe('keyboard navigation', () => {
    // List order is frozen per-open: with no initialTagIds it's alphabetical,
    // so the fixture renders as [petg, toy].

    function checkboxFor(name: string) {
      return screen.getAllByRole('checkbox').find((el) => el.parentElement?.textContent?.includes(name));
    }

    it('ArrowDown highlights the first tag and Enter toggles it', async () => {
      const user = userEvent.setup();
      renderModal();
      await screen.findByText('toy');

      const input = screen.getByPlaceholderText('Filter tags...');
      await user.click(input);
      await user.keyboard('{ArrowDown}{Enter}');

      expect(checkboxFor('petg')).toBeChecked();
      expect(checkboxFor('toy')).not.toBeChecked();
      // Toggling via highlight must not create anything or close the modal.
      expect(api.createLibraryTag).not.toHaveBeenCalled();
      expect(api.bulkAssignLibraryTags).not.toHaveBeenCalled();
    });

    it('arrows move the highlight and Space toggles the highlighted tag', async () => {
      const user = userEvent.setup();
      renderModal();
      await screen.findByText('toy');

      await user.click(screen.getByPlaceholderText('Filter tags...'));
      await user.keyboard('{ArrowDown}{ArrowDown} ');

      expect(checkboxFor('toy')).toBeChecked();
      expect(checkboxFor('petg')).not.toBeChecked();

      // Space toggles the same highlighted row back off.
      await user.keyboard(' ');
      expect(checkboxFor('toy')).not.toBeChecked();
    });

    it('Enter prefers the highlight over creating from the typed filter', async () => {
      const user = userEvent.setup();
      renderModal();
      await screen.findByText('toy');

      // 't' matches both fixture tags; typing clears any highlight, then
      // ArrowDown re-highlights the first filtered row.
      await user.click(screen.getByPlaceholderText('Filter tags...'));
      await user.keyboard('t{ArrowDown}{Enter}');

      expect(api.createLibraryTag).not.toHaveBeenCalled();
      expect(checkboxFor('petg')).toBeChecked();
    });

    it('Escape clears the highlight first, closing only on the second press', async () => {
      const user = userEvent.setup();
      renderModal();
      await screen.findByText('toy');

      await user.click(screen.getByPlaceholderText('Filter tags...'));
      await user.keyboard('{ArrowDown}{Escape}');
      expect(mockOnClose).not.toHaveBeenCalled();

      await user.keyboard('{Escape}');
      expect(mockOnClose).toHaveBeenCalled();
    });

    it('toggling does not reorder the list mid-session', async () => {
      const user = userEvent.setup();
      renderModal();
      await screen.findByText('toy');

      const namesBefore = screen.getAllByRole('checkbox').map((el) => el.parentElement?.textContent);
      await user.click(screen.getByPlaceholderText('Filter tags...'));
      await user.keyboard('{ArrowDown}{ArrowDown} ');
      const namesAfter = screen.getAllByRole('checkbox').map((el) => el.parentElement?.textContent);

      expect(namesAfter).toEqual(namesBefore);
    });
  });
});
