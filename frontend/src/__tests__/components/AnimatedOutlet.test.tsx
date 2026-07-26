import { describe, it, expect, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AnimatedOutlet } from '../../components/AnimatedOutlet';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<AnimatedOutlet />}>
          <Route path="/" element={<div>home</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  // @ts-expect-error test cleanup of the stub
  delete document.startViewTransition;
});

describe('AnimatedOutlet entrance vs view transitions', () => {
  it('uses animate-page-in when the browser has no View Transitions', () => {
    const { container } = renderAt('/');
    expect(container.querySelector('.animate-page-in')).not.toBeNull();
  });

  it('drops animate-page-in when document.startViewTransition exists', () => {
    // @ts-expect-error jsdom has no VT; stub it
    document.startViewTransition = () => ({});
    const { container } = renderAt('/');
    expect(container.querySelector('.animate-page-in')).toBeNull();
    expect(container.textContent).toContain('home');
  });
});
