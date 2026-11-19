import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../../contexts/ToastContext';
import { setAuthToken } from '../../../api/client';
import { RevenueNotes } from '../../../components/revenue/RevenueNotes';
import type { RevenueAnnotation } from '../../../components/revenue/lib/types';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const notes: RevenueAnnotation[] = [
  { id: 4, day: '2026-02-14', label: 'Saint-Valentin' },
  { id: 5, day: '2026-03-02', label: 'Salon' },
];

function setup(o: { canManage?: boolean; response?: Response } = {}) {
  const fetchMock = vi.fn(async () => o.response ?? json({ ok: true }));
  vi.stubGlobal('fetch', fetchMock);
  const onChanged = vi.fn();
  render(
    <ToastProvider>
      <RevenueNotes annotations={notes} onChanged={onChanged} today="2026-03-10" canManage={o.canManage ?? true} />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: '◆ Notes (2)' }));
  return { fetchMock, onChanged };
}

afterEach(() => {
  vi.unstubAllGlobals();
  setAuthToken(null);
});

describe('RevenueNotes', () => {
  it('lists the notes, newest first', () => {
    setup();
    expect(screen.getAllByRole('listitem').map((li) => li.textContent?.replace('×', ''))).toEqual(['2026-03-02Salon', '2026-02-14Saint-Valentin']);
  });

  it('hides add and delete without revenue:manage_notes, the list stays', () => {
    setup({ canManage: false });
    expect(screen.getByText('Salon')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Note' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Delete the note/ })).toBeNull();
  });

  it('adds a trimmed note for a day within the history', async () => {
    setAuthToken('tok');
    const { fetchMock, onChanged } = setup();
    const day = screen.getByLabelText('Day');
    expect(day).toHaveAttribute('min', '2024-01-01');
    expect(day).toHaveAttribute('max', '2026-03-10');
    fireEvent.change(day, { target: { value: '2026-03-05' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), { target: { value: '  Black Friday  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/revenue/annotations');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ day: '2026-03-05', label: 'Black Friday' });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('');
  });

  it('keeps the label between 1 and 80 characters and the day between 2024-01-01 and today', () => {
    const { fetchMock } = setup();
    const label = screen.getByRole('textbox', { name: 'Note' });
    const add = screen.getByRole('button', { name: 'Add' });
    expect(label).toHaveAttribute('maxLength', '80');
    fireEvent.change(label, { target: { value: '   ' } });
    expect(add).toBeDisabled();
    fireEvent.change(label, { target: { value: 'x'.repeat(81) } });
    expect(add).toBeDisabled();
    fireEvent.change(label, { target: { value: 'x'.repeat(80) } });
    expect(add).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Day'), { target: { value: '2026-03-11' } });
    expect(add).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Day'), { target: { value: '2023-12-31' } });
    expect(add).toBeDisabled();
    fireEvent.submit(label.closest('form')!);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('deletes a note', async () => {
    const { fetchMock, onChanged } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Delete the note Salon' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/revenue/annotations/5');
    expect(init.method).toBe('DELETE');
  });

  it('shows the server detail when a change fails', async () => {
    const { onChanged } = setup({ response: json({ detail: 'label must be 1 to 80 characters' }, 422) });
    fireEvent.click(screen.getByRole('button', { name: 'Delete the note Salon' }));
    expect(await screen.findByText('label must be 1 to 80 characters')).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });
});
