import { describe, expect, it } from 'vitest';
import { detailText, formatValue } from '../../components/aito/history/eventKinds';

describe('formatValue', () => {
  it('renders an em dash for null and undefined', () => {
    expect(formatValue(null)).toBe('—');
    expect(formatValue(undefined)).toBe('—');
  });

  it('renders a checkmark for true and an em dash for false', () => {
    expect(formatValue(true)).toBe('✓');
    expect(formatValue(false)).toBe('—');
  });

  it('stringifies anything else', () => {
    expect(formatValue(42)).toBe('42');
    expect(formatValue('Socle')).toBe('Socle');
  });
});

describe('detailText', () => {
  it('returns null when there is no detail', () => {
    expect(detailText('zoho.comment', null)).toBeNull();
  });

  it('returns the verbatim text for zoho.comment', () => {
    expect(detailText('zoho.comment', { text: 'Réponse client' })).toBe('Réponse client');
  });

  it('returns null for zoho.comment when text is missing, blank, or not a string', () => {
    expect(detailText('zoho.comment', {})).toBeNull();
    expect(detailText('zoho.comment', { text: '' })).toBeNull();
    expect(detailText('zoho.comment', { text: 3 })).toBeNull();
  });

  it('returns the error reason for sync.failed', () => {
    expect(detailText('sync.failed', { error: 'Zoho rejected the request' })).toBe('Zoho rejected the request');
  });

  it('returns null for sync.failed when error is missing, blank, or not a string', () => {
    expect(detailText('sync.failed', {})).toBeNull();
    expect(detailText('sync.failed', { error: '' })).toBeNull();
    expect(detailText('sync.failed', { error: 7 })).toBeNull();
  });

  it('renders both sides of a sync.conflict', () => {
    expect(detailText('sync.conflict', { ours: 'Sent', theirs: 'Draft' })).toBe('Sent → Draft');
  });

  it('renders both sides of a sync.status_rejected, formatting a missing side as an em dash', () => {
    expect(detailText('sync.status_rejected', { ours: 'Accepted', theirs: null })).toBe('Accepted → —');
  });

  it('renders when only the "theirs" side is present', () => {
    expect(detailText('sync.conflict', { ours: null, theirs: 'Declined' })).toBe('— → Declined');
  });

  it('returns null for sync.conflict/sync.status_rejected when neither side is a non-empty string', () => {
    expect(detailText('sync.conflict', {})).toBeNull();
    expect(detailText('sync.conflict', { ours: '', theirs: '' })).toBeNull();
    expect(detailText('sync.status_rejected', { ours: 5, theirs: 9 })).toBeNull();
  });

  it('returns null for any other kind', () => {
    expect(detailText('task.added', { text: 'ignored' })).toBeNull();
  });
});
