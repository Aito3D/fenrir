/**
 * orders.units for the locales whose plural rules need _few / _many (ru, uk, pl). The parity gate forbids
 * keys en does not have, so the base `orders.units` key is what i18next falls back to for those forms.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import i18n from '../../i18n';

describe.each(['ru', 'uk', 'pl'])('%s orders.units', lng => {
  beforeAll(async () => {
    await i18n.loadLanguages(lng);
    expect(i18n.hasResourceBundle(lng, 'translation')).toBe(true);
  });

  it.each([1, 3, 5, 21, 1.5])('renders %s with the number, never the raw key', count => {
    const rendered = i18n.getFixedT(lng)('orders.units', { count });
    expect(rendered).toContain(String(count));
    expect(rendered).not.toContain('orders.units');
  });
});
