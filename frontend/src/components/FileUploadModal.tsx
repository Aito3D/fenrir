import { useState, useRef, useEffect, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Upload,
  X,
  File,
  Loader2,
  CheckCircle,
  XCircle,
  Archive as ArchiveIcon,
  Printer,
  Image,
  AlertTriangle,
} from 'lucide-react';
import { api } from '../api/client';
import type { DuplicateCheckItem, LibraryFileUploadResponse } from '../api/client';
import { Button } from './Button';

async function computeSha256(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

// crypto.subtle.digest is one-shot (it takes a single buffer, not a stream),
// so we can't avoid materializing each file into memory here. What we CAN
// bound is how many files are materialized/hashed *at once* — that's what
// actually caused the OOM (fanning every file out via Promise.all). A pool
// of 3 caps peak memory at ~3 files' worth of ArrayBuffers while still
// overlapping I/O + hashing across files for reasonable throughput; low
// enough to avoid the pathological "50 x 40MB simultaneously" case, high
// enough that small/typical batches aren't serialized for no reason.
const HASH_POOL_SIZE = 3;

/**
 * Runs `worker` over `items` with at most `poolSize` concurrent invocations,
 * returning results in the same order as `items` regardless of completion
 * order.
 */
async function runWithConcurrencyLimit<T, R>(
  items: T[],
  poolSize: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    const current = nextIndex++;
    if (current >= items.length) return;
    results[current] = await worker(items[current], current);
    await runNext();
  }

  const workers = Array.from({ length: Math.min(poolSize, items.length) }, () => runNext());
  await Promise.all(workers);
  return results;
}

interface UploadFile {
  file: File;
  status: 'pending' | 'checking' | 'uploading' | 'success' | 'error' | 'skipped';
  error?: string;
  isZip?: boolean;
  is3mf?: boolean;
  extractedCount?: number;
  hash?: string;
  hashError?: string;
  duplicateInfo?: DuplicateCheckItem;
  uploadAnyway?: boolean;
}

interface FileUploadModalProps {
  folderId: number | null;
  onClose: () => void;
  onUploadComplete: () => void;
  /** Called after each file is successfully uploaded with its response data. Return a string to show an error and prevent modal from closing. */
  onFileUploaded?: (file: LibraryFileUploadResponse) => string | void;
  /** When true, automatically uploads the file as soon as it's added and closes the modal */
  autoUpload?: boolean;
  /** Validate files before adding. Return a string to reject with an error message. */
  validateFile?: (file: File) => string | undefined;
  /** Restrict file picker to specific file types (e.g. ".gcode,.gcode.3mf") */
  accept?: string;
  /** Pre-seed the modal with files (e.g. from a page-wide drop) on first mount. */
  initialFiles?: File[];
}

