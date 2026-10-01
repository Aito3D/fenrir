import { describe, it, expect } from 'vitest';
import { inboxTarget } from '../../utils/inboxTarget';
import type { InboxItem } from '../../api/client';

const item = (patch: Partial<InboxItem>): InboxItem => ({
  id: 1,
  kind: 'aito.paid',
  family: 'aito',
  title: 'aito.paid',
  body: '',
  target_type: 'aito_project',
  target_id: 41,
  created_at: '2026-10-01T10:00:00Z',
  read_at: null,
  ...patch,
});

describe('inboxTarget', () => {
  it('opens an Aito card by id', () => {
    expect(inboxTarget(item({}))).toBe('/aito?card=41');
  });

  it('focuses a printer by id', () => {
    expect(inboxTarget(item({ kind: 'printer.finished', family: 'printer', target_type: 'printer', target_id: 3 }))).toBe(
      '/printers?focus=3',
    );
  });

  it('falls back to the family page when the target is gone', () => {
    expect(inboxTarget(item({ target_id: null }))).toBe('/aito');
    expect(inboxTarget(item({ family: 'printer', target_type: 'printer', target_id: null }))).toBe('/printers');
    expect(inboxTarget(item({ family: 'printer', target_type: null, target_id: null }))).toBe('/printers');
  });
});
