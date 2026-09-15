import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AITO3D_BANK, AITO3D_TRANSFER_APPS } from '../../utils/aitoBankDetails';
import { copyTextToClipboard } from '../../utils/clipboard';
import { FOCUS, PRESS } from '../../utils/trackingShell';

const COPIED_HOLD_MS = 1600;

/** Every way to settle a quote other than the online link: the bank
 *  transfer coordinates, the peer-to-peer app tags, and the shop counter.
 *  Rendered inside a TrackCollapse under both unpaid cards (payment link and
 *  invoice), so the two disclose the same panel. The quote number is the
 *  transfer reference and is spelled out when the page knows it. Values
 *  come from `aitoBankDetails` verbatim; only the labels are translated —
 *  IBAN, BIC and RIB are acronyms in every language and stay literal. */
export function TrackingPaymentMethods({ open, reference }: { open: boolean; reference: string | null }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = async (key: string, value: string) => {
    if (!(await copyTextToClipboard(value))) return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    setCopied(key);
    timer.current = window.setTimeout(() => setCopied(null), COPIED_HOLD_MS);
  };

  const copyButton = (key: string, value: string, label: string) => (
    <button
      type="button"
      aria-label={label}
      onClick={() => void copy(key, value)}
      className={`-my-[4px] ml-[8px] inline-flex min-h-[32px] shrink-0 items-center rounded-[6px] px-[8px] text-[12.5px] font-semibold text-aito-cyan hover:bg-aito-cyan/10 active:bg-aito-cyan/15 ${PRESS} ${FOCUS}`}
    >
      {copied === key ? t('aito.track.paymentMethods.copied') : t('aito.track.paymentMethods.copy')}
    </button>
  );

  return (
    <div data-testid="track-payment-methods" className={`${open ? 'animate-rise' : ''} mt-[12px] space-y-[16px] px-[16px] text-[13px] text-aito-muted`}>
      <p>
        {reference
          ? t('aito.track.paymentMethods.referenceKnown', { ref: reference })
          : t('aito.track.paymentMethods.referenceUnknown')}
      </p>

      <Group title={t('aito.track.paymentMethods.transfer')}>
        <Rows
          rows={[
            [t('aito.track.paymentMethods.beneficiary'), AITO3D_BANK.beneficiary],
            [t('aito.track.paymentMethods.bank'), AITO3D_BANK.bank],
            ['IBAN', AITO3D_BANK.iban, copyButton('iban', AITO3D_BANK.iban, t('aito.track.paymentMethods.copyIban'))],
            ['BIC', AITO3D_BANK.bic],
            ['RIB', AITO3D_BANK.rib.join(' ')],
          ]}
        />
        <p className="mt-[6px]">{t('aito.track.paymentMethods.transferDelay')}</p>
      </Group>

      {AITO3D_TRANSFER_APPS.map((app) => (
        <Group key={app.name} title={t('aito.track.paymentMethods.appTransfer', { app: app.name })}>
          <Rows
            rows={[
              [
                t('aito.track.paymentMethods.tag'),
                app.tag,
                copyButton(app.name, app.tag, t('aito.track.paymentMethods.copyTag', { app: app.name })),
              ],
            ]}
          />
        </Group>
      ))}

      <Group title={t('aito.track.paymentMethods.shop')}>
        <p>{t('aito.track.paymentMethods.shopSub')}</p>
      </Group>

      <p>{t('aito.track.paymentMethods.question')}</p>
    </div>
  );
}

/** One payment method: a small heading that names the group for assistive
 *  tech, then its rows. */
function Group({ title, children }: { title: string; children: React.ReactNode }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id}>
      <h4 id={id} className="mb-[6px] text-[13.5px] font-semibold text-aito-ink">
        {title}
      </h4>
      {children}
    </div>
  );
}

/** Label / value pairs; a value may carry a copy button after it. */
function Rows({ rows }: { rows: [label: string, value: string, action?: React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-[16px] gap-y-[4px]">
      {rows.map(([label, value, action]) => (
        <div key={label} className="contents">
          <dt>{label}</dt>
          <dd className="flex min-w-0 flex-wrap items-center">
            <span className="min-w-0 break-words tabular-nums text-aito-ink">{value}</span>
            {action}
          </dd>
        </div>
      ))}
    </dl>
  );
}
