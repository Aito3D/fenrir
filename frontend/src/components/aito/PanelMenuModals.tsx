import type { AitoProject } from '../../api/client';
import type { TaskDraft } from '../../utils/taskDraft';
import { MergeProjectModal } from './MergeProjectModal';
import { TaskTransferModal } from './TaskTransferModal';
import { TransferClientModal } from './TransferClientModal';
import { WatchModal } from './WatchModal';

/** The open flags ProjectDetailPanel's `usePanelMenuModals` owns for these
 *  four dialogs (the fifth flag, `trashing`, mounts its confirm in the panel
 *  itself, after the duplicate confirm). */
interface MenuModalFlags {
  merging: boolean;
  setMerging: (open: boolean) => void;
  transferringClient: boolean;
  setTransferringClient: (open: boolean) => void;
  watchOpen: boolean;
  setWatchOpen: (open: boolean) => void;
  transferMode: 'split' | 'move' | null;
  setTransferMode: (mode: 'split' | 'move' | null) => void;
}

interface PanelMenuModalsProps {
  project: AitoProject;
  modals: MenuModalFlags;
  tasks: TaskDraft[];
  /** A row still being created, or an edit not yet saved (debounced or in flight). */
  savesPending: boolean;
  onOpenCard?: (id: number) => void;
}

/** The dialogs the Stage card's ⋯ menu opens, rendered from the panel's
 *  flags. Pure rendering: the flags stay in the panel (see
 *  `usePanelMenuModals`), so a dialog outlives the menu that launched it and
 *  resets exactly when the panel's own state does. */
export function PanelMenuModals({ project, modals, tasks, savesPending, onOpenCard }: PanelMenuModalsProps) {
  const {
    merging,
    setMerging,
    transferringClient,
    setTransferringClient,
    watchOpen,
    setWatchOpen,
    transferMode,
    setTransferMode,
  } = modals;
  return (
    <>
      {merging && <MergeProjectModal project={project} onClose={() => setMerging(false)} />}
      {/* The new client reaches the header through the board cache the
          modal writes on success — nothing to hand back here. */}
      {transferringClient && <TransferClientModal project={project} onClose={() => setTransferringClient(false)} />}
      {watchOpen && <WatchModal project={project} onClose={() => setWatchOpen(false)} />}
      {transferMode && (
        <TaskTransferModal
          project={project}
          tasks={tasks}
          mode={transferMode}
          savesPending={savesPending}
          onClose={() => setTransferMode(null)}
          onDone={({ target }) => {
            // A split hands the operator the card it just made (the host
            // swaps the panel to it); a move keeps them on this one, where
            // the task list's resync drops the rows that left.
            setTransferMode(null);
            if (transferMode === 'split') onOpenCard?.(target.id);
          }}
        />
      )}
    </>
  );
}
