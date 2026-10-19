import { ProjectHeader } from '../components/projects/ProjectHeader';
import { ProjectFilesPanel } from '../components/projects/files/ProjectFilesPanel';
import { ProjectOrdersCard } from '../components/projects/aito/ProjectOrdersCard';
import { useState, useMemo } from 'react';
import DOMPurify from 'dompurify';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  Edit3,
  Loader2,
  Package,
  CheckCircle,
  XCircle,
  Printer,
  ChevronRight,
  FileText,
  Calendar,
  AlertTriangle,
  Save,
  X,
  FolderTree,
  Copy,
  FolderOpen,
  FolderKanban,
  Download,
  FileBox,
  Info,
} from 'lucide-react';
import { api } from '../api/client';
import { projectKeys } from '../components/projects/projectQueries';
import { parseUTCDate, formatDateOnly, type TimeFormat } from '../utils/date';
import type { Archive, ProjectUpdate, LibraryFileListItem } from '../api/client';
import { Button } from '../components/Button';
import { useToast } from '../contexts/ToastContext';
import { useAuth } from '../contexts/AuthContext';
import { RichTextEditor } from '../components/RichTextEditor';
import { PrintModal } from '../components/PrintModal';

// Project edit modal (reused from ProjectsPage)
import { ProjectModal } from './ProjectsPage';
import { getCurrencySymbol } from '../utils/currency';
import { isSlicedLibraryFile } from '../utils/libraryFiles';
import { useUiSettings } from '../hooks/useUiSettings';
import { ProjectPanel } from '../components/projects/detail/ProjectPanel';
import { ProjectKpiStrip } from '../components/projects/detail/ProjectKpiStrip';
import { ProjectActivityRail } from '../components/projects/detail/ProjectActivityRail';
import { formatFilament } from '../components/projects/detail/format';

type TFunction = (key: string, options?: Record<string, unknown>) => string;

