import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  ClipboardCopy,
  CopyPlus,
  Ellipsis,
  Eye,
  Merge,
  MoveRight,
  Printer,
  Split,
  Trash2,
  UserRoundPen,
} from 'lucide-react';
import { ActionMenu, type ActionMenuItem } from './ActionMenu';
import { focusRingCls } from '../formStyles';
import { useMenuShortcut } from '../../hooks/useMenuShortcut';
import type { AitoProject } from '../../api/client';

interface ProjectActionsMenuProps {
  project: AitoProject;
  /** The panel's live task list length, not `project.task_count`: the board
   *  row lags an add or a remove made in the panel by one refetch. */
  tasksCount: number;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  onMerge: () => void;
  onSplit: () => void;
  onMoveTasks: () => void;
  onCopySummary: () => void;
  onPrintTicket: () => void;
  onTransferClient: () => void;
  /** Opens the watch dialog — to start watching, or to change or stop it. */
  onWatch: () => void;
  /** Whether the signed-in user watches this card; only flips the row's label. */
  watching?: boolean;
  /** A signed-in user to watch for. Without one (auth off) there is no inbox,
   *  so the Watch row is left out rather than disabled. */
  watchAvailable: boolean;
  /** Absent when the host has no drawer to open — the row is then disabled. */
  onDuplicate?: () => void;
  /** Absent for a card the host will not trash (see AitoPage) — disabled too. */
  onDelete?: () => void;
  /** A bare key that opens the menu from anywhere on the panel (`.`). */
  shortcutKey?: string;
  /** False while the host has an overlay up, so the key never opens the
   *  menu behind it. Defaults to true. */
  shortcutEnabled?: boolean;
}

/** Every row's `disabled` and `hint`, from one place: the card's state first
 *  (trashed, then invoiced — the reasons the operator can do nothing about
 *  from here), then permission, then the task count. The first reason that
 *  applies is the one shown; the server enforces the same rules route by
 *  route, so this only keeps the menu from offering a guaranteed refusal. */
function rows(p: ProjectActionsMenuProps, t: TFunction): ActionMenuItem[] {
  const trashed = p.project.status === 'deleted';
  const invoiced = p.project.quote_invoiced;
  const hintTrashed = t('aito.hintTrashed');
  const hintInvoiced = t('aito.hintInvoiced');
  const hintNoPermission = t('aito.hintNoPermission');
  // [condition, hint] pairs in priority order → the first that holds.
  const reason = (...checks: [boolean, string][]) => checks.find(([when]) => when)?.[1];
  const item = (base: Omit<ActionMenuItem, 'disabled' | 'hint'>, hint: string | undefined): ActionMenuItem => ({
    ...base,
    disabled: hint !== undefined,
    hint,
  });

  return [
    item(
      { key: 'merge', icon: Merge, label: t('aito.mergeProject'), onSelect: p.onMerge },
      // POST /{id}/merge edits this card AND trashes the other one.
      reason([trashed, hintTrashed], [invoiced, hintInvoiced], [!(p.canUpdate && p.canDelete), hintNoPermission]),
    ),
    item(
      { key: 'split', icon: Split, label: t('aito.splitProject'), onSelect: p.onSplit },
      // A split creates the new card, so it also rides AITO_CREATE.
      reason(
        [trashed, hintTrashed],
        [invoiced, hintInvoiced],
        [!(p.canUpdate && p.canCreate), hintNoPermission],
        [p.tasksCount < 2, t('aito.hintNeedTwoTasks')],
      ),
    ),
    item(
      { key: 'move', icon: MoveRight, label: t('aito.moveTasks'), onSelect: p.onMoveTasks },
      reason(
        [trashed, hintTrashed],
        [invoiced, hintInvoiced],
        [!p.canUpdate, hintNoPermission],
        [p.tasksCount === 0, t('aito.hintNoTasks')],
      ),
    ),
    // Read-only: they only render what the panel already shows.
    { key: 'copy', icon: ClipboardCopy, label: t('aito.copySummary'), onSelect: p.onCopySummary },
    { key: 'print', icon: Printer, label: t('aito.printJobTicket'), onSelect: p.onPrintTicket },
    item(
      { key: 'transfer', icon: UserRoundPen, label: t('aito.transferClient'), onSelect: p.onTransferClient },
      reason([trashed, hintTrashed], [invoiced, hintInvoiced], [!p.canUpdate, hintNoPermission]),
    ),
    ...(p.watchAvailable
      ? [
          item(
            {
              key: 'watch',
              icon: Eye,
              label: p.watching ? t('aito.watchingCard') : t('aito.watchCard'),
              onSelect: p.onWatch,
            },
            // PUT /{id}/watch rides AITO_UPDATE and 404s a trashed card; an
            // invoiced job still pays and goes overdue, so it stays watchable.
            reason([trashed, hintTrashed], [!p.canUpdate, hintNoPermission]),
          ),
        ]
      : []),
    item(
      { key: 'duplicate', icon: CopyPlus, label: t('aito.duplicateProject'), onSelect: () => p.onDuplicate?.() },
      // Not gated on the card's state: "same thing again" is as valid for a
      // trashed or invoiced job as for a live one — it touches neither.
      reason([!p.canCreate || !p.onDuplicate, hintNoPermission]),
    ),
    item(
      {
        key: 'trash',
        icon: Trash2,
        label: t('aito.trashProject'),
        onSelect: () => p.onDelete?.(),
        separatorBefore: true,
        danger: true,
      },
      reason([trashed, hintTrashed], [!p.canDelete || !p.onDelete, hintNoPermission]),
    ),
  ];
}

/** The ⋯ beside "Stage & work left": the actions that change what this card
 *  IS, or act on it as a whole, rather than a field on it.
 *
 *  Always rendered while the panel is open, on a live card and a trashed one
 *  alike: a row the operator cannot use stays in place, muted, with the
 *  reason under its label (see `rows`). A menu that grew and shrank with the
 *  card's state taught nobody where an action lives.
 *
 *  Reuses ActionMenu: it is already an anchored, labelled, dismissable
 *  `role="menu"`, and the phone board's ⋯ is the same gesture. */
export function ProjectActionsMenu(props: ProjectActionsMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const label = t('aito.moreActions');
  useMenuShortcut(
    props.shortcutKey ?? '',
    props.shortcutKey !== undefined && (props.shortcutEnabled ?? true),
    () => setOpen(true),
  );

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
          items={rows(props, t)}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
