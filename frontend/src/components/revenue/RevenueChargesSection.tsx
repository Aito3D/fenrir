import { useId, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { focusRingCls } from '../formStyles';

/** The card a charges table sits in. */
export const CHARGES_CARD = 'overflow-x-auto rounded-[.6rem] border border-bambu-dark-tertiary bg-bambu-dark-secondary';
/** A charges table's header cell. */
export const CHARGES_TH = 'whitespace-nowrap border-b border-bambu-dark-tertiary px-3 py-2.5 text-[11px] font-medium uppercase tracking-wider text-bambu-gray';
export const CHARGES_LINK = `text-xs text-bambu-gray-light underline underline-offset-2 hover:text-white disabled:opacity-40 ${focusRingCls}`;

export interface ChargesSave {
  dirty: boolean;
  busy: boolean;
  invalid?: boolean;
  onSave: () => void;
  onDiscard: () => void;
}

/**
 * One tab of the costs dialog: a title with its actions, an intro, then the table. Unsaved changes
 * raise a bar with Discard and Save: in `footer` (the dialog's, so it stays in view under a long
 * table), or under the table when the section stands alone. A `null` footer (hidden tab) shows none.
 */
export function RevenueChargesSection({ title, intro, action, save, footer, children }: {
  title: string;
  intro: string;
  action?: ReactNode;
  save?: ChargesSave;
  footer?: HTMLElement | null;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const id = useId();
  const bar = save?.dirty && (
    <div className={`flex w-full flex-wrap items-center gap-3 ${footer ? '' : 'mt-3'}`}>
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-400" />
      <span className="text-sm text-bambu-gray-light">{t('revenue.charges.unsaved')}</span>
      <button type="button" disabled={save.busy} onClick={save.onDiscard}
        className={`ml-auto rounded-lg border border-bambu-dark-tertiary px-3.5 py-1.5 text-sm font-medium text-bambu-gray-light hover:text-white disabled:opacity-40 ${focusRingCls}`}>
        {t('revenue.charges.discard')}
      </button>
      <button type="button" disabled={save.busy || save.invalid} onClick={save.onSave}
        className={`rounded-lg bg-bambu-green px-3.5 py-1.5 text-sm font-medium text-white disabled:opacity-40 ${focusRingCls}`}>
        {save.busy ? '…' : t('revenue.fixedCosts.save')}
      </button>
    </div>
  );
  return (
    <section aria-labelledby={id}>
      <div className="mb-1 flex flex-wrap items-center gap-x-4 gap-y-2">
        <h3 id={id} className="text-[15px] font-semibold text-white">{title}</h3>
        <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2">{action}</div>
      </div>
      <p className="mb-3 max-w-[78ch] text-xs text-bambu-gray">{intro}</p>
      {children}
      {bar && (footer === undefined ? bar : footer && createPortal(bar, footer))}
    </section>
  );
}