function StatusBadge({ status, t }: { status: string; t: TFunction }) {
  const colors = {
    active: 'bg-bambu-green/20 text-bambu-green',
    completed: 'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-400',
    archived: 'bg-bambu-gray/20 text-bambu-gray',
  };
  const color = colors[status as keyof typeof colors] || colors.active;

  const labels: Record<string, string> = {
    active: t('projectDetail.status.active'),
    completed: t('projectDetail.status.completed'),
    archived: t('projectDetail.status.archived'),
  };

  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${color}`}>
      {labels[status] || status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

// Fenrir: which revision (and order) a print came from — tile caption and tooltip.
function revisionCaption(archive: Archive, t: TFunction): string {
  return [archive.revision_label, archive.order_id != null ? t('projectsPdm.aito.orderLabel', { id: archive.order_id }) : null]
    .filter(Boolean)
    .join(' · ');
}

function ArchiveGrid({ archives, t }: { archives: Archive[]; t: TFunction }) {
  if (archives.length === 0) {
    return (
      <div className="text-center py-8 text-bambu-gray">
        <Package className="w-12 h-12 mx-auto mb-2 opacity-50" />
        <p>{t('projectDetail.noPrints')}</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 2xl:grid-cols-7 gap-3">
      {archives.map((archive) => (
        <Link
          key={archive.id}
          to={`/archives?search=${encodeURIComponent(archive.print_name || '')}`}
          title={archive.revision_label ? `${archive.print_name || 'Unknown'} · ${revisionCaption(archive, t)}` : undefined}
          className="group relative aspect-square rounded-lg bg-bambu-dark border border-bambu-dark-tertiary overflow-hidden hover:border-bambu-green transition-colors"
        >
          {archive.thumbnail_path ? (
            <img
              src={api.getArchiveThumbnail(archive.id)}
              alt={archive.print_name || 'Print'}
              className="w-full h-full object-cover brightness-125 contrast-110"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-bambu-gray">
              <Package className="w-8 h-8" />
            </div>
          )}

          {/* Status overlay */}
          {archive.status === 'failed' && (
            <div className="absolute inset-0 bg-red-500/30 flex items-center justify-center">
              <XCircle className="w-8 h-8 text-white" />
            </div>
          )}
          {archive.status === 'completed' && (
            <div className="absolute top-1 right-1">
              <CheckCircle className="w-4 h-4 text-bambu-green" />
            </div>
          )}

          {/* Name overlay on hover */}
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2 opacity-0 group-hover:opacity-100 transition-opacity">
            <p className="text-xs text-white truncate">{archive.print_name || 'Unknown'}</p>
            {archive.revision_label && (
              <p data-testid={`archive-revision-${archive.id}`} className="text-[10px] text-white/80 truncate">
                {revisionCaption(archive, t)}
              </p>
            )}
          </div>
        </Link>
      ))}
    </div>
  );
}

function PriorityBadge({ priority, t }: { priority: string; t: TFunction }) {
  const config = {
    low: { color: 'bg-gray-500/20 text-gray-400', label: t('projectDetail.priority.low') },
    normal: { color: 'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-400', label: t('projectDetail.priority.normal') },
    high: { color: 'bg-orange-100 dark:bg-orange-500/20 text-orange-700 dark:text-orange-400', label: t('projectDetail.priority.high') },
    urgent: { color: 'bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-400', label: t('projectDetail.priority.urgent') },
  };
  const { color, label } = config[priority as keyof typeof config] || config.normal;

  return (
    <span
      title={`${t('projectDetail.priorityLabel')} ${label}`}
      className={`px-2 py-0.5 rounded-full text-xs font-medium flex items-center gap-1 ${color}`}
    >
      {priority === 'urgent' && <AlertTriangle className="w-3 h-3" />}
      {label}
    </span>
  );
}

function getDueDateStatus(dateString: string | null, t: TFunction): { color: string; label: string } | null {
  if (!dateString) return null;
  const dueDate = parseUTCDate(dateString);
  if (!dueDate) return null;
  const now = new Date();
  const diffDays = Math.ceil((dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays < 0) return { color: 'text-red-700 dark:text-red-400', label: t('projectDetail.dueDate.overdue') };
  if (diffDays === 0) return { color: 'text-orange-700 dark:text-orange-400', label: t('projectDetail.dueDate.today') };
  if (diffDays <= 3) return { color: 'text-yellow-700 dark:text-yellow-400', label: t('projectDetail.dueDate.daysLeft', { count: diffDays }) };
  return { color: 'text-bambu-gray', label: t('projectDetail.dueDate.daysLeft', { count: diffDays }) };
}

export function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();
  const [showEditModal, setShowEditModal] = useState(false);
  const [headerEditing, setHeaderEditing] = useState(false);
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesContent, setNotesContent] = useState('');
  const [printFile, setPrintFile] = useState<LibraryFileListItem | null>(null);

  const projectId = parseInt(id || '0', 10);

  const { data: project, isLoading: projectLoading, error: projectError } = useQuery({
    queryKey: projectKeys.project(projectId),
    queryFn: () => api.getProject(projectId),
    enabled: projectId > 0,
  });

  const { data: archives, isLoading: archivesLoading } = useQuery({
    queryKey: ['project-archives', projectId],
    queryFn: () => api.getProjectArchives(projectId),
    enabled: projectId > 0,
  });

  const { data: timeline, isLoading: timelineLoading } = useQuery({
    queryKey: ['project-timeline', projectId],
    queryFn: () => api.getProjectTimeline(projectId, 20),
    enabled: projectId > 0,
  });

  const { data: settings } = useUiSettings();

  const { data: linkedFolders } = useQuery({
    queryKey: ['project-folders', projectId],
    queryFn: () => api.getLibraryFoldersByProject(projectId),
    enabled: projectId > 0,
  });

  // Single bulk query — replaces the previous N+1 useQueries pattern
  const { data: allProjectFiles, isLoading: projectFilesLoading } = useQuery({
    queryKey: ['project-files', projectId],
    queryFn: () => api.getAllLibraryFiles(null, false, projectId),
    enabled: projectId > 0,
  });

  // Group files by folder_id for the section-based render
  const filesByFolder = useMemo(() => {
    const map = new Map<number, LibraryFileListItem[]>();
    for (const file of allProjectFiles ?? []) {
      if (file.folder_id != null) {
        const arr = map.get(file.folder_id) ?? [];
        arr.push(file);
        map.set(file.folder_id, arr);
      }
    }
    return map;
  }, [allProjectFiles]);

  // Per-file completed-run counts (#1897); a file absent from the response has 0
  const { data: fileProgress } = useQuery({
    queryKey: ['project-file-progress', projectId],
    queryFn: () => api.getProjectFileProgress(projectId),
    enabled: projectId > 0,
  });

  const progressByFileId = useMemo(() => {
    const map = new Map<number, number>();
    for (const row of fileProgress ?? []) map.set(row.file_id, row.completed_count);
    return map;
  }, [fileProgress]);

  // Complete sets (#1897): the number of finished assemblies — the minimum
  // completed count across the project's printable files, capped at the target.
  const completeSets = useMemo(() => {
    const target = project?.target_sets;
    if (!target || !allProjectFiles) return null;
    const printable = allProjectFiles.filter((f) => isSlicedLibraryFile(f));
    if (printable.length === 0) return null;
    return Math.min(...printable.map((f) => Math.min(progressByFileId.get(f.id) ?? 0, target)));
  }, [project?.target_sets, allProjectFiles, progressByFileId]);

  const currency = getCurrencySymbol(settings?.currency || 'USD');
  const timeFormat: TimeFormat = settings?.time_format || 'system';

  const updateMutation = useMutation({
    mutationFn: (data: ProjectUpdate) => api.updateProject(projectId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectKeys.project(projectId) });
      queryClient.invalidateQueries({ queryKey: projectKeys.projects() });
      setShowEditModal(false);
      setEditingNotes(false);
      showToast(t('projectDetail.toast.projectUpdated'), 'success');
    },
    onError: (error: Error) => {
      showToast(error.message, 'error');
    },
  });

  const handleStartEditNotes = () => {
    setNotesContent(project?.notes || '');
    setEditingNotes(true);
  };

  const handleSaveNotes = () => {
    updateMutation.mutate({ notes: notesContent });
  };

  const handleCancelNotes = () => {
    setEditingNotes(false);
    setNotesContent('');
  };

  const handleExportProject = async () => {
    try {
      const { blob, filename } = await api.exportProjectZip(Number(projectId));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || `${project?.name || 'project'}_${new Date().toISOString().split('T')[0]}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      showToast(t('projectDetail.toast.projectExported'), 'success');
    } catch (error) {
      showToast((error as Error).message, 'error');
    }
  };

  // Template handlers
  const createTemplateMutation = useMutation({
    mutationFn: () => api.createTemplateFromProject(projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectKeys.projects() });
      showToast(t('projectDetail.toast.templateCreated'), 'success');
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  if (projectLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="w-8 h-8 animate-spin text-bambu-green" />
      </div>
    );
  }

  if (projectError || !project) {
    return (
      <div className="text-center py-24">
        <p className="text-bambu-gray">
          {projectError ? `${t('common.error')}: ${(projectError as Error).message}` : t('projectDetail.notFound')}
        </p>
        <Button variant="secondary" className="mt-4" onClick={() => navigate('/projects')}>
          {t('projectDetail.backToProjects')}
        </Button>
      </div>
    );
  }

  const stats = project.stats;
  const children = project.children ?? [];
  const folders = linkedFolders ?? [];
  const dueStatus = getDueDateStatus(project.due_date, t);
  const canUpdate = hasPermission('projects:update');

  const notesAction = !editingNotes ? (
    <Button
      variant="secondary"
      size="sm"
      onClick={handleStartEditNotes}
      disabled={!canUpdate}
      title={!canUpdate ? t('projectDetail.notes.noEditPermission') : undefined}
    >
      <Edit3 className="w-4 h-4 mr-1" />
      {t('common.edit')}
    </Button>
  ) : (
    <>
      <Button variant="secondary" size="sm" onClick={handleCancelNotes} disabled={updateMutation.isPending}>
        <X className="w-4 h-4 mr-1" />
        {t('common.cancel')}
      </Button>
      <Button size="sm" onClick={handleSaveNotes} disabled={updateMutation.isPending}>
        {updateMutation.isPending ? (
          <Loader2 className="w-4 h-4 animate-spin mr-1" />
        ) : (
          <Save className="w-4 h-4 mr-1" />
        )}
        {t('common.save')}
      </Button>
    </>
  );

  return (
    <div className="p-4 md:p-8 space-y-5">
      {/* Breadcrumb, with the way back */}
      <div className="flex items-center gap-2 text-sm text-bambu-gray min-w-0">
        <button
          onClick={() => navigate('/projects')}
          aria-label={t('projectDetail.backToProjects')}
          title={t('projectDetail.backToProjects')}
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg hover:bg-bambu-dark-tertiary transition-colors md:min-h-9 md:min-w-9"
        >
          <ArrowLeft className="w-5 h-5 text-bambu-gray" />
        </button>
        <Link to="/projects" className="hover:text-white transition-colors">
          {t('nav.projects')}
        </Link>
        <ChevronRight className="w-4 h-4 shrink-0" />
        <span className="text-white truncate">{project.name}</span>
      </div>

      {/* Header card: cover, title (edited in place), badges, meta, actions, KPIs */}
      <header
        data-testid="project-header"
        className="rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary card-shadow p-4 md:p-5 animate-rise-lg vt-page-title"
      >
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-bambu-dark-tertiary bg-bambu-dark">
            {project.cover_image_filename ? (
              <img
                src={api.getProjectCoverImageUrl(project.id, project.updated_at)}
                alt={t('projects.coverImageAlt')}
                className="h-full w-full object-cover"
              />
            ) : (
              <FolderKanban
                data-testid="project-cover-placeholder"
                className="h-7 w-7"
                style={{ color: project.color || '#6b7280' }}
                aria-hidden="true"
              />
            )}
          </div>
          <div className={`min-w-0 ${headerEditing ? 'order-last basis-full' : 'flex-1 basis-56'}`}>
            <ProjectHeader
              key={project.id}
              project={project}
              onEditingChange={setHeaderEditing}
              badges={
                <>
                  <StatusBadge status={project.status} t={t} />
                  {project.priority && project.priority !== 'normal' && (
                    <PriorityBadge priority={project.priority} t={t} />
                  )}
                </>
              }
              meta={
                project.due_date ? (
                  <span className="flex items-center gap-1" data-testid="project-due">
                    <Calendar className="w-3.5 h-3.5" aria-hidden="true" />
                    <span className="text-white">
                      {formatDateOnly(project.due_date, { year: 'numeric', month: 'short', day: 'numeric' })}
                    </span>
                    {dueStatus && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className={dueStatus.color}>{dueStatus.label}</span>
                      </>
                    )}
                  </span>
                ) : undefined
              }
            />
          </div>
          <div className="flex w-full gap-2 sm:ml-auto sm:w-auto">
            <Button
              variant="secondary"
              className="flex-1 sm:flex-none"
              onClick={handleExportProject}
              disabled={!hasPermission('projects:read')}
              title={!hasPermission('projects:read') ? t('projectDetail.noExportPermission') : t('projectDetail.exportProject')}
            >
              <Download className="w-4 h-4 mr-2" />
              {t('projectDetail.export')}
            </Button>
            <Button
              className="flex-1 sm:flex-none"
              onClick={() => setShowEditModal(true)}
              disabled={!canUpdate}
              title={!canUpdate ? t('projectDetail.noEditPermission') : undefined}
            >
              <Edit3 className="w-4 h-4 mr-2" />
              {t('common.edit')}
            </Button>
          </div>
        </div>
        <ProjectKpiStrip project={project} completeSets={completeSets} currency={currency} />
      </header>

      {/* Workspace + side rail: two columns on xl, the rail after the main column below */}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-5" data-testid="project-main">
          <ProjectFilesPanel projectId={projectId} />

          <ProjectOrdersCard projectId={projectId} />

          <ProjectPanel icon={Package} title={t('projectDetail.prints.title', { count: archives?.length || 0 })}>
            {archivesLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-bambu-green" />
              </div>
            ) : (
              <ArchiveGrid archives={archives || []} t={t} />
            )}
          </ProjectPanel>

          <ProjectPanel icon={FileText} title={t('projectDetail.notes.title')} action={notesAction} testId="project-notes">
            {editingNotes ? (
              <RichTextEditor
                content={notesContent}
                onChange={setNotesContent}
                placeholder={t('projectDetail.notes.placeholder')}
              />
            ) : project.notes ? (
              <div
                className="prose prose-invert prose-sm max-w-none"
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(project.notes) }}
              />
            ) : (
              <p className="text-bambu-gray/70 text-sm italic">{t('projectDetail.notes.empty')}</p>
            )}
          </ProjectPanel>

          {children.length > 0 && (
            <ProjectPanel icon={FolderTree} title={t('projectDetail.subProjects.title', { count: children.length })}>
              <div className="space-y-2">
                {children.map((child) => (
                  <Link
                    key={child.id}
                    to={`/projects/${child.id}`}
                    className="flex items-center justify-between gap-4 p-3 bg-bambu-dark rounded-lg hover:bg-bambu-dark-tertiary transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className="w-3 h-3 rounded-full flex-shrink-0"
                        style={{ backgroundColor: child.color || '#6b7280' }}
                      />
                      <span className="text-white truncate">{child.name}</span>
                      <span className={`text-xs px-2 py-0.5 rounded flex-shrink-0 ${
                        child.status === 'completed' ? 'bg-status-ok/20 text-status-ok' :
                        child.status === 'archived' ? 'bg-bambu-gray/20 text-bambu-gray' :
                        'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-400'
                      }`}>
                        {child.status}
                      </span>
                      {/* A branch of its own, so its figures cover more than the
                          one project named on this row (#1264). */}
                      {child.descendant_count > 0 && (
                        <span className="text-xs text-bambu-gray flex-shrink-0 inline-flex items-center gap-1">
                          <FolderTree className="w-3 h-3" />
                          {child.descendant_count}
                        </span>
                      )}
                    </div>
                    {/* Each row carries its own branch's roll-up, so the rows add
                        up to the header's roll-up line minus this project's own prints. */}
                    <div className="flex items-center gap-4 text-sm text-bambu-gray flex-shrink-0">
                      {child.total_archives > 0 && (
                        <span className="hidden sm:inline">
                          {t('projectDetail.subProjects.jobs', { count: child.total_archives })}
                        </span>
                      )}
                      {child.total_filament_grams > 0 && (
                        <span className="hidden md:inline">{formatFilament(child.total_filament_grams)}</span>
                      )}
                      {child.total_cost > 0 && (
                        <span className="hidden md:inline">{currency}{child.total_cost.toFixed(2)}</span>
                      )}
                      {child.progress_percent !== null && (
                        <span>{child.progress_percent.toFixed(0)}%</span>
                      )}
                    </div>
                  </Link>
                ))}
              </div>
            </ProjectPanel>
          )}

          {/* Linked File Manager folders with their printable files */}
          {folders.length > 0 && (
            <ProjectPanel
              icon={FolderOpen}
              title={t('projectDetail.details.linkedFolders')}
              count={folders.length}
              testId="project-linked-folders"
            >
              <p className="text-xs text-bambu-gray mb-3">
                <Link to="/files" className="text-bambu-green hover:underline">
                  {t('projectDetail.files.linkFolders')}
                </Link>
                {' '}{t('projectDetail.files.forQuickAccess')}
              </p>
              <div className="space-y-4">
                {folders.map((folder) => {
                  const files = filesByFolder.get(folder.id) ?? [];
                  return (
                    <div key={folder.id}>
                      {/* Folder header — links to File Manager */}
                      <Link
                        to={`/files?folder=${folder.id}`}
                        className="flex items-center justify-between p-3 bg-bambu-dark rounded-lg hover:bg-bambu-dark-tertiary transition-colors mb-2"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <FolderOpen className="w-5 h-5 text-bambu-green shrink-0" />
                          <div className="min-w-0">
                            <p className="text-sm text-white truncate">{folder.name}</p>
                            <p className="text-xs text-bambu-gray">
                              {t('projectDetail.files.fileCount', { count: folder.file_count })}
                            </p>
                          </div>
                        </div>
                        <ChevronRight className="w-4 h-4 text-bambu-gray shrink-0" />
                      </Link>

                      {/* File list within the folder */}
                      {projectFilesLoading ? (
                        <div className="flex items-center gap-2 px-3 py-2 text-bambu-gray text-sm">
                          <Loader2 className="w-4 h-4 animate-spin" />
                        </div>
                      ) : files.length === 0 ? (
                        <p className="text-bambu-gray/60 text-xs italic px-3">
                          {t('projectDetail.files.noFiles')}
                        </p>
                      ) : (
                        <div className="space-y-1 pl-3">
                          {files.map((file) => {
                            const printable = isSlicedLibraryFile(file);
                            return (
                              <div
                                key={file.id}
                                className="flex items-center gap-3 p-2 rounded-lg hover:bg-bambu-dark-tertiary transition-colors"
                              >
                                {/* Thumbnail */}
                                <div className="w-10 h-10 shrink-0 rounded bg-bambu-dark overflow-hidden flex items-center justify-center">
                                  {file.thumbnail_path ? (
                                    <img
                                      src={api.getLibraryFileThumbnailUrl(file.id)}
                                      alt={file.print_name || file.filename}
                                      className="w-full h-full object-cover brightness-125 contrast-110"
                                    />
                                  ) : (
                                    <FileBox className="w-5 h-5 text-bambu-gray/40" />
                                  )}
                                </div>

                                {/* Name + type badge */}
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm text-white truncate" title={file.print_name || file.filename}>
                                    {file.print_name || file.filename}
                                  </p>
                                  <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                                    file.file_type === '3mf' ? 'bg-bambu-green/20 text-bambu-green'
                                    : (file.file_type === 'gcode' || file.file_type === 'gcode.3mf') ? 'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-400'
                                    : 'bg-bambu-gray/20 text-bambu-gray'
                                  }`}>
                                    {file.file_type.toUpperCase()}
                                  </span>
                                </div>

                                {/* Per-file print progress (#1897) */}
                                {printable && (() => {
                                  const done = progressByFileId.get(file.id) ?? 0;
                                  const target = project.target_sets;
                                  if (!target) {
                                    // No copies-per-file target — show a plain printed-count badge
                                    return done > 0 ? (
                                      <span
                                        className="shrink-0 text-xs px-1.5 py-0.5 rounded-full bg-bambu-dark text-bambu-gray"
                                        title={t('projectDetail.files.printedCount', { count: done })}
                                      >
                                        {done}×
                                      </span>
                                    ) : null;
                                  }
                                  const pct = Math.min((done / target) * 100, 100);
                                  const textColor =
                                    done >= target ? 'text-status-ok' : done > 0 ? 'text-status-warning' : 'text-bambu-gray';
                                  const barColor =
                                    done >= target ? 'bg-status-ok' : done > 0 ? 'bg-status-warning' : 'bg-bambu-gray';
                                  return (
                                    <div
                                      className="shrink-0 w-20"
                                      title={t('projectDetail.files.progressTooltip', { done, target })}
                                    >
                                      <p className={`text-xs font-medium text-right ${textColor}`}>
                                        {done} / {target}
                                      </p>
                                      <div className="h-1 bg-bambu-dark rounded-full overflow-hidden mt-1">
                                        <div className={`h-full ${barColor}`} style={{ width: `${pct}%` }} />
                                      </div>
                                    </div>
                                  );
                                })()}

                                {/* Print actions for sliced files */}
                                {printable && (
                                  <div className="flex items-center gap-1 shrink-0">
                                    <button
                                      onClick={() => setPrintFile(file)}
                                      title={t('common.print')}
                                      className="flex min-h-[44px] min-w-[44px] items-center justify-center p-1.5 rounded hover:bg-bambu-green/20 text-bambu-green transition-colors md:min-h-0 md:min-w-0"
                                    >
                                      <Printer className="w-4 h-4" />
                                    </button>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </ProjectPanel>
          )}
        </div>

        <aside className="min-w-0 space-y-5" data-testid="project-rail">
          <ProjectActivityRail events={timeline} isLoading={timelineLoading} timeFormat={timeFormat} />

          <ProjectPanel icon={Info} title={t('projectDetail.details.title')} testId="project-details">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
              <dt className="text-bambu-gray">{t('projectDetail.queue.title')}</dt>
              <dd className="min-w-0 space-y-0.5">
                {stats && (stats.in_progress_prints > 0 || stats.queued_prints > 0) ? (
                  <p className="flex flex-wrap gap-x-2">
                    {stats.in_progress_prints > 0 && (
                      <span className="text-yellow-700 dark:text-yellow-400">
                        {t('projectDetail.queue.printing', { count: stats.in_progress_prints })}
                      </span>
                    )}
                    {stats.queued_prints > 0 && (
                      <span className="text-bambu-gray-light">
                        {t('projectDetail.queue.queued', { count: stats.queued_prints })}
                      </span>
                    )}
                  </p>
                ) : (
                  <p className="text-bambu-gray">{t('projectDetail.details.queueEmpty')}</p>
                )}
                <Link to={`/queue?project=${projectId}`} className="inline-block text-bambu-green hover:underline">
                  {t('projectDetail.queue.viewAll')}
                </Link>
              </dd>

              <dt className="text-bambu-gray">{t('projectDetail.details.linkedFolders')}</dt>
              <dd className="min-w-0">
                {folders.length > 0 ? (
                  <ul className="space-y-0.5">
                    {folders.map((folder) => (
                      <li key={folder.id} className="truncate">
                        <Link to={`/files?folder=${folder.id}`} className="text-bambu-gray-light hover:text-white">
                          {folder.name}
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Link to="/files" title={t('projectDetail.files.empty')} className="text-bambu-green hover:underline">
                    {t('projectDetail.files.linkFolders')}
                  </Link>
                )}
              </dd>

              {project.parent_id != null && (
                <>
                  <dt className="text-bambu-gray">{t('projectDetail.partOf')}</dt>
                  <dd className="min-w-0 truncate">
                    <Link to={`/projects/${project.parent_id}`} className="text-bambu-gray-light hover:text-white">
                      {project.parent_name || `#${project.parent_id}`}
                    </Link>
                  </dd>
                </>
              )}

              <dt className="text-bambu-gray">{t('projectDetail.details.subProjects')}</dt>
              <dd className="text-bambu-gray-light" data-testid="details-subprojects">
                {children.length > 0
                  ? (project.descendant_count ?? 0) > children.length
                    ? `${children.length} (${project.descendant_count})`
                    : children.length
                  : '—'}
              </dd>

              <dt className="text-bambu-gray">{t('projectDetail.details.created')}</dt>
              <dd className="text-bambu-gray-light">{formatDateOnly(project.created_at)}</dd>
            </dl>

            {/* Template action */}
            {!project.is_template && (
              <Button
                variant="secondary"
                size="sm"
                className="mt-4 w-full"
                onClick={() => createTemplateMutation.mutate()}
                disabled={createTemplateMutation.isPending || !hasPermission('projects:create')}
                title={!hasPermission('projects:create') ? t('projectDetail.template.noCreatePermission') : undefined}
              >
                {createTemplateMutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                ) : (
                  <Copy className="w-4 h-4 mr-2" />
                )}
                {t('projectDetail.template.saveAsTemplate')}
              </Button>
            )}
          </ProjectPanel>
        </aside>
      </div>

      {/* Edit Modal */}
      {showEditModal && (
        <ProjectModal
          pdm
          t={t}
          currencySymbol={currency}
          project={{
            ...project,
            archive_count: stats?.total_archives || 0,
            total_items: stats?.total_items || 0,
            completed_count: stats?.completed_prints || 0,
            failed_count: stats?.failed_prints || 0,
            queue_count: stats?.queued_prints || 0,
            progress_percent: stats?.progress_percent || null,
            // Required by ProjectListItem, but nothing in the dialog reads it —
            // the parent picker works off the project list it fetches itself.
            // Guarded like every other read of `children` on this page (#1264).
            child_count: project.children?.length ?? 0,
            archives: [],
          }}
          onClose={() => setShowEditModal(false)}
          onSave={(data) => updateMutation.mutate(data as ProjectUpdate)}
          isLoading={updateMutation.isPending}
        />
      )}

      {/* Print from project */}
      {printFile && (
        <PrintModal
          mode="create"
          libraryFileId={printFile.id}
          archiveName={printFile.print_name || printFile.filename}
          projectId={projectId}
          onClose={() => setPrintFile(null)}
          onSuccess={() => {
            setPrintFile(null);
            queryClient.invalidateQueries({ queryKey: ['archives'] });
            queryClient.invalidateQueries({ queryKey: ['queue'] });
          }}
        />
      )}
    </div>
  );
}
