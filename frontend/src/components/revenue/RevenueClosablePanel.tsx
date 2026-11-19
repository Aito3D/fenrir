import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Panel } from '../aito/stats/primitives';
import { focusRingCls } from '../formStyles';

/** A panel the page opens under its header: takes focus on mount, closes from its own × (the page puts focus back). */
export function RevenueClosablePanel({ title, action, onClose, children }: { title: string; action?: ReactNode; onClose: () => void; children: ReactNode }) {
  const { t } = useTranslation();
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <div role="region" aria-labelledby={id}>
      <Panel
        title={
          <h2 id={id} ref={heading} tabIndex={-1} className={`text-xs uppercase tracking-wide text-bambu-gray ${focusRingCls}`}>
            {title}
          </h2>
        }
        action={
          <div className="flex flex-wrap items-center gap-3">
            {action}
            <button type="button" aria-label={t('revenue.panelClose')} title={t('revenue.panelClose')} onClick={onClose}
              className={`rounded p-1 text-bambu-gray hover:text-white ${focusRingCls}`}>
              <X aria-hidden className="h-4 w-4" />
            </button>
          </div>
        }
      >
        {children}
      </Panel>
    </div>
  );
}
