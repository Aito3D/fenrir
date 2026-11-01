import type { InboxItem } from '../api/client';

/** The page a family's rows fall back to when their target is gone. */
const FAMILY_PAGE: Record<string, string> = { aito: '/aito', printer: '/printers' };

/** Where clicking an inbox row goes: the card or printer it names, else its family's page. */
export function inboxTarget(item: InboxItem): string {
  // The readings-due notice has no id: it opens the reading pass.
  if (item.target_type === 'hours') return '/maintenance?tab=hours&pass=1';
  if (item.target_id != null) {
    if (item.target_type === 'aito_project') return `/aito?card=${item.target_id}`;
    if (item.target_type === 'printer') return `/printers?focus=${item.target_id}`;
  }
  return FAMILY_PAGE[item.family] ?? '/aito';
}
