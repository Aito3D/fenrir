import { describe, it, expect } from 'vitest';
import type { AitoForceSyncStep } from '../../api/client';
import { forceSyncStepText } from '../../components/aito/forceSyncText';
import { formatMoney } from '../../utils/pricing';
import i18n from '../../i18n';

const t = i18n.t.bind(i18n);
const step = (key: AitoForceSyncStep['key'], outcome: AitoForceSyncStep['outcome'], detail = {}): AitoForceSyncStep => ({
  key,
  outcome,
  detail,
});
const text = (s: AitoForceSyncStep) => forceSyncStepText(t, s, 'XPF');

describe('forceSyncStepText', () => {
  it('says "In sync" with no detail', () => {
    expect(text(step('quote', 'in_sync'))).toEqual({ label: 'In sync', detail: null });
  });

  it('spells a skip reason out', () => {
    const r = text(step('invoice', 'skipped', { reason: 'rate_limited' }));
    expect(r.label).toBe('Skipped');
    expect(r.detail).toBe('Zoho rate limit — try again in a minute');
  });

  it.each([
    ['no_quote', 'No quote'],
    ['unmanaged', 'Not managed by Aito'],
    ['not_invoiced', 'Not invoiced yet'],
    ['not_configured', 'Not configured'],
    ['worker_unavailable', 'Zoho sync is off'],
    ['timeout', 'Zoho did not answer in time'],
    ['no_client', 'No client'],
    ['unreachable', 'Zoho could not be reached'],
    ['refused', 'Zoho refused the push'],
    ['upstream', 'Zoho returned an error'],
    ['internal', 'Unexpected error — see the server log'],
  ])('translates the %s reason', (reason, expected) => {
    expect(text(step('credit', 'failed', { reason })).detail).toBe(expected);
  });

  it('shows a credit change with both amounts', () => {
    const d = text(step('credit', 'fixed', { before: 500, after: 7000 })).detail!;
    expect(d).toContain(formatMoney(500, 'XPF'));
    expect(d).toContain(formatMoney(7000, 'XPF'));
  });

  it('shows a dash for a credit that had no earlier figure', () => {
    expect(text(step('credit', 'fixed', { before: null, after: 7000 })).detail).toContain('—');
  });

  it('shows the invoice number and balance change', () => {
    const d = text(step('invoice', 'fixed', { number: 'FA-26-1', balance_before: 14000, balance_after: 7000 })).detail!;
    expect(d).toContain('FA-26-1');
    expect(d).toContain(formatMoney(14000, 'XPF'));
    expect(d).toContain(formatMoney(7000, 'XPF'));
  });

  it('shows a quote total change, a status change and a cleared error, joined', () => {
    const d = text(
      step('quote', 'fixed', {
        total: { before: 100, after: 200 },
        status: { before: 'sent', after: 'accepted' },
        error_cleared: true,
      }),
    ).detail!;
    expect(d).toContain(formatMoney(200, 'XPF'));
    expect(d).toContain('Sent');
    expect(d).toContain('Accepted');
    expect(d).toContain('Previous error cleared');
    expect(d.split(' · ')).toHaveLength(3);
  });

  it('prefers the server message on a failure', () => {
    expect(text(step('quote', 'failed', { reason: 'refused', message: 'tax-exclusive…' })).detail).toBe('tax-exclusive…');
  });

  it('falls back to the reason sentence for an empty message', () => {
    expect(text(step('quote', 'failed', { reason: 'refused', message: '' })).detail).toBe('Zoho refused the push');
  });

  it('shows an unknown reason raw', () => {
    expect(text(step('quote', 'skipped', { reason: 'mystery' })).detail).toBe('mystery');
  });

  it.each([
    ['rate_limited', 'Heimdall rate limit — try again in a minute'],
    ['not_configured', 'Heimdall is not configured'],
    ['upstream', 'Heimdall returned an error'],
  ])('names Heimdall, not Zoho, for the payment links %s reason', (reason, expected) => {
    expect(text(step('payment_links', 'skipped', { reason })).detail).toBe(expected);
  });

  it('says the deposit was refused on the invoice step', () => {
    expect(text(step('invoice', 'failed', { reason: 'refused' })).detail).toBe('Zoho refused to apply the deposit');
  });

  it('labels a quote total change as a total, not a credit', () => {
    const d = text(step('quote', 'fixed', { total: { before: 100, after: 200 } })).detail!;
    expect(d).toBe(`Total from ${formatMoney(100, 'XPF')} to ${formatMoney(200, 'XPF')}`);
  });

  it("formats the invoice step's money in the invoice's own currency", () => {
    const d = text(
      step('invoice', 'fixed', { number: 'FA-26-1', balance_before: 140, balance_after: 70, currency_code: 'EUR' }),
    ).detail!;
    expect(d).toContain(formatMoney(140, 'EUR'));
    expect(d).toContain(formatMoney(70, 'EUR'));
    expect(d).not.toContain(formatMoney(140, 'XPF'));
  });
});
