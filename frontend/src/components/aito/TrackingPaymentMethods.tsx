import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MapPin } from 'lucide-react';
import { AITO3D_BANK, AITO3D_TRANSFER_APPS } from '../../utils/aitoBankDetails';
import { copyTextToClipboard } from '../../utils/clipboard';
import { AITO3D_SENDER } from '../../utils/shippingLabel';
import { FOCUS } from '../../utils/trackingShell';

const COPIED_HOLD_MS = 1600;

type Method = 'transfer' | (typeof AITO3D_TRANSFER_APPS)[number]['name'] | 'shop';
const METHODS: readonly Method[] = ['transfer', ...AITO3D_TRANSFER_APPS.map((app) => app.name), 'shop'];

/** Which tab an arrow key moves to (the WAI-ARIA tabs pattern): left and
 *  right wrap around, Home and End jump to the ends, any other key does not
 *  move — -1, so the handler leaves it to the browser. */
function tabTarget(key: string, index: number, last: number): number {
  switch (key) {
    case 'ArrowRight':
      return index === last ? 0 : index + 1;
    case 'ArrowLeft':
      return index === 0 ? last : index - 1;
    case 'Home':
      return 0;
    case 'End':
      return last;
    default:
      return -1;
  }
}

/** Every way to settle a quote other than the online link, one method at a
 *  time behind a segmented control: the bank transfer, each peer-to-peer app,
 *  and the shop counter. Rendered inside the page's payment side panel,
 *  which both unpaid cards (payment link and invoice) open, so the two
 *  disclose the same thing.
 *
 *  The client is on their phone, switching between this page and their
 *  banking app, so every fact they will type there is a full-width button
 *  that copies itself — the icon is only the hint — and the rows follow the
 *  order a transfer form asks for them. The quote number is the transfer
 *  reference and sits where it gets typed: a "reference" row in the bank
 *  pane, a "message" row in the app panes, nowhere in the shop pane. Values
 *  come from `aitoBankDetails` and `AITO3D_SENDER` verbatim; only the labels
 *  are translated — IBAN, BIC and RIB are acronyms in every language. */
