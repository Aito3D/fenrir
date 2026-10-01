import {
  AlertTriangle,
  Banknote,
  Bell,
  CheckCheck,
  CheckCircle2,
  Clock,
  Eye,
  Send,
  XCircle,
  type LucideIcon,
} from 'lucide-react';

export interface NotificationKindMeta {
  icon: LucideIcon;
  /** Icon colour + tinted tile background. */
  tone: string;
  family: 'aito' | 'printer';
  /** The `inbox.kind.*` key holding the row title. */
  titleKey: string;
}

export const NOTIFICATION_KINDS: Record<string, NotificationKindMeta> = {
  'aito.quote_viewed': { icon: Eye, tone: 'text-sky-400 bg-sky-400/10', family: 'aito', titleKey: 'aitoQuoteViewed' },
  'aito.quote_accepted': {
    icon: CheckCircle2,
    tone: 'text-bambu-green bg-bambu-green/10',
    family: 'aito',
    titleKey: 'aitoQuoteAccepted',
  },
  'aito.quote_declined': {
    icon: XCircle,
    tone: 'text-rose-400 bg-rose-400/10',
    family: 'aito',
    titleKey: 'aitoQuoteDeclined',
  },
  'aito.paid': { icon: Banknote, tone: 'text-emerald-400 bg-emerald-400/10', family: 'aito', titleKey: 'aitoPaid' },
  'aito.overdue': { icon: Clock, tone: 'text-red-400 bg-red-400/10', family: 'aito', titleKey: 'aitoOverdue' },
  'printer.job_sent': {
    icon: Send,
    tone: 'text-violet-400 bg-violet-400/10',
    family: 'printer',
    titleKey: 'printerJobSent',
  },
  'printer.finished': {
    icon: CheckCheck,
    tone: 'text-bambu-green bg-bambu-green/10',
    family: 'printer',
    titleKey: 'printerFinished',
  },
  'printer.failed': {
    icon: AlertTriangle,
    tone: 'text-amber-400 bg-amber-400/10',
    family: 'printer',
    titleKey: 'printerFailed',
  },
};

/** A kind this build does not know yet still renders, as a plain bell. */
export const UNKNOWN_KIND = { icon: Bell, tone: 'text-bambu-gray-light bg-bambu-dark-tertiary' };

/** The family a kind belongs to, falling back to the prefix before the dot. */
export function kindFamily(kind: string): string {
  return NOTIFICATION_KINDS[kind]?.family ?? kind.split('.')[0];
}
