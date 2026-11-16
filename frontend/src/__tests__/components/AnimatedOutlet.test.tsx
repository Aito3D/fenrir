import { describe, it, expect, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
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

// Stands in for a page: local state that a remount would reset.
function Counter() {
  const [n, setN] = useState(0);
  const navigate = useNavigate();
  return (
    <div>
      <button onClick={() => setN(n + 1)}>count {n}</button>
      <button onClick={() => navigate('/archives/7')}>open</button>
      <button onClick={() => navigate('/queue')}>leave</button>
    </div>
  );
}

function renderArchives() {
  return render(
    <MemoryRouter initialEntries={['/archives']}>
      <Routes>
        <Route element={<AnimatedOutlet />}>
          <Route path="/archives" element={<Counter />} />
          <Route path="/archives/:id" element={<Counter />} />
          <Route path="/queue" element={<Counter />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('AnimatedOutlet page identity', () => {
  it('keeps the Archives page mounted when an archive opens over it', () => {
    renderArchives();
    fireEvent.click(screen.getByText('count 0'));
    fireEvent.click(screen.getByText('open'));
    // Rebuilding the list behind the dialog froze the page and lost its state.
    expect(screen.getByText('count 1')).toBeInTheDocument();
  });

  it('still mounts a fresh page on navigation to another page', () => {
    renderArchives();
    fireEvent.click(screen.getByText('count 0'));
    fireEvent.click(screen.getByText('leave'));
    expect(screen.getByText('count 0')).toBeInTheDocument();
  });
});
