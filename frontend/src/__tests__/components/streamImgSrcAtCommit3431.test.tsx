import { StrictMode, Suspense, useRef } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render as rawRender, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { spyOnStreamSrc } from '../streamImgSpy';
import { useStreamImgRef } from '../../hooks/useStreamImgRef';
import { UpdatedStreamOverlay } from '../../components/UpdatedStreamOverlay';

// A camera overlay that mounted while the page was still loading opened about
// twenty MJPEG streams: React set each img's src while rendering, threw most
// of those renders away, and the browser kept every one of their requests open
// on an img that never reached the page (#3431). A stream src now only ever
// reaches an img that is in the document.

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

/** Suspends its first render, so React throws away the render beside it. */
function suspendOnce() {
  let done = false;
  let resolve!: () => void;
  const promise = new Promise<void>(r => {
    resolve = () => {
      done = true;
      r();
    };
  });
  function Gate() {
    if (!done) throw promise;
    return null;
  }
  return { Gate, release: () => act(async () => resolve()) };
}

let spy: ReturnType<typeof spyOnStreamSrc>;

beforeEach(() => {
  spy = spyOnStreamSrc();
  localStorage.clear();
  server.use(
    http.post('/api/v1/printers/:id/camera/stop', () => HttpResponse.json({ success: true })),
    http.get('/api/v1/printers/:id/camera/status', () => HttpResponse.json({ active: true, stalled: false })),
  );
});

afterEach(() => {
  spy.restore();
  vi.restoreAllMocks();
});

describe('useStreamImgRef', () => {
  function Stream({ src, onRender }: { src: string | undefined; onRender?: () => void }) {
    const imgRef = useRef<HTMLImageElement | null>(null);
    const attach = useStreamImgRef(imgRef, src);
    onRender?.();
    return <img ref={attach} alt="s" />;
  }

  it('gives the img its src once it is in the page', async () => {
    rawRender(<Stream src="/api/v1/printers/1/camera/stream?t=1" />);

    expect(screen.getByAltText('s').getAttribute('src')).toBe('/api/v1/printers/1/camera/stream?t=1');
    expect(spy.detached()).toEqual([]);
  });

  it('follows a new URL and removes it when there is none', async () => {
    const view = rawRender(<Stream src="/api/v1/printers/1/camera/stream?t=1" />);
    view.rerender(<Stream src="/api/v1/printers/1/camera/stream?t=2" />);
    expect(screen.getByAltText('s').getAttribute('src')).toBe('/api/v1/printers/1/camera/stream?t=2');

    view.rerender(<Stream src={undefined} />);
    expect(screen.getByAltText('s').hasAttribute('src')).toBe(false);
    view.rerender(<Stream src="" />);
    expect(screen.getByAltText('s').hasAttribute('src')).toBe(false);
  });

  it('does not reopen a stream the component closed itself on an unrelated re-render', async () => {
    const view = rawRender(<Stream src="/api/v1/printers/1/camera/stream?t=1" />);
    const img = screen.getByAltText('s');
    img.setAttribute('src', ''); // what the viewers' reconnect and restart code does

    view.rerender(<Stream src="/api/v1/printers/1/camera/stream?t=1" onRender={() => {}} />);

    expect(img.getAttribute('src')).toBe('');
  });

  it('sets the src once when React attaches the img twice (StrictMode)', async () => {
    // Setting the same src again restarts the request: a second stream.
    rawRender(
      <StrictMode>
        <Stream src="/api/v1/printers/1/camera/stream?t=1" />
      </StrictMode>,
    );

    expect(spy.records).toHaveLength(1);
    expect(screen.getByAltText('s').getAttribute('src')).toBe('/api/v1/printers/1/camera/stream?t=1');
  });

  it('opens nothing for a render React throws away', async () => {
    const { Gate, release } = suspendOnce();
    rawRender(
      <Suspense fallback={null}>
        <Stream src="/api/v1/printers/1/camera/stream?t=1" />
        <Gate />
      </Suspense>,
    );
    await settle();
    await release();

    expect(spy.leaked()).toEqual([]);
    expect(screen.getByAltText('s').getAttribute('src')).toContain('/camera/stream');
  });
});

describe('every camera view sets the stream src at commit', () => {
  // Fenrir: the floating viewer draws to a canvas and there is no camera wall tile.
  it('the stream overlay artwork', async () => {
    render(
      <UpdatedStreamOverlay
        size="medium"
        camera={{ url: '/api/v1/printers/3/camera/stream?t=1', rotation: 0, onError: () => {} }}
        name="Workshop"
        model={null}
        filename={null}
        status={null}
        state={null}
        progress={null}
        layers={null}
        remaining={null}
        eta={null}
        temperatures={[]}
      />,
    );
    await settle();

    expect(screen.getByAltText('Camera stream').getAttribute('src')).toContain('/api/v1/printers/3/camera/stream');
    expect(spy.detached()).toEqual([]);
  });
});
