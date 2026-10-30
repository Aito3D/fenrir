/** The hand-slice fallback dialog of a failed server slice: posts the picked `.gcode.3mf`, closes
 *  and toasts on success, lists the server's settings mismatches, and refuses a raw `.gcode`. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../../../utils';
import { server } from '../../../mocks/server';
import { UploadSlicedDialog } from '../../../../components/projects/files/UploadSlicedDialog';
import { useFileActions } from '../../../../components/projects/files/useFileActions';
import { file, rev } from '../../../fixtures/projectTree';

const profile = { printer_model: 'X1C', nozzle_diameter: '0.4', layer_height: '0.2', filament_types: ['PETG'] };
const failed = rev({
  id: 2, number: 2, status: 'valide', print_profile: profile,
  files: [file(51, 'bracket.3mf', { file_type: '3mf' })],
  slice_status: 'failed', slice_error: 'Slicer sidecar unreachable: All connection attempts failed',
});

function Harness({ onClose }: { onClose: () => void }) {
  const actions = useFileActions(7);
  return <UploadSlicedDialog revision={failed} actions={actions} onClose={onClose} />;
}

let posted: string[];
let answer: () => Response | HttpResponse;

beforeEach(() => {
  posted = [];
  answer = () => HttpResponse.json({ ...failed, slice_status: 'sliced', slice_error: null });
  server.use(
    http.get('/api/v1/projects/7/tree', () => HttpResponse.json({ project_id: 7, code: 'P-0007', sections: [] })),
    http.post('/api/v1/projects/revisions/2/sliced-file', async ({ request }) => {
      // Read as text, not formData(): this environment's fetch serialises a jsdom File that
      // request.formData() then rejects (see PrintersPageDropOnBusy), and as "blob" with no
      // name. The multipart text still names the field.
      const part = (await request.text()).match(/name="(\w+)"; filename=/);
      if (part) posted.push(part[1]);
      return answer();
    }),
  );
});

const pickFile = async (name: string) => {
  const input = screen.getByLabelText('Sliced plate file') as HTMLInputElement;
  // applyAccept off: a picker's "All files" lets a .gcode through; the dialog's own check must catch it.
  await userEvent.upload(input, new File(['PK'], name, { type: 'application/octet-stream' }), { applyAccept: false });
};

describe('UploadSlicedDialog', () => {
  it('explains the fallback and shows what the file must match', () => {
    render(<Harness onClose={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'Upload the sliced file' })).toBeInTheDocument();
    expect(screen.getByText(/export the plate's sliced file/i)).toBeInTheDocument();
    expect(screen.getByText('Must match: X1C · 0.4 mm · 0.2 mm · PETG')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add sliced file' })).toBeDisabled();
  });

  it('posts the picked .gcode.3mf as `file`, toasts and closes', async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await pickFile('bracket.gcode.3mf');
    await userEvent.click(screen.getByRole('button', { name: 'Add sliced file' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(posted).toEqual(['file']);
    expect(await screen.findByText('Sliced file added')).toBeInTheDocument();
  });

  it('refuses a raw .gcode before sending anything', async () => {
    render(<Harness onClose={() => {}} />);
    await pickFile('bracket.gcode');
    expect(screen.getByRole('alert')).toHaveTextContent(/sliced plate file Bambu Studio exports/);
    expect(screen.getByRole('button', { name: 'Add sliced file' })).toBeDisabled();
    expect(posted).toEqual([]);
  });

  it("lists the server's settings mismatches with translated labels and stays open", async () => {
    answer = () =>
      HttpResponse.json(
        {
          detail: {
            code: 'settings_mismatch',
            message: "The sliced file's settings differ from the revision's.",
            mismatches: [
              { field: 'printer_model', file: 'P1S', revision: 'X1C' },
              { field: 'nozzle_diameter', file: '0.6', revision: '0.4' },
            ],
          },
        },
        { status: 400 },
      );
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await pickFile('bracket.gcode.3mf');
    await userEvent.click(screen.getByRole('button', { name: 'Add sliced file' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("The file's settings differ from this revision:");
    expect(alert).toHaveTextContent('Printer: file P1S, revision X1C');
    expect(alert).toHaveTextContent('Nozzle: file 0.6, revision 0.4');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Add sliced file' })).toBeEnabled();
  });

  it('shows a plain refusal as the server wrote it', async () => {
    answer = () => HttpResponse.json({ detail: 'bracket.gcode.3mf is not sliced: export the plate.' }, { status: 400 });
    render(<Harness onClose={() => {}} />);
    await pickFile('bracket.gcode.3mf');
    await userEvent.click(screen.getByRole('button', { name: 'Add sliced file' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('bracket.gcode.3mf is not sliced: export the plate.');
  });
});
