import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  FolderOpen,
  Loader2,
  FileBox,
  X,
  Link2,
  Unlink,
  Archive as ArchiveIcon,
  Briefcase,
  FolderSymlink,
} from 'lucide-react';
import { api } from '../../api/client';
import type {
  LibraryFolderTree,
  LibraryFolderCreate,
  LibraryFolderUpdate,
  ExternalFolderCreate,
  Archive,
} from '../../api/client';
import { Button } from '../Button';
import { assignableProjects } from '../../utils/projectTree';
import { isValidFolderMove, isWritableFolder, moveDisallowedFolderIds } from '../../utils/libraryFolders';
import { type TFunction } from './fileTypes';

// New Folder Modal
interface NewFolderModalProps {
  parentId: number | null;
  onClose: () => void;
  onSave: (data: LibraryFolderCreate) => void;
  isLoading: boolean;
  t: TFunction;
}

export function NewFolderModal({ parentId, onClose, onSave, isLoading, t }: NewFolderModalProps) {
  const [name, setName] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({ name: name.trim(), parent_id: parentId });
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 animate-overlay-in">
      <div className="bg-bambu-dark-secondary rounded-lg w-full max-w-sm border border-bambu-dark-tertiary animate-modal-in">
        <div className="p-4 border-b border-bambu-dark-tertiary">
          <h2 className="text-lg font-semibold text-white">{t('fileManager.newFolder')}</h2>
        </div>
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-white mb-1">
              {t('fileManager.folderName')}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-bambu-dark border border-bambu-dark-tertiary rounded px-3 py-2 text-white placeholder-bambu-gray focus:outline-none focus:border-bambu-green"
              placeholder={t('fileManager.folderNamePlaceholder')}
              autoFocus
              required
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!name.trim() || isLoading}>
              {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : t('common.create')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// External Folder Modal
interface ExternalFolderModalProps {
  onClose: () => void;
  onSave: (data: ExternalFolderCreate) => void;
  isLoading: boolean;
  t: TFunction;
}

export function ExternalFolderModal({ onClose, onSave, isLoading, t }: ExternalFolderModalProps) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [readonly, setReadonly] = useState(true);
  const [showHidden, setShowHidden] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      name: name.trim(),
      external_path: path.trim(),
      readonly,
      show_hidden: showHidden,
    });
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 animate-overlay-in">
      <div className="bg-bambu-dark-secondary rounded-lg w-full max-w-md border border-bambu-dark-tertiary animate-modal-in">
        <div className="p-4 border-b border-bambu-dark-tertiary">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <FolderSymlink className="w-5 h-5 text-bambu-green" />
            {t('fileManager.linkExternalFolder')}
          </h2>
          <p className="text-sm text-bambu-gray mt-1">{t('fileManager.linkExternalFolderDescription')}</p>
        </div>
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-white mb-1">
              {t('fileManager.folderName')}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-bambu-dark border border-bambu-dark-tertiary rounded px-3 py-2 text-white placeholder-bambu-gray focus:outline-none focus:border-bambu-green"
              placeholder={t('fileManager.externalFolderNamePlaceholder')}
              autoFocus
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-white mb-1">
              {t('fileManager.externalPath')}
            </label>
            <input
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              className="w-full bg-bambu-dark border border-bambu-dark-tertiary rounded px-3 py-2 text-white placeholder-bambu-gray focus:outline-none focus:border-bambu-green font-mono text-sm"
              placeholder="/mnt/nas/3d-prints"
              required
            />
            <p className="text-xs text-bambu-gray mt-1">{t('fileManager.externalPathHelp')}</p>
          </div>
          <div className="space-y-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={readonly}
                onChange={(e) => setReadonly(e.target.checked)}
                className="rounded border-bambu-dark-tertiary bg-bambu-dark text-bambu-green focus:ring-bambu-green"
              />
              <span className="text-sm text-white">{t('fileManager.readOnly')}</span>
              <span className="text-xs text-bambu-gray">({t('fileManager.readOnlyHelp')})</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={showHidden}
                onChange={(e) => setShowHidden(e.target.checked)}
                className="rounded border-bambu-dark-tertiary bg-bambu-dark text-bambu-green focus:ring-bambu-green"
              />
              <span className="text-sm text-white">{t('fileManager.showHiddenFiles')}</span>
            </label>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!name.trim() || !path.trim() || isLoading}>
              {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : t('fileManager.linkFolder')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// FAT32/exFAT-illegal chars rejected by Bambu Studio (#1540). Mirrors the
// backend validator in backend/app/utils/filename.py — keep in sync.
const INVALID_FILENAME_CHARS = '<>:"/\\|?*';

function findInvalidFilenameChar(name: string): string | null {
  for (const ch of name) {
    if (INVALID_FILENAME_CHARS.includes(ch)) return ch;
    if (ch.charCodeAt(0) < 0x20) return ch;
  }
  return null;
}

// Rename Modal
interface RenameModalProps {
  type: 'file' | 'folder';
  currentName: string;
  onClose: () => void;
  onSave: (newName: string) => void;
  isLoading: boolean;
  t: TFunction;
}

export function RenameModal({ type, currentName, onClose, onSave, isLoading, t }: RenameModalProps) {
  // For files, separate the extension so users can only edit the base name
  // Handle compound extensions like .gcode.3mf
  const fileExtension = type === 'file' ? (currentName.match(/(\.gcode\.3mf|\.3mf|\.gcode)$/i)?.[1] ?? '') : '';
  const baseName = type === 'file' && fileExtension ? currentName.slice(0, -fileExtension.length) : currentName;
  const [name, setName] = useState(baseName);

  const invalidChar = type === 'file' ? findInvalidFilenameChar(name) : null;
  const filenameError = invalidChar
    ? t('fileManager.invalidFilenameChar', { char: invalidChar })
    : null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (filenameError) return;
    const fullName = type === 'file' ? name.trim() + fileExtension : name.trim();
    if (name.trim() && fullName !== currentName) {
      onSave(fullName);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 animate-overlay-in">
      <div className="bg-bambu-dark-secondary rounded-lg w-full max-w-sm border border-bambu-dark-tertiary animate-modal-in">
        <div className="p-4 border-b border-bambu-dark-tertiary">
          <h2 className="text-lg font-semibold text-white">{type === 'file' ? t('fileManager.renameFile') : t('fileManager.renameFolder')}</h2>
        </div>
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-white mb-1">
              {t('common.name')}
            </label>
            <div className={`flex items-center bg-bambu-dark border rounded focus-within:border-bambu-green ${filenameError ? 'border-red-500' : 'border-bambu-dark-tertiary'}`}>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="flex-1 bg-transparent px-3 py-2 text-white placeholder-bambu-gray focus:outline-none min-w-0"
                autoFocus
                required
              />
              {fileExtension && (
                <span className="pr-3 text-bambu-gray text-sm select-none whitespace-nowrap">{fileExtension}</span>
              )}
            </div>
            {filenameError && (
              <p className="mt-1 text-xs text-red-700 dark:text-red-400">{filenameError}</p>
            )}
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!name.trim() || name.trim() === baseName || !!filenameError || isLoading}>
              {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : t('common.rename')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Destination picker shared by "Move files" and "Move folder" (#3305): the
// root entry, then the tree flattened with indentation. `disabledIds` greys a
// folder out with `disabledTitle`; `currentId` marks (and disables) the one
// the items already live in.
type MoveTarget = { id: number | null; name: string; depth: number; canWrite: boolean };

interface FolderTargetListProps {
  folders: LibraryFolderTree[];
  rootLabel: string;
  currentId: number | null;
  disabledIds?: Set<number>;
  disabledTitle?: string;
  // undefined = nothing picked yet (null is the root entry).
  value: number | null | undefined;
  onChange: (id: number | null) => void;
  t: TFunction;
}

function FolderTargetList({ folders, rootLabel, currentId, disabledIds, disabledTitle, value, onChange, t }: FolderTargetListProps) {
  // can_write: a library:read_own user moves files only into their own and
  // shared folders (#3201); the rest stay listed so the tree keeps its shape.
  const flattenFolders = (items: LibraryFolderTree[], depth = 0): MoveTarget[] => {
    const result: MoveTarget[] = [];
    for (const item of items) {
      result.push({ id: item.id, name: item.name, depth, canWrite: isWritableFolder(item) });
      if (item.children.length > 0) {
        result.push(...flattenFolders(item.children, depth + 1));
      }
    }
    return result;
  };

  const flatFolders: MoveTarget[] = [{ id: null, name: rootLabel, depth: 0, canWrite: true }, ...flattenFolders(folders)];

  return (
    <div className="max-h-64 overflow-y-auto space-y-1">
      {flatFolders.map((folder) => {
        const isCurrent = folder.id === currentId;
        const isExcluded = folder.id !== null && disabledIds?.has(folder.id) === true;
        const disabled = isCurrent || isExcluded || !folder.canWrite;
        return (
          <button
            key={folder.id ?? 'root'}
            onClick={() => onChange(folder.id)}
            disabled={disabled}
            title={isExcluded ? disabledTitle : !folder.canWrite ? t('fileManager.folderNotWritable') : undefined}
            className={`w-full text-left px-3 py-2 rounded transition-colors flex items-center gap-2 ${
              value === folder.id
                ? 'bg-bambu-green/20 text-bambu-green'
                : disabled
                ? 'opacity-50 cursor-not-allowed text-bambu-gray'
                : 'hover:bg-bambu-dark text-white'
            }`}
            style={{ paddingLeft: `${12 + folder.depth * 16}px` }}
          >
            <FolderOpen className="w-4 h-4" />
            {folder.name}
            {isCurrent && <span className="text-xs text-bambu-gray ml-auto">({t('fileManager.current')})</span>}
          </button>
        );
      })}
    </div>
  );
}

// Move Files Modal
interface MoveFilesModalProps {
  folders: LibraryFolderTree[];
  selectedFiles: number[];
  currentFolderId: number | null;
  onClose: () => void;
  onMove: (folderId: number | null) => void;
  isLoading: boolean;
  t: TFunction;
}

export function MoveFilesModal({ folders, selectedFiles, currentFolderId, onClose, onMove, isLoading, t }: MoveFilesModalProps) {
  const [targetFolder, setTargetFolder] = useState<number | null>(null);

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 animate-overlay-in">
      <div className="bg-bambu-dark-secondary rounded-lg w-full max-w-sm border border-bambu-dark-tertiary animate-modal-in">
        <div className="p-4 border-b border-bambu-dark-tertiary">
          <h2 className="text-lg font-semibold text-white">{t('fileManager.moveFiles', { count: selectedFiles.length })}</h2>
        </div>
        <div className="p-4 space-y-4">
          <FolderTargetList
            folders={folders}
            rootLabel={t('fileManager.rootNoFolder')}
            currentId={currentFolderId}
            value={targetFolder}
            onChange={setTargetFolder}
            t={t}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => onMove(targetFolder)} disabled={isLoading}>
              {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : t('common.move')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Move Folder Modal (#3305). Same picker as files, minus the folder itself,
// its subtree and every external folder; "Root" lifts it to the top level.
interface MoveFolderModalProps {
  folders: LibraryFolderTree[];
  folder: LibraryFolderTree;
  onClose: () => void;
  onMove: (parentId: number | null) => void;
  isLoading: boolean;
  t: TFunction;
}

export function MoveFolderModal({ folders, folder, onClose, onMove, isLoading, t }: MoveFolderModalProps) {
  const [targetFolder, setTargetFolder] = useState<number | null | undefined>(undefined);
  const disabledIds = useMemo(() => moveDisallowedFolderIds(folders, folder.id), [folders, folder.id]);
  const canMove = targetFolder !== undefined && isValidFolderMove(folders, folder, targetFolder);

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-bambu-dark-secondary rounded-lg w-full max-w-sm border border-bambu-dark-tertiary">
        <div className="p-4 border-b border-bambu-dark-tertiary">
          <h2 className="text-lg font-semibold text-white truncate">{t('fileManager.moveFolderTo', { name: folder.name })}</h2>
        </div>
        <div className="p-4 space-y-4">
          <FolderTargetList
            folders={folders}
            rootLabel={t('fileManager.moveToRoot')}
            currentId={folder.parent_id}
            disabledIds={disabledIds}
            disabledTitle={t('fileManager.moveFolderInvalidTarget')}
            value={targetFolder}
            onChange={setTargetFolder}
            t={t}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => targetFolder !== undefined && onMove(targetFolder)} disabled={isLoading || !canMove}>
              {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : t('common.move')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Link Folder Modal
interface LinkFolderModalProps {
  folder: LibraryFolderTree;
  onClose: () => void;
  onLink: (update: LibraryFolderUpdate) => void;
  isLoading: boolean;
  t: TFunction;
}

export function LinkFolderModal({ folder, onClose, onLink, isLoading, t }: LinkFolderModalProps) {
  const [linkType, setLinkType] = useState<'project' | 'archive'>('project');
  const [selectedId, setSelectedId] = useState<number | null>(
    folder.project_id || folder.archive_id || null
  );

  // Initialize linkType based on existing link
  useState(() => {
    if (folder.archive_id) setLinkType('archive');
  });

  // Archived projects are left out, bar the one this folder is already linked
  // to -- dropping that one would leave the folder looking unlinked while the
  // link is still there (#2888).
  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.getProjects(),
    select: (rows) =>
      assignableProjects([...rows].sort((a, b) => a.name.localeCompare(b.name)), folder.project_id),
  });

  const { data: archives } = useQuery({
    queryKey: ['archives-for-link'],
    queryFn: () => api.getArchives(undefined, undefined, 100),
  });

  const handleSave = () => {
    if (linkType === 'project') {
      onLink({
        project_id: selectedId,
        archive_id: 0, // Unlink archive
      });
    } else {
      onLink({
        project_id: 0, // Unlink project
        archive_id: selectedId,
      });
    }
  };

  const handleUnlink = () => {
    onLink({
      project_id: 0,
      archive_id: 0,
    });
  };

  const isLinked = folder.project_id || folder.archive_id;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 animate-overlay-in">
      <div className="bg-bambu-dark-secondary rounded-lg w-full max-w-md border border-bambu-dark-tertiary animate-modal-in">
        <div className="p-4 border-b border-bambu-dark-tertiary flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <Link2 className="w-5 h-5 text-bambu-green" />
            {t('fileManager.linkFolder')}
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-bambu-dark rounded">
            <X className="w-5 h-5 text-bambu-gray" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <p className="text-sm text-bambu-gray">
            {t('fileManager.linkFolderDescription', { name: folder.name })}
          </p>

          {/* Link type selector */}
          <div className="flex gap-2">
            <button
              onClick={() => { setLinkType('project'); setSelectedId(null); }}
              className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg border transition-colors ${
                linkType === 'project'
                  ? 'border-bambu-green bg-bambu-green/10 text-bambu-green'
                  : 'border-bambu-dark-tertiary text-bambu-gray hover:text-white'
              }`}
            >
              <Briefcase className="w-4 h-4" />
              {t('fileManager.project')}
            </button>
            <button
              onClick={() => { setLinkType('archive'); setSelectedId(null); }}
              className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg border transition-colors ${
                linkType === 'archive'
                  ? 'border-bambu-green bg-bambu-green/10 text-bambu-green'
                  : 'border-bambu-dark-tertiary text-bambu-gray hover:text-white'
              }`}
            >
              <ArchiveIcon className="w-4 h-4" />
              {t('fileManager.archive')}
            </button>
          </div>

          {/* Selection list */}
          <div className="max-h-64 overflow-y-auto space-y-1 bg-bambu-dark rounded-lg p-2">
            {linkType === 'project' ? (
              projects && projects.length > 0 ? (
                projects.map((project) => (
                  <button
                    key={project.id}
                    onClick={() => setSelectedId(project.id)}
                    className={`w-full text-left px-3 py-2 rounded transition-colors flex items-center gap-2 ${
                      selectedId === project.id
                        ? 'bg-bambu-green/20 text-bambu-green'
                        : 'hover:bg-bambu-dark-tertiary text-white'
                    }`}
                  >
                    <div
                      className="w-3 h-3 rounded-full flex-shrink-0"
                      style={{ backgroundColor: project.color || '#00ae42' }}
                    />
                    <span className="truncate">{project.name}</span>
                  </button>
                ))
              ) : (
                <p className="text-sm text-bambu-gray text-center py-4">{t('fileManager.noProjectsFound')}</p>
              )
            ) : (
              archives && archives.length > 0 ? (
                archives.map((archive: Archive) => (
                  <button
                    key={archive.id}
                    onClick={() => setSelectedId(archive.id)}
                    className={`w-full text-left px-3 py-2 rounded transition-colors flex items-center gap-2 ${
                      selectedId === archive.id
                        ? 'bg-bambu-green/20 text-bambu-green'
                        : 'hover:bg-bambu-dark-tertiary text-white'
                    }`}
                  >
                    <FileBox className="w-4 h-4 text-bambu-gray flex-shrink-0" />
                    <span className="truncate">{archive.print_name || archive.filename}</span>
                  </button>
                ))
              ) : (
                <p className="text-sm text-bambu-gray text-center py-4">{t('fileManager.noArchivesFound')}</p>
              )
            )}
          </div>
        </div>

        <div className="p-4 border-t border-bambu-dark-tertiary flex justify-between">
          {isLinked && (
            <Button variant="danger" onClick={handleUnlink} disabled={isLoading}>
              <Unlink className="w-4 h-4 mr-2" />
              {t('fileManager.unlink')}
            </Button>
          )}
          <div className={`flex gap-2 ${!isLinked ? 'ml-auto' : ''}`}>
            <Button variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleSave} disabled={!selectedId || isLoading}>
              {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : t('fileManager.link')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