export function FileUploadModal({ folderId, onClose, onUploadComplete, onFileUploaded, autoUpload, validateFile, accept, initialFiles }: FileUploadModalProps) {
  const { t } = useTranslation();
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [preserveZipStructure, setPreserveZipStructure] = useState(true);
  const [createFolderFromZip, setCreateFolderFromZip] = useState(false);
  const [generateStlThumbnails, setGenerateStlThumbnails] = useState(true);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    addFiles(Array.from(e.dataTransfer.files));
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      addFiles(Array.from(e.target.files));
    }
  };

  const updateFileStatus = (file: File, update: Partial<UploadFile>) => {
    setFiles((prev) => prev.map((f) => (f.file === file ? { ...f, ...update } : f)));
  };

  const uploadFiles = async (filesToUpload: UploadFile[]) => {
    setIsUploading(true);

    for (const uf of filesToUpload) {
      if (uf.status !== 'pending') continue;

      // Skip duplicates unless the user explicitly opted in for this file
      if (uf.duplicateInfo && !uf.uploadAnyway) {
        updateFileStatus(uf.file, { status: 'skipped' });
        continue;
      }

      updateFileStatus(uf.file, { status: 'uploading' });

      try {
        if (uf.isZip) {
          const result = await api.extractZipFile(uf.file, folderId, preserveZipStructure, createFolderFromZip, generateStlThumbnails);
          updateFileStatus(uf.file, {
            status: result.errors.length > 0 && result.extracted === 0 ? 'error' : 'success',
            extractedCount: result.extracted,
            error: result.errors.length > 0 ? t('fileManager.zipFilesFailed', '{{count}} files failed', { count: result.errors.length }) : undefined,
          });
        } else {
          const result = await api.uploadLibraryFile(uf.file, folderId, generateStlThumbnails);
          updateFileStatus(uf.file, { status: 'success' });
          const error = onFileUploaded?.(result);
          if (error) {
            setUploadError(error);
            setFiles([]);
            setIsUploading(false);
            return;
          }
        }
      } catch (err) {
        updateFileStatus(uf.file, {
          status: 'error',
          error: err instanceof Error ? err.message : t('fileManager.uploadFailed', 'Upload failed'),
        });
      }
    }

    setIsUploading(false);
    onUploadComplete();
    setFiles((prev) => {
      const anyFailed = prev.some((f) => f.status === 'error');
      if (!anyFailed) {
        onClose();
      }
      return prev;
    });
  };

  const checkDuplicates = async (newFiles: UploadFile[]): Promise<UploadFile[]> => {
    // ZIP files are extracted server-side — hashing them individually doesn't
    // map to their extracted contents, so skip duplicate-check for ZIPs.
    const checkable = newFiles.filter((f) => !f.isZip);

    // Always add files to state immediately so they appear in the list.
    // Non-ZIP files start in 'checking' status while hashes are computed.
    setFiles((prev) => [
      ...prev,
      ...newFiles.map((f) => ({
        ...f,
        status: (f.isZip || checkable.length === 0) ? ('pending' as const) : ('checking' as const),
      })),
    ]);

    if (checkable.length === 0) return newFiles;

    setIsChecking(true);

    // Compute hashes for all non-zip files, bounded to HASH_POOL_SIZE concurrent
    // reads so a large batch of files can't all be materialized into memory at
    // once (see HASH_POOL_SIZE comment above). Order is preserved regardless of
    // completion order.
    const withHashes = await runWithConcurrencyLimit(checkable, HASH_POOL_SIZE, async (uf) => {
      try {
        const hash = await computeSha256(uf.file);
        return { ...uf, hash };
      } catch (err) {
        // Surface the failure instead of silently uploading without a duplicate
        // check: the file still proceeds (status stays 'pending'), but the user
        // sees why it wasn't checked for duplicates.
        return {
          ...uf,
          hashError: `Duplicate check failed: ${err instanceof Error ? err.message : 'unknown error'}`,
        };
      }
    });

    // Check hashes against backend
    const hashes = withHashes.map((f) => f.hash).filter((h): h is string => !!h);
    let duplicateMap: Record<string, DuplicateCheckItem> = {};
    if (hashes.length > 0) {
      try {
        const resp = await api.checkFileDuplicates(hashes);
        duplicateMap = resp.duplicates;
      } catch {
        // If the check fails, proceed without duplicate detection
      }
    }

    // Build fully-annotated result in original file order
    const result: UploadFile[] = newFiles.map((orig) => {
      if (orig.isZip) return orig;
      const withHash = withHashes.find((a) => a.file === orig.file);
      if (!withHash) return orig;
      return {
        ...withHash,
        status: 'pending' as const,
        duplicateInfo: withHash.hash ? duplicateMap[withHash.hash] : undefined,
      };
    });

    setIsChecking(false);

    // Atomically replace 'checking' entries with fully-annotated ones
    setFiles((prev) => {
      const newFileSet = new Set(newFiles.map((f) => f.file));
      return [...prev.filter((f) => !newFileSet.has(f.file)), ...result];
    });

    return result;
  };

  const addFiles = (newFiles: File[]) => {
    setUploadError(null);
    if (validateFile) {
      for (const file of newFiles) {
        const error = validateFile(file);
        if (error) {
          setUploadError(error);
          return;
        }
      }
    }
    const toAdd: UploadFile[] = newFiles.map((file) => ({
      file,
      status: 'pending' as const,
      isZip: file.name.toLowerCase().endsWith('.zip'),
      is3mf: file.name.toLowerCase().endsWith('.3mf'),
    }));

    if (autoUpload && newFiles.length > 0) {
      checkDuplicates(toAdd).then((annotated) => uploadFiles(annotated));
    } else {
      checkDuplicates(toAdd);
    }
  };

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const toggleUploadAnyway = (file: File) => {
    setFiles((prev) =>
      prev.map((f) => (f.file === file ? { ...f, uploadAnyway: !f.uploadAnyway } : f)),
    );
  };

  // Seed once on mount when the parent passed initialFiles (page-wide drop).
  const seededInitialRef = useRef(false);
  useEffect(() => {
    if (seededInitialRef.current) return;
    if (!initialFiles || initialFiles.length === 0) return;
    seededInitialRef.current = true;
    addFiles(initialFiles);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasZipFiles = files.some((f) => f.isZip && f.status === 'pending');
  const hasStlFiles = files.some((f) => f.file.name.toLowerCase().endsWith('.stl') && f.status === 'pending');
  const has3mfFiles = files.some((f) => f.is3mf && f.status === 'pending');
  const pendingCount = files.filter((f) => f.status === 'pending').length;
  const duplicateCount = files.filter((f) => f.duplicateInfo && !f.uploadAnyway && f.status === 'pending').length;
  const uploadableCount = pendingCount - duplicateCount;
  const allDone = files.length > 0 && pendingCount === 0 && !isUploading && !isChecking;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 animate-overlay-in">
      <div className="bg-bambu-dark-secondary rounded-lg w-full max-w-lg border border-bambu-dark-tertiary animate-modal-in">
        <div className="p-4 border-b border-bambu-dark-tertiary flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">{t('fileManager.uploadFiles')}</h2>
          <button onClick={onClose} className="p-1 hover:bg-bambu-dark rounded">
            <X className="w-5 h-5 text-bambu-gray" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Drop Zone */}
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
              isDragging
                ? 'border-bambu-green bg-bambu-green/10'
                : 'border-bambu-dark-tertiary hover:border-bambu-green/50'
            }`}
          >
            <Upload className={`w-10 h-10 mx-auto mb-3 ${isDragging ? 'text-bambu-green' : 'text-bambu-gray'}`} />
            <p className="text-white font-medium">
              {isDragging ? t('fileManager.dropFilesHere') : t('fileManager.dragDropFiles')}
            </p>
            <p className="text-sm text-bambu-gray mt-1">{t('fileManager.orClickToBrowse')}</p>
            <p className="text-xs text-bambu-gray/70 mt-2">{t('fileManager.allFileTypesSupported')}</p>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={accept}
            className="hidden"
            onChange={handleFileSelect}
          />

          {/* ZIP Options */}
          {hasZipFiles && (
            <div className="p-3 bg-blue-50 dark:bg-blue-500/10 border border-blue-300 dark:border-blue-500/30 rounded-lg">
              <div className="flex items-start gap-3">
                <ArchiveIcon className="w-5 h-5 text-blue-600 dark:text-blue-400 mt-0.5 flex-shrink-0" />
                <div className="flex-1">
                  <p className="text-sm text-blue-700 dark:text-blue-300 font-medium">{t('fileManager.zipFilesDetected')}</p>
                  <p className="text-xs text-blue-700/80 dark:text-blue-300/70 mt-1">
                    {t('fileManager.zipExtractOptions')}
                  </p>
                  <label className="flex items-center gap-2 mt-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={preserveZipStructure}
                      onChange={(e) => setPreserveZipStructure(e.target.checked)}
                      className="w-4 h-4 rounded border-bambu-dark-tertiary bg-bambu-dark text-bambu-green focus:ring-bambu-green"
                    />
                    <span className="text-sm text-white">{t('fileManager.preserveZipStructure')}</span>
                  </label>
                  <label className="flex items-center gap-2 mt-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={createFolderFromZip}
                      onChange={(e) => setCreateFolderFromZip(e.target.checked)}
                      className="w-4 h-4 rounded border-bambu-dark-tertiary bg-bambu-dark text-bambu-green focus:ring-bambu-green"
                    />
                    <span className="text-sm text-white">{t('fileManager.createFolderFromZip')}</span>
                  </label>
                </div>
              </div>
            </div>
          )}

          {/* 3MF File Info */}
          {has3mfFiles && (
            <div className="p-3 bg-purple-50 dark:bg-purple-500/10 border border-purple-300 dark:border-purple-500/30 rounded-lg">
              <div className="flex items-start gap-3">
                <Printer className="w-5 h-5 text-purple-600 dark:text-purple-400 mt-0.5 flex-shrink-0" />
                <div className="flex-1">
                  <p className="text-sm text-purple-700 dark:text-purple-300 font-medium">{t('fileManager.threemfDetected')}</p>
                  <p className="text-xs text-purple-700/80 dark:text-purple-300/70 mt-1">
                    {t('fileManager.threemfExtractionInfo')}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* STL Thumbnail Options */}
          {(hasStlFiles || hasZipFiles) && (
            <div className="p-3 bg-bambu-green/10 border border-bambu-green/30 rounded-lg">
              <div className="flex items-start gap-3">
                <Image className="w-5 h-5 text-bambu-green mt-0.5 flex-shrink-0" />
                <div className="flex-1">
                  <p className="text-sm text-bambu-green font-medium">{t('fileManager.stlThumbnailGeneration')}</p>
                  <p className="text-xs text-bambu-green/70 mt-1">
                    {hasZipFiles && !hasStlFiles
                      ? t('fileManager.zipMayContainStl')
                      : t('fileManager.thumbnailsCanBeGenerated')}
                  </p>
                  <label className="flex items-center gap-2 mt-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={generateStlThumbnails}
                      onChange={(e) => setGenerateStlThumbnails(e.target.checked)}
                      className="w-4 h-4 rounded border-bambu-dark-tertiary bg-bambu-dark text-bambu-green focus:ring-bambu-green"
                    />
                    <span className="text-sm text-white">{t('fileManager.generateThumbnailsForStl')}</span>
                  </label>
                </div>
              </div>
            </div>
          )}

          {/* Duplicate summary banner */}
          {duplicateCount > 0 && (
            <div className="p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
              <div className="flex items-center gap-3">
                <AlertTriangle className="w-5 h-5 text-yellow-400 flex-shrink-0" />
                <p className="text-sm text-yellow-300">
                  {t('fileManager.duplicatesWillBeSkipped', '{{count}} duplicate file(s) detected — will be skipped', { count: duplicateCount })}
                </p>
              </div>
            </div>
          )}

          {/* File List */}
          {files.length > 0 && (
            <div className="max-h-48 overflow-y-auto space-y-2">
              {files.map((uploadFile, index) => (
                <div
                  key={index}
                  className="flex items-center gap-3 p-2 bg-bambu-dark rounded-lg"
                >
                  {uploadFile.isZip ? (
                    <ArchiveIcon className="w-4 h-4 text-blue-600 dark:text-blue-400 flex-shrink-0" />
                  ) : (
                    <File className={`w-4 h-4 flex-shrink-0 ${uploadFile.duplicateInfo && !uploadFile.uploadAnyway ? 'text-yellow-400' : 'text-bambu-gray'}`} />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white truncate">{uploadFile.file.name}</p>
                    <p className="text-xs text-bambu-gray">
                      {(uploadFile.file.size / 1024 / 1024).toFixed(2)} MB
                      {uploadFile.isZip && uploadFile.status === 'pending' && (
                        <span className="text-blue-700 dark:text-blue-400 ml-2">• {t('fileManager.willBeExtracted')}</span>
                      )}
                      {uploadFile.extractedCount !== undefined && (
                        <span className="text-green-700 dark:text-green-400 ml-2">• {t('fileManager.filesExtracted', { count: uploadFile.extractedCount })}</span>
                      )}
                    </p>
                    {/* Duplicate warning */}
                    {uploadFile.duplicateInfo && uploadFile.status === 'pending' && (
                      <p className="text-xs text-yellow-400 mt-0.5">
                        {t('fileManager.alreadyInLibrary', 'Already in library')}
                        {uploadFile.duplicateInfo.folder_name
                          ? ` ${t('fileManager.duplicateIn', 'in {{folder}}', { folder: uploadFile.duplicateInfo.folder_name })}`
                          : null}
                        {!uploadFile.uploadAnyway && (
                          <button
                            onClick={() => toggleUploadAnyway(uploadFile.file)}
                            className="ml-2 underline hover:text-yellow-300"
                          >
                            {t('fileManager.uploadAnyway', 'Upload anyway')}
                          </button>
                        )}
                        {uploadFile.uploadAnyway && (
                          <button
                            onClick={() => toggleUploadAnyway(uploadFile.file)}
                            className="ml-2 underline hover:text-yellow-300"
                          >
                            {t('fileManager.skipDuplicate', 'Skip')}
                          </button>
                        )}
                      </p>
                    )}
                    {/* Duplicate-check hashing failure (file still proceeds to upload) */}
                    {uploadFile.hashError && uploadFile.status === 'pending' && (
                      <p className="text-xs text-yellow-400 mt-0.5" title={uploadFile.hashError}>
                        {uploadFile.hashError}
                      </p>
                    )}
                    {/* Upload errors */}
                    {uploadFile.status === 'error' && uploadFile.error && (
                      <p className="text-xs text-red-700 dark:text-red-400 mt-1 break-words">{uploadFile.error}</p>
                    )}
                    {uploadFile.status === 'skipped' && (
                      <p className="text-xs text-bambu-gray mt-0.5">
                        {t('fileManager.skippedDuplicate', 'Skipped (already in library)')}
                      </p>
                    )}
                  </div>
                  {uploadFile.status === 'pending' && (
                    <button
                      onClick={() => removeFile(index)}
                      className="p-1 hover:bg-bambu-dark-tertiary rounded"
                    >
                      <X className="w-4 h-4 text-bambu-gray" />
                    </button>
                  )}
                  {uploadFile.status === 'checking' && (
                    <Loader2 className="w-4 h-4 text-bambu-gray animate-spin" />
                  )}
                  {uploadFile.status === 'uploading' && (
                    <Loader2 className="w-4 h-4 text-bambu-green animate-spin" />
                  )}
                  {uploadFile.status === 'success' && (
                    <CheckCircle className="w-4 h-4 text-green-500" />
                  )}
                  {uploadFile.status === 'skipped' && (
                    <AlertTriangle className="w-4 h-4 text-yellow-500" />
                  )}
                  {uploadFile.status === 'error' && (
                    <span title={uploadFile.error}>
                      <XCircle className="w-4 h-4 text-red-500" />
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Compatibility Error */}
          {uploadError && (
            <div className="p-3 bg-red-50 dark:bg-red-500/10 border border-red-300 dark:border-red-500/30 rounded-lg">
              <div className="flex items-start gap-3">
                <XCircle className="w-5 h-5 text-red-600 dark:text-red-400 mt-0.5 flex-shrink-0" />
                <p className="text-sm text-red-700 dark:text-red-300">{uploadError}</p>
              </div>
            </div>
          )}
        </div>

        <div className="p-4 border-t border-bambu-dark-tertiary flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          {!allDone && (
            <Button
              onClick={() => uploadFiles(files)}
              disabled={pendingCount === 0 || isUploading || isChecking}
            >
              {isChecking ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  {t('fileManager.checkingDuplicates', 'Checking...')}
                </>
              ) : isUploading ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  {t('fileManager.uploading')}
                </>
              ) : (
                <>
                  <Upload className="w-4 h-4 mr-2" />
                  {t('common.upload')} {uploadableCount > 0 ? `(${uploadableCount})` : pendingCount > 0 ? `(${pendingCount})` : ''}
                </>
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
