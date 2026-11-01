import { describe, expect, it, vi } from 'vitest';
import { createSourceStatus, type ViewerSource } from '../../../components/viewer/sourceStatus';

type S = { loading: boolean; stage?: string };
const idle: S = { loading: false };

describe('createSourceStatus', () => {
  it('shows only the status of the tab on screen', () => {
    const tab: ViewerSource = 'model';
    const emit = vi.fn<(s: S) => void>();
    const book = createSourceStatus<S>(idle, emit, () => tab);
    book.set('toolpath', { loading: true, stage: 'parse' });
    expect(emit).not.toHaveBeenCalled();
    book.set('model', { loading: true, stage: 'download' });
    expect(emit).toHaveBeenLastCalledWith({ loading: true, stage: 'download' });
  });

  it('a toolpath that finishes after the user switched to its tab clears the overlay', () => {
    let tab: ViewerSource = 'model';
    const emit = vi.fn<(s: S) => void>();
    const book = createSourceStatus<S>(idle, emit, () => tab);
    book.set('model', idle);
    book.set('toolpath', { loading: true, stage: 'parse' });
    tab = 'toolpath';
    book.show('toolpath');
    expect(emit).toHaveBeenLastCalledWith({ loading: true, stage: 'parse' });
    book.set('toolpath', { loading: true, stage: 'prepare' });
    book.set('toolpath', idle);
    expect(emit).toHaveBeenLastCalledWith(idle);
  });

  it('switching back to a loaded model drops a toolpath that is still loading', () => {
    let tab: ViewerSource = 'toolpath';
    const emit = vi.fn<(s: S) => void>();
    const book = createSourceStatus<S>(idle, emit, () => tab);
    book.set('model', idle);
    book.set('toolpath', { loading: true, stage: 'download' });
    tab = 'model';
    book.show('model');
    expect(emit).toHaveBeenLastCalledWith(idle);
    expect(book.get('toolpath')).toEqual({ loading: true, stage: 'download' });
  });
});
