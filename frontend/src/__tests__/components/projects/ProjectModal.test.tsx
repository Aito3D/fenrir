/**
 * Tests for the project edit dialog (ProjectModal), opened from the project detail page.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils';
import { ProjectModal } from '../../../components/projects/ProjectModal';
import { eligibleParents } from '../../../utils/projectTree';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';

const mockProjects = [
  {
    id: 1,
    name: 'Functional Parts',
    description: 'Useful household items',
    color: '#00ae42',
    archive_count: 10,
    total_print_time_seconds: 36000,
    total_filament_grams: 500,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-15T00:00:00Z',
  },
  {
    id: 2,
    name: 'Art Collection',
    description: 'Decorative prints',
    color: '#ff5500',
    archive_count: 5,
    total_print_time_seconds: 18000,
    total_filament_grams: 200,
    created_at: '2024-01-05T00:00:00Z',
    updated_at: '2024-01-10T00:00:00Z',
  },
];

describe('ProjectModal', () => {
  beforeEach(() => {
    server.use(
      http.get('/api/v1/projects/', () => {
        return HttpResponse.json(mockProjects);
      }),
      http.post('/api/v1/projects/', async ({ request }) => {
        const body = await request.json() as { name: string };
        return HttpResponse.json({ id: 3, name: body.name, color: '#00ae42', archive_count: 0 });
      }),
      http.delete('/api/v1/projects/:id', () => {
        return HttpResponse.json({ success: true });
      })
    );
  });

  describe('modal scrolls on short viewports (#1642)', () => {
    /**
     * Reporter on a Pi screen couldn't reach the Save button when editing a
     * project because the modal had no max-h / overflow. The structural fix
     * puts a max-h on the card, the form fields in a `flex-1 overflow-y-auto`
     * wrapper, and the Save/Cancel buttons in a `flex-shrink-0` sibling so
     * they're always visible regardless of scroll position.
     *
     * jsdom doesn't compute layout heights so we can't simulate the actual
     * overflow. We pin the structure instead: the scrollable wrapper exists,
     * the Save button is NOT a descendant of it, and the card has a max-h.
     * A future refactor that removes any of these would re-introduce the bug.
     */
    const editableProject = {
      id: 7,
      name: 'Spool holder',
      description: null,
      color: '#00ae42',
      url: null,
      cover_image_filename: null,
      archive_count: 0,
      total_print_time_seconds: 0,
      total_filament_grams: 0,
      target_plates_count: null,
      target_parts_count: null,
      tags: null,
      due_date: null,
      priority: null,
      budget: null,
      status: 'active' as const,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    };

    it('renders the action footer outside the scrollable fields wrapper', () => {
      render(
        <ProjectModal
          project={editableProject}
          onClose={() => {}}
          onSave={() => {}}
          isLoading={false}
          currencySymbol="€"
          t={((k: string) => k) as never}
        />,
      );

      const saveButton = screen.getByRole('button', { name: 'common.save' });
      const scrollable = document.querySelector('.overflow-y-auto');
      expect(scrollable).not.toBeNull();
      // The save button must live OUTSIDE the scrollable region — otherwise
      // a long form pushes it below the fold on short viewports (#1642).
      expect(scrollable!.contains(saveButton)).toBe(false);
    });

    it('caps the modal card height so it cannot exceed the viewport', () => {
      render(
        <ProjectModal
          project={editableProject}
          onClose={() => {}}
          onSave={() => {}}
          isLoading={false}
          currencySymbol="€"
          t={((k: string) => k) as never}
        />,
      );

      // Card has max-h set so it never extends past the viewport — without
      // this, vertical-center alignment pushes the bottom of the modal
      // (including the action footer) off-screen.
      const card = document.querySelector('.max-h-\\[calc\\(100vh-2rem\\)\\]');
      expect(card).not.toBeNull();
    });
  });

  describe('edit dialog seeds itself from the list payload (#2536)', () => {
    /**
     * The same ProjectModal is opened from the projects list and from the
     * project detail page. The detail page hands it a full project; the list
     * hands it a list item. Reporter saw an empty tags field when editing from
     * the list, because the list payload didn't carry tags — and, unreported,
     * the dialog then submitted its default priority over the stored one.
     */
    const listItem = {
      id: 7,
      name: 'Spool holder',
      description: null,
      color: '#00ae42',
      status: 'active',
      target_count: null,
      target_parts_count: null,
      budget: null,
      tags: 'prototype,client-work',
      due_date: '2026-08-01T12:00:00Z',
      priority: 'high',
      created_at: '2024-01-01T00:00:00Z',
      archive_count: 0,
      total_items: 0,
      completed_count: 0,
      failed_count: 0,
      queue_count: 0,
      progress_percent: null,
      archives: [],
      url: null,
      cover_image_filename: null,
    };

    const renderModal = (onSave: (data: unknown) => void) =>
      render(
        <ProjectModal
          project={listItem}
          onClose={() => {}}
          onSave={onSave as never}
          isLoading={false}
          currencySymbol="€"
          t={((k: string) => k) as never}
        />,
      );

    const tagsInput = () => screen.getByPlaceholderText('projects.tagsPlaceholder') as HTMLInputElement;
    const dueDateInput = () => document.querySelector('input[type="date"]') as HTMLInputElement;
    const prioritySelect = () =>
      Array.from(document.querySelectorAll('select')).find((s) =>
        s.querySelector('option[value="urgent"]'),
      ) as HTMLSelectElement;

    it('prefills tags, due date and priority from a list item', () => {
      renderModal(() => {});

      expect(tagsInput().value).toBe('prototype,client-work');
      expect(dueDateInput().value).toBe('2026-08-01');
      expect(prioritySelect().value).toBe('high');
    });

    it('does not downgrade a stored priority when saving an untouched field', async () => {
      const user = userEvent.setup();
      const onSave = vi.fn();
      renderModal(onSave);

      await user.click(screen.getByRole('button', { name: 'common.save' }));

      // Before the fix the dialog fell back to its 'normal' default and sent
      // that, silently demoting a high/urgent project edited from the list.
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ priority: 'high', tags: 'prototype,client-work' }),
      );
    });

    it('sends null when an existing tag list is cleared', async () => {
      const user = userEvent.setup();
      const onSave = vi.fn();
      renderModal(onSave);

      await user.clear(tagsInput());
      await user.click(screen.getByRole('button', { name: 'common.save' }));

      // undefined would drop the key from the PATCH body and the backend would
      // keep the old tags — the field has to be cleared explicitly.
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ tags: null }));
    });
  });

  describe('nesting projects under a master project (#1264)', () => {
    const listItem = (over: Record<string, unknown>) => ({
      id: 1,
      name: 'Airframe',
      description: null,
      color: '#00ae42',
      status: 'active',
      target_count: null,
      target_parts_count: null,
      target_sets: null,
      budget: null,
      tags: null,
      due_date: null,
      priority: 'normal',
      created_at: '2024-01-01T00:00:00Z',
      archive_count: 0,
      total_items: 0,
      completed_count: 0,
      failed_count: 0,
      queue_count: 0,
      progress_percent: null,
      parent_id: null,
      child_count: 0,
      archives: [],
      url: null,
      cover_image_filename: null,
      ...over,
    });

    describe('eligibleParents', () => {
      it('offers every other project when creating a new one', () => {
        const projects = [listItem({ id: 1 }), listItem({ id: 2, name: 'Wing' })];

        expect(eligibleParents(projects, undefined).map((p) => p.id)).toEqual([1, 2]);
      });

      it('never offers the project itself', () => {
        const projects = [listItem({ id: 1 }), listItem({ id: 2, name: 'Wing' })];

        expect(eligibleParents(projects, 1).map((p) => p.id)).toEqual([2]);
      });

      it('never offers a project already nested underneath', () => {
        // The API rejects a cycle, so offering one would only produce an error
        // the user can do nothing about.
        const projects = [
          listItem({ id: 1 }),
          listItem({ id: 2, name: 'Wing', parent_id: 1 }),
          listItem({ id: 3, name: 'Unrelated' }),
        ];

        expect(eligibleParents(projects, 1).map((p) => p.id)).toEqual([3]);
      });

      it('excludes a grandchild listed before its own parent', () => {
        // Reversion-proof for a single-pass version: the list arrives in update
        // order, so a grandchild can precede the parent that blocks it.
        const projects = [
          listItem({ id: 3, name: 'Spar', parent_id: 2 }),
          listItem({ id: 2, name: 'Wing', parent_id: 1 }),
          listItem({ id: 1 }),
        ];

        expect(eligibleParents(projects, 1)).toEqual([]);
      });
    });

    it('sends 0 to clear a parent, because null would read as omitted', async () => {
      const user = userEvent.setup();
      const onSave = vi.fn();
      server.use(http.get('/api/v1/projects/', () => HttpResponse.json([listItem({ id: 9, name: 'Other' })])));

      render(
        <ProjectModal
          project={listItem({ id: 1, parent_id: 9 })}
          onClose={() => {}}
          onSave={onSave as never}
          isLoading={false}
          currencySymbol="EUR"
          t={((k: string) => k) as never}
        />,
      );

      const parentSelect = () =>
        Array.from(document.querySelectorAll('select')).find((s) =>
          s.querySelector('option[value=""]'),
        ) as HTMLSelectElement;
      await waitFor(() => expect(parentSelect().value).toBe('9'));

      await user.selectOptions(parentSelect(), '');
      await user.click(screen.getByRole('button', { name: 'common.save' }));

      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ parent_id: 0 }));
    });
  });

  describe('PDM header editor (pdm mode)', () => {
    /**
     * The project detail page opens ProjectModal with `pdm`: its header owns the
     * tags and a PDM project has no parent, so the modal must neither show those
     * fields nor send them, or saving would wipe the header's tag list.
     */
    const pdmProject = {
      id: 12,
      name: 'Support caméra',
      description: null,
      color: '#00ae42',
      status: 'active',
      target_count: null,
      target_parts_count: null,
      budget: null,
      tags: 'support,camera',
      due_date: null,
      priority: 'normal',
      parent_id: 9,
      created_at: '2024-01-01T00:00:00Z',
      archive_count: 0,
      url: null,
      cover_image_filename: null,
    };

    const renderModal = (onSave: (data: unknown) => void, pdm?: boolean) =>
      render(
        <ProjectModal
          project={pdmProject as never}
          onClose={() => {}}
          onSave={onSave as never}
          isLoading={false}
          currencySymbol="€"
          t={((k: string) => k) as never}
          pdm={pdm}
        />,
      );

    it('hides the parent picker and the tags field', () => {
      renderModal(() => {}, true);

      expect(screen.getByText('common.name')).toBeInTheDocument();
      expect(screen.queryByText('projects.parentLabel')).not.toBeInTheDocument();
      expect(screen.queryByText('projects.parentNone')).not.toBeInTheDocument();
      expect(screen.queryByText('projects.tagsLabel')).not.toBeInTheDocument();
      expect(screen.queryByPlaceholderText('projects.tagsPlaceholder')).not.toBeInTheDocument();
    });

    it('saves neither tags nor parent_id, even when the project has both', async () => {
      const user = userEvent.setup();
      const onSave = vi.fn();
      renderModal(onSave, true);

      await user.click(screen.getByRole('button', { name: 'common.save' }));

      expect(onSave).toHaveBeenCalledTimes(1);
      const payload = onSave.mock.calls[0][0];
      expect(payload).toMatchObject({ name: 'Support caméra', status: 'active' });
      expect(payload).not.toHaveProperty('tags');
      expect(payload).not.toHaveProperty('parent_id');
    });

    it('still shows and sends tags and parent_id for the same project without pdm', async () => {
      const user = userEvent.setup();
      const onSave = vi.fn();
      renderModal(onSave);

      expect(screen.getByText('projects.parentLabel')).toBeInTheDocument();
      expect(screen.getByText('projects.tagsLabel')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'common.save' }));

      expect(onSave).toHaveBeenCalledTimes(1);
      const payload = onSave.mock.calls[0][0];
      expect(payload).toHaveProperty('tags', 'support,camera');
      expect(payload).toHaveProperty('parent_id', 9);
    });
  });
});