export function TrackingPaymentMethods({ open, reference, onFindShop }: { open: boolean; reference: string | null; onFindShop?: (from: HTMLElement) => void }) {
  const { t } = useTranslation();
  const [method, setMethod] = useState<Method>('transfer');
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

  const tabId = useId();
  // An app's tab is its own name — "Revolut" is "Revolut" in every language;
  // only the two methods we named ourselves are translated.
  const labelOf = (m: Method) => {
    if (m === 'transfer') return t('aito.track.paymentMethods.transfer');
    if (m === 'shop') return t('aito.track.paymentMethods.shop');
    return m;
  };
  const idOf = (m: Method) => `${tabId}-${m}`;

  // The selected tab's pill: measured, because tab widths follow their labels
  // ("Überweisung" is wider than "Virement") rather than splitting the bar in
  // equal quarters. Re-measured on resize and whenever the language changes
  // the labels (the label text is part of the effect's inputs via `labels`).
  const listRef = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);
  const labels = METHODS.map(labelOf).join(' ');
  useLayoutEffect(() => {
    const measure = () => {
      const tab = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!tab) return;
      setPill({ left: tab.offsetLeft, width: tab.offsetWidth });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [method, labels]);

  // The pane's height tweens between methods so the card's footer glides
  // instead of jumping: capture the height before the switch, then animate
  // to the new pane's height once it has rendered. Skipped under reduced
  // motion — the pane still fades (`animate-rise` is neutralised in CSS).
  const wrapRef = useRef<HTMLDivElement>(null);
  const fromHeight = useRef<number | null>(null);
  const select = (next: Method) => {
    if (next === method) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    fromHeight.current = reduce ? null : (wrapRef.current?.offsetHeight ?? null);
    setMethod(next);
  };
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const from = fromHeight.current;
    fromHeight.current = null;
    if (!wrap || from === null) return;
    const to = wrap.scrollHeight;
    if (to === from) return;
    wrap.style.height = `${from}px`;
    void wrap.offsetWidth;
    wrap.style.height = `${to}px`;
    const clear = () => {
      wrap.style.height = '';
    };
    wrap.addEventListener('transitionend', clear, { once: true });
    return () => {
      wrap.removeEventListener('transitionend', clear);
      clear();
    };
  }, [method]);

  const onTabKey = (e: React.KeyboardEvent, index: number) => {
    const next = tabTarget(e.key, index, METHODS.length - 1);
    if (next < 0) return;
    e.preventDefault();
    select(METHODS[next]);
    document.getElementById(idOf(METHODS[next]))?.focus();
  };

  const fact = (key: string, label: string, value: string, copyLabel: string, lead = false) => (
    <Fact key={key} label={label} value={value} lead={lead} copyLabel={copyLabel} copied={copied === key} onCopy={() => void copy(key, value)} />
  );
  const referenceRow = (label: string) =>
    reference
      ? fact('reference', label, reference, t('aito.track.paymentMethods.copyReference'))
      : <Fact key="reference" label={label} value={t('aito.track.paymentMethods.referenceUnknown')} />;

  const app = AITO3D_TRANSFER_APPS.find((a) => a.name === method);
  // The line under the pane: how long the money takes, or what to do with
  // the facts above it.
  let hint = t('aito.track.paymentMethods.shopHint');
  if (method === 'transfer') hint = t('aito.track.paymentMethods.transferDelay');
  else if (app) hint = t('aito.track.paymentMethods.appHint', { app: app.name });

  return (
    <div data-testid="track-payment-methods" className={`${open ? 'animate-rise' : ''} mt-[12px] px-[16px] text-[13px] text-aito-muted`}>
      <div
        ref={listRef}
        role="tablist"
        aria-label={t('aito.track.paymentMethods.methods')}
        className="relative flex rounded-[9px] border border-aito-line bg-black/[0.28] p-[3px]"
      >
        {pill && (
          <span
            aria-hidden="true"
            className="track-seg-pill pointer-events-none absolute top-[3px] bottom-[3px] rounded-[7px] bg-aito-card shadow-[0_0_0_1px_var(--color-aito-line)]"
            style={{ left: pill.left, width: pill.width }}
          />
        )}
        {METHODS.map((m, i) => {
          const selected = m === method;
          return (
            <button
              key={m}
              id={idOf(m)}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`${idOf(m)}-pane`}
              tabIndex={selected ? 0 : -1}
              onClick={() => select(m)}
              onKeyDown={(e) => onTabKey(e, i)}
              className={`relative z-[1] min-h-[36px] min-w-0 flex-1 basis-auto whitespace-nowrap rounded-[7px] px-[8px] text-[13px] font-semibold transition-colors duration-150 ${selected ? 'text-aito-ink' : 'text-aito-muted'} focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-aito-cyan`}
            >
              {labelOf(m)}
            </button>
          );
        })}
      </div>

      <div ref={wrapRef} className="track-pane-wrap @container mt-[10px] overflow-hidden">
        <div key={method} id={`${idOf(method)}-pane`} role="tabpanel" aria-labelledby={idOf(method)} className="animate-rise rounded-[10px] border border-aito-line">
          {method === 'transfer' && (
            <>
              {fact('iban', 'IBAN', AITO3D_BANK.iban, t('aito.track.paymentMethods.copyIban'), true)}
              {fact('beneficiary', t('aito.track.paymentMethods.beneficiary'), AITO3D_BANK.beneficiary, t('aito.track.paymentMethods.copyBeneficiary'))}
              {fact('bic', 'BIC', AITO3D_BANK.bic, t('aito.track.paymentMethods.copyBic'))}
              {referenceRow(t('aito.track.paymentMethods.transferReference'))}
              <Fact label={t('aito.track.paymentMethods.bank')} value={AITO3D_BANK.bank} />
              {fact('rib', 'RIB', AITO3D_BANK.rib.join(' '), t('aito.track.paymentMethods.copyRib'))}
            </>
          )}
          {app && (
            <>
              {fact(app.name, t('aito.track.paymentMethods.appTag', { app: app.name }), app.tag, t('aito.track.paymentMethods.copyTag', { app: app.name }), true)}
              {referenceRow(t('aito.track.paymentMethods.appMessage'))}
            </>
          )}
          {method === 'shop' && (
            <>
              <p className="px-[14px] py-[12px] text-[15px] font-semibold text-aito-ink">{t('aito.track.paymentMethods.shopSub')}</p>
              <Fact label={t('aito.track.paymentMethods.shopAddress')} value={`${AITO3D_SENDER.addressLines[0]}, ${AITO3D_SENDER.addressLines[1]}`} />
            </>
          )}
        </div>
        {/* The shop pane hands off to the page's shop panel (map, directions)
            when there is one: the address alone is not the way there. */}
        {method === 'shop' && onFindShop && (
          <button
            type="button"
            onClick={(e) => onFindShop(e.currentTarget)}
            className={`mx-[4px] mt-[14px] inline-flex min-h-[44px] items-center gap-[6px] rounded-[8px] text-[13px] font-semibold text-aito-cyan transition-colors duration-150 hover:text-aito-cyan/80 min-[1060px]:mt-[8px] min-[1060px]:min-h-[36px] ${FOCUS}`}
          >
            <MapPin className="h-[14px] w-[14px]" aria-hidden="true" />
            {t('aito.track.paymentMethods.findShop')}
          </button>
        )}
      </div>

      <p className="mx-[4px] mt-[10px] text-[12.5px]">{hint}</p>
      <span className="sr-only" aria-live="polite">
        {copied ? t('aito.track.paymentMethods.copied') : ''}
      </span>
    </div>
  );
}

