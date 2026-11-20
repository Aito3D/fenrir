import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { focusRingCls } from '../formStyles';

const ITEM = `block w-full rounded-md px-2.5 py-1.5 text-left text-sm text-bambu-gray-light hover:bg-bambu-dark-tertiary hover:text-white focus:bg-bambu-dark-tertiary focus:text-white focus:outline-none disabled:opacity-40 disabled:hover:bg-transparent`;
const ENABLED_ITEM = '[role="menuitem"]:not(:disabled)';

/**
 * The page's ⋯ menu: targets editor, items to classify, copy and export (`revenue:export`, once the
 * dashboard is ready) and the full rebuild (`revenue:sync`, asked first). ↑ ↓ Home End move, Escape
 * closes; a pick closes the menu and puts focus back on ⋯ before it runs. The rebuild confirmation
 * opens on « Annuler », ignores held-key repeats and the second click of a double click.
 */
export function RevenueMenu(p: {
  canExport: boolean;
  canSync: boolean;
  ready: boolean;
  rebuildBusy: boolean;
  reviewCount: number;
  targetsOpen: boolean;
  onTargets: () => void;
  /** Absent without the margin permission: wages are margin data. */
  laborOpen?: boolean;
  onLabor?: () => void;
  onReview: () => void;
  onCopy: () => void;
  onExport: () => void;
  onRebuild: () => void;
  /** The ⋯ button, for the page to put focus back on. */
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [alignLeft, setAlignLeft] = useState(false);
  const trigger = p.triggerRef;
  const menu = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const questionId = useId();
  const items = () => Array.from(menu.current?.querySelectorAll<HTMLButtonElement>(ENABLED_ITEM) ?? []);

  useEffect(() => {
    // Never land on « Oui »: the Enter that opened the confirmation must not be able to confirm it.
    if (open) (confirm ? cancel.current : menu.current?.querySelector<HTMLButtonElement>(ENABLED_ITEM))?.focus();
  }, [open, confirm]);

  const close = () => {
    setOpen(false);
    setConfirm(false);
    trigger.current?.focus();
  };
  const pick = (action: () => void) => () => {
    close();
    action();
  };

  const confirmRebuild = (e: MouseEvent) => {
    // A double click's second click lands on « Oui » where « Reconstruire » was.
    if (e.detail > 1) return;
    pick(p.onRebuild)();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // A held key's auto-repeat would walk through Reconstruire → Annuler → … without the user meaning it.
    if (e.repeat && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      return;
    }
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: list.length - 1 }[e.key];
    if (e.key === 'Escape') close();
    else if (e.key === 'Tab') {
      setOpen(false);
      setConfirm(false);
    } else if (to !== undefined && list.length > 0) list[(to + list.length) % list.length].focus();
    else return;
    if (e.key !== 'Tab') e.preventDefault();
  };

  return (
    <div className="relative">
      <button ref={trigger} type="button" aria-label={t('revenue.menu.more')} title={t('revenue.menu.more')} aria-haspopup="menu" aria-expanded={open}
        onClick={() => {
          if (open) return close();
          // A wrapped phone header puts ⋯ near the left edge: a right-aligned menu (w-60, 216 px) would start off screen.
          setAlignLeft((trigger.current?.getBoundingClientRect().right ?? Infinity) < 240);
          setOpen(true);
        }}
        className={`rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary px-3 py-1.5 text-sm text-bambu-gray-light hover:text-white ${focusRingCls}`}>
        ⋯
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => { setOpen(false); setConfirm(false); }} />
          <div ref={menu} role="menu" aria-label={t('revenue.menu.more')} onKeyDown={onKeyDown}
            className={`absolute ${alignLeft ? 'left-0' : 'right-0'} top-full z-20 mt-1 w-60 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary p-1.5 shadow-xl`}>
            {confirm ? (
              <>
                <p id={questionId} className="px-2.5 py-1.5 text-sm text-amber-700 dark:text-amber-400">{t('revenue.sync.rebuildConfirm')}</p>
                <button type="button" role="menuitem" aria-describedby={questionId} className={`${ITEM} text-amber-700 dark:text-amber-400`} onClick={confirmRebuild}>{t('revenue.sync.rebuildYes')}</button>
                <button ref={cancel} type="button" role="menuitem" className={ITEM} onClick={() => setConfirm(false)}>{t('revenue.sync.cancel')}</button>
              </>
            ) : (
              <>
                <button type="button" role="menuitem" className={ITEM} onClick={pick(p.onTargets)}>
                  {p.targetsOpen ? t('revenue.menu.hideTargets') : t('revenue.menu.targets')}
                </button>
                {p.onLabor && (
                  <button type="button" role="menuitem" className={ITEM} onClick={pick(p.onLabor)}>
                    {p.laborOpen ? t('revenue.menu.hideLabor') : t('revenue.menu.labor')}
                  </button>
                )}
                <button type="button" role="menuitem" className={ITEM} onClick={pick(p.onReview)}>
                  {t('revenue.menu.review')}{p.reviewCount > 0 ? ` (${p.reviewCount})` : ''}
                </button>
                {p.canExport && (
                  <>
                    <div role="separator" className="my-1 border-t border-bambu-dark-tertiary" />
                    <button type="button" role="menuitem" className={ITEM} disabled={!p.ready} onClick={pick(p.onCopy)}>{t('revenue.menu.copy')}</button>
                    <button type="button" role="menuitem" className={ITEM} disabled={!p.ready} onClick={pick(p.onExport)}>{t('revenue.menu.export')}</button>
                  </>
                )}
                {p.canSync && (
                  <>
                    <div role="separator" className="my-1 border-t border-bambu-dark-tertiary" />
                    <button type="button" role="menuitem" className={ITEM} disabled={p.rebuildBusy} onClick={() => setConfirm(true)}>{t('revenue.sync.rebuild')}</button>
                  </>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
