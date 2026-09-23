import { describe, expect, it } from 'vitest';
import { detailText, elapsedBucket, EVENT_LABEL_KEY, formatValue } from '../../components/aito/history/eventKinds';

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

  it('shows the invoice number for invoice.detected', () => {
    expect(detailText('invoice.detected', { invoice_number: 'FA-26-4367', status: 'paid' })).toBe('FA-26-4367');
  });

  it('returns null for invoice.detected when Books gave no number yet', () => {
    expect(detailText('invoice.detected', { status: 'draft' })).toBeNull();
    expect(detailText('invoice.detected', { invoice_number: '' })).toBeNull();
  });

  it('names the retainer and the amount for invoice.deposit_applied', () => {
    expect(detailText('invoice.deposit_applied', { retainer_number: 'RET26-00295', amount: 4000 })).toBe(
      'RET26-00295 · 4000'
    );
  });

  it('returns null for invoice.deposit_applied when the retainer number is missing', () => {
    expect(detailText('invoice.deposit_applied', { amount: 4000 })).toBeNull();
  });

  it('returns null for sync.conflict/sync.status_rejected when neither side is a non-empty string', () => {
    expect(detailText('sync.conflict', {})).toBeNull();
    expect(detailText('sync.conflict', { ours: '', theirs: '' })).toBeNull();
    expect(detailText('sync.status_rejected', { ours: 5, theirs: 9 })).toBeNull();
  });

  it('returns null for any other kind', () => {
    expect(detailText('task.added', { text: 'ignored' })).toBeNull();
  });

  it('renders the amount change for payment_link.updated', () => {
    expect(
      detailText('payment_link.updated', { previous_amount: 12500, amount: 20000, expires_on: '2026-10-01' }),
    ).toBe('12500 → 20000');
  });

  it('renders the expiry change for payment_link.updated', () => {
    expect(
      detailText('payment_link.updated', {
        amount: 12500,
        previous_expires_on: '2026-10-01',
        expires_on: '2026-11-01',
      }),
    ).toBe('2026-10-01 → 2026-11-01');
  });

  it('renders both when amount and expiry both changed', () => {
    expect(
      detailText('payment_link.updated', {
        previous_amount: 12500,
        amount: 20000,
        previous_expires_on: '2026-10-01',
        expires_on: '2026-11-01',
      }),
    ).toBe('12500 → 20000 · 2026-10-01 → 2026-11-01');
  });

  it('returns null for payment_link.updated when nothing actually changed', () => {
    expect(
      detailText('payment_link.updated', { previous_amount: 12500, amount: 12500, expires_on: '2026-10-01' }),
    ).toBeNull();
  });
});

describe('elapsedBucket', () => {
  it('returns null for a gap under a minute (same-minute, nothing worth a row)', () => {
    expect(elapsedBucket(0)).toBeNull();
    expect(elapsedBucket(59)).toBeNull();
  });

  it('buckets in minutes from 60s up to (but not including) an hour', () => {
    expect(elapsedBucket(60)).toEqual({ value: 1, unit: 'minute' });
    expect(elapsedBucket(150)).toEqual({ value: 3, unit: 'minute' });
    expect(elapsedBucket(3_599)).toEqual({ value: 60, unit: 'minute' });
  });

  it('buckets in hours from exactly one hour up to (but not including) a day', () => {
    expect(elapsedBucket(3_600)).toEqual({ value: 1, unit: 'hour' });
    expect(elapsedBucket(7_200)).toEqual({ value: 2, unit: 'hour' });
    expect(elapsedBucket(86_399)).toEqual({ value: 24, unit: 'hour' });
  });

  it('buckets in days from exactly one day and beyond', () => {
    expect(elapsedBucket(86_400)).toEqual({ value: 1, unit: 'day' });
    expect(elapsedBucket(259_200)).toEqual({ value: 3, unit: 'day' });
  });
});

describe('EVENT_LABEL_KEY', () => {
  it('labels task.reordered', () => {
    expect(EVENT_LABEL_KEY['task.reordered']).toBe('aito.history.taskReordered');
  });

  it('labels payment_link.updated', () => {
    expect(EVENT_LABEL_KEY['payment_link.updated']).toBe('aito.history.paymentLinkUpdated');
  });

  it('labels invoice.deposit_applied', () => {
    expect(EVENT_LABEL_KEY['invoice.deposit_applied']).toBe('aito.history.invoiceDepositApplied');
  });
});

describe('project.client.changed', () => {
  it('has a label key', () => {
    expect(EVENT_LABEL_KEY['project.client.changed']).toBe('aito.history.clientChanged');
  });

  it('shows the old and new customer names', () => {
    expect(
      detailText('project.client.changed', {
        from_id: 'C1',
        from_name: 'Client',
        to_id: 'C2',
        to_name: 'Nouveau Client',
      }),
    ).toBe('Client → Nouveau Client');
  });

  it('returns null when neither name is known', () => {
    expect(detailText('project.client.changed', { from_id: 'C1', to_id: 'C2' })).toBeNull();
  });
});