const COPY_ICON = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-[14px] w-[14px] shrink-0" aria-hidden="true">
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
  </svg>
);
const CHECK_ICON = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-[14px] w-[14px] shrink-0" aria-hidden="true">
    <path d="M3 8.5l3 3 7-7" />
  </svg>
);

/** One row of the pane: a label and a value. With `onCopy` the whole row is
 *  a button that copies the value — a 44 px target, not a 14 px icon — and
 *  confirms with a check, the word "copied", and a brief green flash of the
 *  row. Without it, the row is plain text (the bank's name, the shop's
 *  address: nothing anyone types). `lead` sets the value large with its
 *  label above: the one value the client came for. Label and value share a
 *  line only when the PANE is wide enough (a container query, not the
 *  viewport: the 360 px side panel on a desktop stacks them, a tablet's
 *  full-width sheet does not). */
function Fact({ label, value, lead = false, copyLabel, copied = false, onCopy }: { label: string; value: string; lead?: boolean; copyLabel?: string; copied?: boolean; onCopy?: () => void }) {
  const { t } = useTranslation();
  const layout = `flex w-full items-center gap-[10px] border-t border-aito-line py-[7px] pr-[10px] pl-[14px] first:border-t-0 ${lead ? 'py-[12px] min-[1060px]:py-[9px]' : 'min-h-[44px] min-[1060px]:min-h-[40px]'}`;
  const body = (
    <span className={`min-w-0 flex-1 ${lead ? '' : '@min-[440px]:grid @min-[440px]:grid-cols-[128px_1fr] @min-[440px]:items-center @min-[440px]:gap-x-[14px]'}`}>
      <span className={`block text-aito-muted ${lead ? 'text-[12px]' : 'text-[12px] @min-[440px]:text-[13px]'}`}>{label}</span>
      <span className={`block min-w-0 break-words tabular-nums text-aito-ink ${lead ? 'mt-[2px] text-[17px] font-semibold tracking-[0.02em]' : 'text-[13px]'}`}>{value}</span>
    </span>
  );
  if (!onCopy) return <div className={layout}>{body}</div>;
  return (
    <button
      type="button"
      aria-label={copyLabel}
      data-copied={copied || undefined}
      onClick={onCopy}
      className={`group ${layout} rounded-[8px] text-left transition-colors duration-150 hover:bg-white/[0.03] active:bg-white/[0.05] data-copied:animate-track-copied ${FOCUS} focus-visible:-outline-offset-2`}
    >
      {body}
      <span
        className={`inline-flex h-[28px] min-w-[28px] shrink-0 items-center justify-center gap-[6px] rounded-[6px] px-[6px] text-[12px] font-semibold transition-colors duration-150 ${copied ? 'text-emerald-400' : 'text-aito-muted group-hover:text-aito-cyan group-focus-visible:text-aito-cyan'}`}
      >
        {copied ? CHECK_ICON : COPY_ICON}
        {copied && <span>{t('aito.track.paymentMethods.copied')}</span>}
      </span>
    </button>
  );
}
