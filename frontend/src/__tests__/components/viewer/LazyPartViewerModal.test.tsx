import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../../components/viewer/PartViewerModal', () => ({
  PartViewerModal: ({ title }: { title: string }) => <div data-testid="real-viewer">{title}</div>,
}));
vi.mock('../../../components/LibraryFileDetailsModal', () => ({
  LibraryFileDetailsModal: () => <div data-testid="real-details" />,
}));

import { PartViewerModal } from '../../../components/viewer/LazyPartViewerModal';
import { LibraryFileDetailsModal } from '../../../components/LazyLibraryFileDetailsModal';

/** The viewer pulls three.js (730 KB raw) and jszip; the details modal is
 *  another 23 KB. Both open from a click, so they load from their own chunks
 *  when first opened, behind a full-screen shield so a second click cannot
 *  open a second instance while the chunk is in flight. */
describe('lazy modal wrappers', () => {
  it('shows a loading shield until the viewer chunk resolves', async () => {
    render(
      <PartViewerModal
        subject={{ kind: 'library', fileId: 1, fileType: '3mf', filename: 'a.3mf', nozzleDiameter: null }}
        title="Bracket"
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId('viewer-loading')).toBeInTheDocument();
    expect(await screen.findByTestId('real-viewer')).toHaveTextContent('Bracket');
    expect(screen.queryByTestId('viewer-loading')).toBeNull();
  });

  it('renders the details modal from its own chunk', async () => {
    render(<LibraryFileDetailsModal file={{ id: 1 } as never} canEdit={false} onClose={() => {}} />);
    expect(await screen.findByTestId('real-details')).toBeInTheDocument();
  });

  it('loads its chunk through lazyPage, which reloads once after a redeploy deleted it', () => {
    // A tab from before a deploy clicks Preview after the old chunk is gone;
    // a bare lazy() would throw into the root error boundary (#3175).
    for (const rel of ['../../../components/viewer/LazyPartViewerModal.tsx', '../../../components/LazyLibraryFileDetailsModal.tsx', '../../../components/ConfirmOutcomeDialog.tsx']) {
      const src = readFileSync(join(__dirname, rel), 'utf8');
      expect(src, rel).toMatch(/lazyPage\(\(\) => import\(/);
      expect(src, rel).not.toMatch(/\blazy\(\(\) => import\(/);
    }
  });
});
