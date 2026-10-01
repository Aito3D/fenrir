import type { InboxItem } from '../api/client';

/** The page a family's rows fall back to when their target is gone. */
const FAMILY_PAGE: Record<string, string> = { aito: '/aito', printer: '/printers' };

/** Where clicking an inbox row goes: the card or printer it names, else its family's page. */
export function inboxTarget(item: InboxItem): string {
  if (item.target_id != null) {
    if (item.target_type === 'aito_project') return `/aito?card=${item.target_id}`;
    if (item.target_type === 'printer') return `/printers?focus=${item.target_id}`;
  }
  return FAMILY_PAGE[item.family] ?? '/aito';
}
