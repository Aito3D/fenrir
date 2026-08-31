/**
 * Tests for the FileUploadModal component.
 * Tests file upload, drag-and-drop, ZIP/3MF/STL detection, and autoUpload mode.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { FileUploadModal } from '../../components/FileUploadModal';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

// --- Hashing instrumentation used by the "duplicate-check concurrency" tests below ---
// jsdom's File has neither `arrayBuffer()` nor `text()`, so we give each test file its
// own `arrayBuffer` override (rather than relying on real file reads). This lets us:
//  - track how many hashes are in flight at once (proves the pool is bounded), and
//  - control completion order independently of input order (proves correct attribution).
let concurrentHashCalls = 0;
let peakConcurrentHashCalls = 0;
let hashCompletionOrder: string[] = [];

function resetHashInstrumentation() {
  concurrentHashCalls = 0;
  peakConcurrentHashCalls = 0;
  hashCompletionOrder = [];
}

function makeInstrumentedFile(
  content: string,
  name: string,
  opts: { delayMs?: number; fail?: boolean } = {},
): File {
  const file = new File([content], name, { type: 'application/octet-stream' });
  const buffer = new TextEncoder().encode(content).buffer;
  Object.defineProperty(file, 'arrayBuffer', {
    configurable: true,
    value: async () => {
      concurrentHashCalls++;
      peakConcurrentHashCalls = Math.max(peakConcurrentHashCalls, concurrentHashCalls);
      try {
        if (opts.delayMs) {
          await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
        }
        if (opts.fail) {
          throw new RangeError(`Array buffer allocation failed for ${name}`);
        }
        hashCompletionOrder.push(name);
        return buffer;
      } finally {
        concurrentHashCalls--;
      }
    },
  });
  return file;
}

describe('FileUploadModal', () => {
  const defaultProps = {
    folderId: null as number | null,
    onClose: vi.fn(),
    onUploadComplete: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetHashInstrumentation();

    server.use(
      http.post('/api/v1/library/files', () => {
        return HttpResponse.json({
          id: 1,
          filename: 'test.gcode.3mf',
          file_type: '3mf',
          file_size: 1048576,
          thumbnail_path: null,
          duplicate_of: null,
          metadata: null,
        });
      }),
      http.post('/api/v1/library/extract-zip', () => {
        return HttpResponse.json({
          extracted: 3,
          errors: [],
        });
      })
    );
  });

  describe('rendering', () => {
    it('renders the modal with title', () => {
      render(<FileUploadModal {...defaultProps} />);
      expect(screen.getByText('Upload Files')).toBeInTheDocument();
    });

    it('renders drag and drop zone', () => {
      render(<FileUploadModal {...defaultProps} />);
      expect(screen.getByText(/Drag & drop/)).toBeInTheDocument();
    });

    it('renders click to browse text', () => {
      render(<FileUploadModal {...defaultProps} />);
      expect(screen.getByText(/click to browse/i)).toBeInTheDocument();
    });

    it('renders Cancel button', () => {
      render(<FileUploadModal {...defaultProps} />);
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    });

    it('renders Upload button disabled when no files', () => {
      render(<FileUploadModal {...defaultProps} />);
      const uploadButton = screen.getByRole('button', { name: /Upload/i });
      expect(uploadButton).toBeDisabled();
    });

    it('shows all file types supported text', () => {
      render(<FileUploadModal {...defaultProps} />);
      expect(screen.getByText(/All file types supported/i)).toBeInTheDocument();
    });
  });

  describe('file selection', () => {
    it('shows added file in the list', async () => {
      const user = userEvent.setup();
      render(<FileUploadModal {...defaultProps} />);

      const file = new File(['content'], 'model.gcode.3mf', { type: 'application/octet-stream' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(fileInput, file);

      expect(screen.getByText('model.gcode.3mf')).toBeInTheDocument();
    });

    it('shows file size in MB', async () => {
      const user = userEvent.setup();
      render(<FileUploadModal {...defaultProps} />);

      const file = new File(['x'.repeat(1048576)], 'model.3mf', { type: 'application/octet-stream' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(fileInput, file);

      expect(screen.getByText('1.00 MB')).toBeInTheDocument();
    });

    it('enables Upload button when files are added', async () => {
      const user = userEvent.setup();
      render(<FileUploadModal {...defaultProps} />);

      const file = new File(['content'], 'model.3mf', { type: 'application/octet-stream' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(fileInput, file);

      const uploadButton = screen.getByRole('button', { name: /Upload \(1\)/i });
      expect(uploadButton).not.toBeDisabled();
    });

    it('shows file count in Upload button', async () => {
      const user = userEvent.setup();
      render(<FileUploadModal {...defaultProps} />);

      const files = [
        new File(['a'], 'file1.3mf', { type: 'application/octet-stream' }),
        new File(['b'], 'file2.stl', { type: 'application/octet-stream' }),
      ];
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(fileInput, files);

      expect(screen.getByRole('button', { name: /Upload \(2\)/i })).toBeInTheDocument();
    });

    it('accepts any file type (not restricted like UploadModal)', async () => {
      const user = userEvent.setup();
      render(<FileUploadModal {...defaultProps} />);

      const file = new File(['content'], 'readme.txt', { type: 'text/plain' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(fileInput, file);

      expect(screen.getByText('readme.txt')).toBeInTheDocument();
    });
  });

  describe('file removal', () => {
    it('removes a file when X button is clicked', async () => {
      const user = userEvent.setup();
      render(<FileUploadModal {...defaultProps} />);

      const file = new File(['content'], 'model.3mf', { type: 'application/octet-stream' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(fileInput, file);

      expect(screen.getByText('model.3mf')).toBeInTheDocument();

      const fileRow = screen.getByText('model.3mf').closest('.flex');
      const removeButton = fileRow?.querySelector('button');
      if (removeButton) {
        await user.click(removeButton);
      }

      await waitFor(() => {
        expect(screen.queryByText('model.3mf')).not.toBeInTheDocument();
      });
    });

    it('disables Upload button after removing all files', async () => {
      const user = userEvent.setup();
      render(<FileUploadModal {...defaultProps} />);

      const file = new File(['content'], 'model.3mf', { type: 'application/octet-stream' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(fileInput, file);

      const fileRow = screen.getByText('model.3mf').closest('.flex');
      const removeButton = fileRow?.querySelector('button');
      if (removeButton) {
        await user.click(removeButton);
      }

      await waitFor(() => {
        const uploadButton = screen.getByRole('button', { name: /Upload/i });
        expect(uploadButton).toBeDisabled();
      });
    });
  });

  describe('file type detection', () => {
    it('shows ZIP options when .zip file is added', async () => {
      const user = userEvent.setup();
      render(<FileUploadModal {...defaultProps} />);

      const zipFile = new File(['pk'], 'models.zip', { type: 'application/zip' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(fileInput, zipFile);

      await waitFor(() => {
        expect(screen.getByText('ZIP files detected')).toBeInTheDocument();
        expect(screen.getByText(/Preserve folder structure/)).toBeInTheDocument();
        expect(screen.getByText(/Create folder from ZIP/)).toBeInTheDocument();
      });
    });

    it('shows 3MF info when .3mf file is added', async () => {
      const user = userEvent.setup();
      render(<FileUploadModal {...defaultProps} />);

      const threemfFile = new File(['content'], 'model.gcode.3mf', { type: 'application/octet-stream' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(fileInput, threemfFile);

      await waitFor(() => {
        expect(screen.getByText('3MF files detected')).toBeInTheDocument();
      });
    });

    it('shows STL thumbnail option when .stl file is added', async () => {
      const user = userEvent.setup();
      render(<FileUploadModal {...defaultProps} />);

      const stlFile = new File(['solid'], 'bracket.stl', { type: 'application/sla' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(fileInput, stlFile);

      await waitFor(() => {
        expect(screen.getByText('STL thumbnail generation')).toBeInTheDocument();
        expect(screen.getByText(/Thumbnails can be generated/i)).toBeInTheDocument();
      });
    });

    it('shows STL thumbnail option when ZIP file is added (may contain STLs)', async () => {
      const user = userEvent.setup();
      render(<FileUploadModal {...defaultProps} />);

      const zipFile = new File(['pk'], 'models.zip', { type: 'application/zip' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(fileInput, zipFile);

      await waitFor(() => {
        expect(screen.getByText('STL thumbnail generation')).toBeInTheDocument();
        expect(screen.getByText(/ZIP files may contain STL/i)).toBeInTheDocument();
      });
    });
  });

  describe('ZIP options', () => {
    it('preserve structure checkbox is checked by default', async () => {
      const user = userEvent.setup();
      render(<FileUploadModal {...defaultProps} />);

      const zipFile = new File(['pk'], 'models.zip', { type: 'application/zip' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(fileInput, zipFile);

      await waitFor(() => {
        const label = screen.getByText(/Preserve folder structure/).closest('label');
        const checkbox = label?.querySelector('input[type="checkbox"]') as HTMLInputElement;
        expect(checkbox).toBeChecked();
      });
    });

    it('create folder checkbox is unchecked by default', async () => {
      const user = userEvent.setup();
      render(<FileUploadModal {...defaultProps} />);

      const zipFile = new File(['pk'], 'models.zip', { type: 'application/zip' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(fileInput, zipFile);

      await waitFor(() => {
        const label = screen.getByText(/Create folder from ZIP/).closest('label');
        const checkbox = label?.querySelector('input[type="checkbox"]') as HTMLInputElement;
        expect(checkbox).not.toBeChecked();
      });
    });

    it('can toggle ZIP options', async () => {
      const user = userEvent.setup();
      render(<FileUploadModal {...defaultProps} />);

      const zipFile = new File(['pk'], 'models.zip', { type: 'application/zip' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(fileInput, zipFile);

      await waitFor(() => {
        expect(screen.getByText('ZIP files detected')).toBeInTheDocument();
      });

      const preserveLabel = screen.getByText(/Preserve folder structure/).closest('label');
      const preserveCheckbox = preserveLabel?.querySelector('input[type="checkbox"]') as HTMLInputElement;
      await user.click(preserveCheckbox);
      expect(preserveCheckbox).not.toBeChecked();

      const createFolderLabel = screen.getByText(/Create folder from ZIP/).closest('label');
      const createFolderCheckbox = createFolderLabel?.querySelector('input[type="checkbox"]') as HTMLInputElement;
      await user.click(createFolderCheckbox);
      expect(createFolderCheckbox).toBeChecked();
    });
  });

  describe('upload flow', () => {
    it('calls onUploadComplete after successful upload', async () => {
      const user = userEvent.setup();
      render(<FileUploadModal {...defaultProps} />);

      const file = new File(['content'], 'model.3mf', { type: 'application/octet-stream' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(fileInput, file);

      const uploadButton = screen.getByRole('button', { name: /Upload \(1\)/i });
      await user.click(uploadButton);

      await waitFor(() => {
        expect(defaultProps.onUploadComplete).toHaveBeenCalled();
      });
    });

    it('calls onFileUploaded with response data for each file', async () => {
      const onFileUploaded = vi.fn();
      const user = userEvent.setup();
      render(<FileUploadModal {...defaultProps} onFileUploaded={onFileUploaded} />);

      const file = new File(['content'], 'model.3mf', { type: 'application/octet-stream' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(fileInput, file);

      const uploadButton = screen.getByRole('button', { name: /Upload \(1\)/i });
      await user.click(uploadButton);

      await waitFor(() => {
        expect(onFileUploaded).toHaveBeenCalledWith(
          expect.objectContaining({
            id: 1,
            filename: 'test.gcode.3mf',
          })
        );
      });
    });

    it('shows uploading state while uploading', async () => {
      // Delay the response to observe uploading state
      server.use(
        http.post('/api/v1/library/files', async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return HttpResponse.json({
            id: 1,
            filename: 'model.3mf',
            file_type: '3mf',
            file_size: 1024,
            thumbnail_path: null,
            duplicate_of: null,
            metadata: null,
          });
        })
      );

      const user = userEvent.setup();
      render(<FileUploadModal {...defaultProps} />);

      const file = new File(['content'], 'model.3mf', { type: 'application/octet-stream' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(fileInput, file);

      const uploadButton = screen.getByRole('button', { name: /Upload \(1\)/i });
      await user.click(uploadButton);

      // Should show uploading state
      await waitFor(() => {
        expect(screen.getByText('Uploading...')).toBeInTheDocument();
        expect(document.querySelector('.animate-spin')).toBeInTheDocument();
      });
    });

    it('shows error state on upload failure', async () => {
      server.use(
        http.post('/api/v1/library/files', () => {
          return HttpResponse.json({ detail: 'File too large' }, { status: 413 });
        })
      );

      const user = userEvent.setup();
      render(<FileUploadModal {...defaultProps} />);

      const file = new File(['content'], 'model.3mf', { type: 'application/octet-stream' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(fileInput, file);

      const uploadButton = screen.getByRole('button', { name: /Upload \(1\)/i });
      await user.click(uploadButton);

      await waitFor(() => {
        expect(defaultProps.onUploadComplete).toHaveBeenCalled();
      });
    });

    it('closes modal after manual upload completes', async () => {
      const user = userEvent.setup();
      render(<FileUploadModal {...defaultProps} />);

      const file = new File(['content'], 'model.3mf', { type: 'application/octet-stream' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(fileInput, file);

      const uploadButton = screen.getByRole('button', { name: /Upload \(1\)/i });
      await user.click(uploadButton);

      await waitFor(() => {
        expect(defaultProps.onUploadComplete).toHaveBeenCalled();
        expect(defaultProps.onClose).toHaveBeenCalled();
      });
    });
  });

  describe('autoUpload mode', () => {
    it('uploads immediately when file is added', async () => {
      const onFileUploaded = vi.fn();
      const user = userEvent.setup();
      render(
        <FileUploadModal
          {...defaultProps}
          autoUpload
          onFileUploaded={onFileUploaded}
        />
      );

      const file = new File(['content'], 'model.gcode.3mf', { type: 'application/octet-stream' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(fileInput, file);

      await waitFor(() => {
        expect(onFileUploaded).toHaveBeenCalledWith(
          expect.objectContaining({ id: 1 })
        );
      });
    });

    it('calls onClose after autoUpload completes', async () => {
      const user = userEvent.setup();
      render(<FileUploadModal {...defaultProps} autoUpload />);

      const file = new File(['content'], 'model.gcode.3mf', { type: 'application/octet-stream' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(fileInput, file);

      await waitFor(() => {
        expect(defaultProps.onClose).toHaveBeenCalled();
        expect(defaultProps.onUploadComplete).toHaveBeenCalled();
      });
    });
  });

  describe('close behavior', () => {
    it('calls onClose when Cancel button is clicked', async () => {
      const user = userEvent.setup();
      render(<FileUploadModal {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(defaultProps.onClose).toHaveBeenCalled();
    });

    it('calls onClose when X button is clicked', async () => {
      const user = userEvent.setup();
      render(<FileUploadModal {...defaultProps} />);

      // The X button is the one in the header (not file remove buttons)
      const headerButtons = screen.getByText('Upload Files').parentElement?.querySelectorAll('button');
      const closeButton = headerButtons?.[0];

      if (closeButton) {
        await user.click(closeButton);
        expect(defaultProps.onClose).toHaveBeenCalled();
      }
    });

    it('always shows Cancel button (modal auto-closes after upload)', () => {
      render(<FileUploadModal {...defaultProps} />);
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    });
  });

  describe('drag and drop', () => {
    it('highlights drop zone on drag over', () => {
      render(<FileUploadModal {...defaultProps} />);

      const dropZone = screen.getByText(/Drag & drop/).closest('div[class*="border-dashed"]');

      if (dropZone) {
        fireEvent.dragOver(dropZone, { dataTransfer: { files: [] } });
        expect(dropZone.className).toContain('border-bambu-green');
      }
    });

    it('removes highlight on drag leave', () => {
      render(<FileUploadModal {...defaultProps} />);

      const dropZone = screen.getByText(/Drag & drop/).closest('div[class*="border-dashed"]');

      if (dropZone) {
        fireEvent.dragOver(dropZone, { dataTransfer: { files: [] } });
        fireEvent.dragLeave(dropZone, { dataTransfer: { files: [] } });
        expect(dropZone.className).not.toContain('bg-bambu-green');
      }
    });
  });

  describe('folder context', () => {
    it('accepts folderId prop for uploading to specific folder', () => {
      render(<FileUploadModal {...defaultProps} folderId={5} />);
      // Component should render without errors with a folder context
      expect(screen.getByText('Upload Files')).toBeInTheDocument();
    });
  });

  describe('validateFile prop', () => {
    it('rejects files that fail validation and shows error', async () => {
      const user = userEvent.setup();
      render(
        <FileUploadModal
          {...defaultProps}
          validateFile={(file) => {
            if (!file.name.endsWith('.gcode')) return 'Only .gcode files allowed';
          }}
        />
      );

      const file = new File(['content'], 'model.stl', { type: 'application/octet-stream' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(fileInput, file);

      // Error should be shown
      expect(screen.getByText('Only .gcode files allowed')).toBeInTheDocument();
      // File should NOT be added to the list
      expect(screen.queryByText('model.stl')).not.toBeInTheDocument();
    });

    it('allows files that pass validation', async () => {
      const user = userEvent.setup();
      render(
        <FileUploadModal
          {...defaultProps}
          validateFile={(file) => {
            if (!file.name.endsWith('.gcode')) return 'Only .gcode files allowed';
          }}
        />
      );

      const file = new File(['content'], 'model.gcode', { type: 'application/octet-stream' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(fileInput, file);

      expect(screen.getByText('model.gcode')).toBeInTheDocument();
      expect(screen.queryByText('Only .gcode files allowed')).not.toBeInTheDocument();
    });

    it('clears validation error when a new file is added', async () => {
      const user = userEvent.setup();
      render(
        <FileUploadModal
          {...defaultProps}
          validateFile={(file) => {
            if (!file.name.endsWith('.gcode')) return 'Only .gcode files allowed';
          }}
        />
      );

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;

      // First add an invalid file
      const badFile = new File(['content'], 'model.stl', { type: 'application/octet-stream' });
      await user.upload(fileInput, badFile);
      expect(screen.getByText('Only .gcode files allowed')).toBeInTheDocument();

      // Then add a valid file — error should clear
      const goodFile = new File(['content'], 'model.gcode', { type: 'application/octet-stream' });
      await user.upload(fileInput, goodFile);
      expect(screen.queryByText('Only .gcode files allowed')).not.toBeInTheDocument();
    });
  });

  describe('accept prop', () => {
    it('sets accept attribute on file input', () => {
      render(<FileUploadModal {...defaultProps} accept=".gcode,.gcode.3mf" />);
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      expect(fileInput.accept).toBe('.gcode,.gcode.3mf');
    });

    it('does not set accept attribute when prop is omitted', () => {
      render(<FileUploadModal {...defaultProps} />);
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      expect(fileInput.accept).toBe('');
    });
  });

  describe('onFileUploaded error handling', () => {
    it('shows error and keeps modal open when onFileUploaded returns a string', async () => {
      const user = userEvent.setup();
      render(
        <FileUploadModal
          {...defaultProps}
          onFileUploaded={() => 'This file was sliced for the wrong printer'}
        />
      );

      const file = new File(['content'], 'model.3mf', { type: 'application/octet-stream' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(fileInput, file);

      const uploadButton = screen.getByRole('button', { name: /Upload \(1\)/i });
      await user.click(uploadButton);

      await waitFor(() => {
        expect(screen.getByText('This file was sliced for the wrong printer')).toBeInTheDocument();
      });

      // Modal should NOT close
      expect(defaultProps.onClose).not.toHaveBeenCalled();
    });

    it('clears file list when onFileUploaded returns an error', async () => {
      const user = userEvent.setup();
      render(
        <FileUploadModal
          {...defaultProps}
          onFileUploaded={() => 'Incompatible printer'}
        />
      );

      const file = new File(['content'], 'model.3mf', { type: 'application/octet-stream' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(fileInput, file);

      const uploadButton = screen.getByRole('button', { name: /Upload \(1\)/i });
      await user.click(uploadButton);

      await waitFor(() => {
        expect(screen.getByText('Incompatible printer')).toBeInTheDocument();
      });

      // File list should be cleared
      expect(screen.queryByText('model.3mf')).not.toBeInTheDocument();
    });

    it('closes modal normally when onFileUploaded returns undefined', async () => {
      const onFileUploaded = vi.fn();
      const user = userEvent.setup();
      render(<FileUploadModal {...defaultProps} onFileUploaded={onFileUploaded} />);

      const file = new File(['content'], 'model.3mf', { type: 'application/octet-stream' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(fileInput, file);

      const uploadButton = screen.getByRole('button', { name: /Upload \(1\)/i });
      await user.click(uploadButton);

      await waitFor(() => {
        expect(defaultProps.onClose).toHaveBeenCalled();
      });
    });
  });

  describe('duplicate-check hashing (bounded concurrency, ordering, failure surfacing)', () => {
    it('never runs more than 3 hashes concurrently for a large batch of files', async () => {
      const user = userEvent.setup();
      render(<FileUploadModal {...defaultProps} />);

      // 6 files, all with the same artificial delay: if hashing were still
      // fanned out with Promise.all (the bug), all 6 would start at once and
      // peakConcurrentHashCalls would hit 6. A bounded pool of 3 must never
      // exceed 3, and — since 6 > 3 — should actually reach 3 (not silently
      // serialize to 1), proving real bounded parallelism is happening.
      const files = Array.from({ length: 6 }, (_, i) =>
        makeInstrumentedFile(`content-${i}`, `file${i}.3mf`, { delayMs: 30 }),
      );
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(fileInput, files);

      await waitFor(
        () => {
          expect(hashCompletionOrder.length).toBe(6);
        },
        { timeout: 5000 },
      );

      expect(peakConcurrentHashCalls).toBe(3);
    });

    // INVARIANT GUARD, not a fix-pinning regression test: this also passes against
    // the pre-fix `Promise.all(map)` code, which preserved order too. It exists to
    // catch a FUTURE change to runWithConcurrencyLimit that attributes results by
    // completion order (e.g. push-on-resolve) instead of by claimed slot index —
    // a hash mapped to the wrong file would be silent data corruption.
    it('attributes hashes/duplicate results to the correct file even when completion order differs from input order', async () => {
      const user = userEvent.setup();
      render(<FileUploadModal {...defaultProps} />);

      // fileB finishes first (shortest delay) despite being added second —
      // exercises the "completion order != input order" case. Only fileB's
      // content hashes to the value the server reports as a duplicate.
      const fileA = makeInstrumentedFile('aaa-content', 'fileA.3mf', { delayMs: 60 });
      const fileB = makeInstrumentedFile('bbb-content', 'fileB.3mf', { delayMs: 5 });
      const fileC = makeInstrumentedFile('ccc-content', 'fileC.3mf', { delayMs: 30 });

      const bbbHash = '3fe4fb767f8a7283f23b1f486b069d4cbd4774ffcea5364f246ed7096ffa0376';
      server.use(
        http.post('/api/v1/library/files/check-duplicates', () => {
          return HttpResponse.json({
            duplicates: {
              [bbbHash]: { id: 42, filename: 'fileB.3mf', folder_id: null, folder_name: 'Existing Folder' },
            },
          });
        }),
      );

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(fileInput, [fileA, fileB, fileC]);

      // Sanity check on the instrumentation itself: B really did finish before A.
      await waitFor(
        () => {
          expect(hashCompletionOrder).toEqual(['fileB.3mf', 'fileC.3mf', 'fileA.3mf']);
        },
        { timeout: 5000 },
      );

      // Only fileB's row should be flagged as a duplicate, despite it having
      // completed hashing first — proves the result wasn't misattributed to
      // whichever file happened to finish first (e.g. fileA).
      await waitFor(
        () => {
          expect(screen.getByText(/Already in library/)).toBeInTheDocument();
        },
        { timeout: 5000 },
      );

      const rowB = screen.getByText('fileB.3mf').closest('.flex.items-center.gap-3');
      const rowA = screen.getByText('fileA.3mf').closest('.flex.items-center.gap-3');
      const rowC = screen.getByText('fileC.3mf').closest('.flex.items-center.gap-3');

      expect(rowB?.textContent).toContain('Already in library');
      expect(rowA?.textContent).not.toContain('Already in library');
      expect(rowC?.textContent).not.toContain('Already in library');
    });

    it('surfaces a per-file hashing failure instead of silently dropping it', async () => {
      const user = userEvent.setup();
      render(<FileUploadModal {...defaultProps} />);

      const goodFile = makeInstrumentedFile('good-content', 'good.3mf');
      const brokenFile = makeInstrumentedFile('irrelevant', 'broken.3mf', { fail: true });

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(fileInput, [goodFile, brokenFile]);

      // The failure is visible to the user rather than silently swallowed.
      await waitFor(
        () => {
          expect(screen.getByText(/Array buffer allocation failed for broken\.3mf/)).toBeInTheDocument();
        },
        { timeout: 5000 },
      );

      // The failure message is attached to the broken file's row, not the good one.
      const brokenRow = screen.getByText('broken.3mf').closest('.flex.items-center.gap-3');
      const goodRow = screen.getByText('good.3mf').closest('.flex.items-center.gap-3');
      expect(brokenRow?.textContent).toContain('Array buffer allocation failed for broken.3mf');
      expect(goodRow?.textContent).not.toContain('Array buffer allocation failed');

      // The file with the hashing failure still proceeds to upload (it just
      // wasn't checked for duplicates) — this must not regress the upload flow.
      await waitFor(
        () => {
          expect(screen.getByRole('button', { name: /Upload \(2\)/i })).not.toBeDisabled();
        },
        { timeout: 5000 },
      );
    });

  });
});
