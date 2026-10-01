import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Ellipsis, Merge } from 'lucide-react';
import { ActionMenu } from './ActionMenu';
import { focusRingCls } from '../formStyles';

/** The ⋯ beside "Stage & work left": the detours that change what this card
 *  IS, rather than a field on it. One item today — merge another card's
 *  tasks into this one — so the menu is the affordance that keeps the next
 *  such action from growing a third icon button on the heading.
 *
 *  Reuses ActionMenu: it is already an anchored, labelled, dismissable
 *  `role="menu"`, and the phone board's ⋯ is the same gesture. The host
 *  renders this only when the operator may both update this card and trash
 *  another (the merge route enforces both permissions) and the card is not
 *  invoiced (its tasks are frozen), so there is never a dead menu item. */
export function ProjectActionsMenu({ onMerge }: { onMerge: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const label = t('aito.moreActions');

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="project-actions-menu"
        onClick={() => setOpen(true)}
        className={`grid h-6 w-6 place-items-center rounded-md text-bambu-gray transition-colors hover:bg-bambu-dark-tertiary hover:text-white ${focusRingCls}`}
      >
        <Ellipsis className="h-4 w-4" aria-hidden="true" />
      </button>
      {open && (
        <ActionMenu
          label={label}
          anchorRef={anchorRef}
          placement="below"
          items={[{ key: 'merge', icon: Merge, label: t('aito.mergeProject'), onSelect: onMerge }]}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
