import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Box, Camera, ChevronDown, ChevronLeft, ChevronRight, Cog, Cuboid, Download, Expand, ExternalLink, Eye, GitCompare, Grid3x3, House, Keyboard, Link2, MapPin, Monitor, Move3d,
  PanelRight, Presentation, Printer, Rotate3d, Route, Ruler, Scan, ScissorsLineDashed, X,
} from 'lucide-react';
import { api } from '../../api/client';
import type { ProjectRevisionOut } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { useCalcConfig } from '../../hooks/useCalcConfig';
import { usePreviewFullscreen } from '../../hooks/usePreviewFullscreen';
import { useUiSettings } from '../../hooks/useUiSettings';
import { ToolpathType } from '../../lib/gcodeToolpath';
import { TYPE_COLOR } from '../../lib/vendor/toolpathRenderer.js';
import type { ArchivePlatesResponse, LibraryFilePlatesResponse, PlateMetadata } from '../../types/plates';
import { estimateArchiveSalePrice } from '../../utils/archivePricing';
import { isApiSliceableFileType, isSliceableFileType, openInSlicer, resolveDesktopSlicer } from '../../utils/slicer';
import type { SlicerType } from '../../utils/slicer';
import { ContextMenu } from '../ContextMenu';
import type { ContextMenuItem } from '../ContextMenu';
import { PreviewModalShell } from '../PreviewModalShell';
import { Tooltip } from '../Tooltip';
import { focusRingCls } from '../formStyles';
import { chipBase, isSourceFilename, printProfileLine, STATUS_CHIP_CLS, STATUS_LABEL_KEYS } from '../projects/files/filesUi';
import { LayerRange } from './LayerRange';
import { PartScene, type ViewerStatus } from './PartScene';
import type { AnalysisResult, AnalysisState, PartBounds, PartObject, PartSceneHandle, Pin, SectionState, ToolpathStats } from './PartScene';
import { ViewCube } from './ViewCube';
import { ViewerRail } from './ViewerRail';
import type { RailPrint } from './ViewerRail';
import { nozzleLabel, sourcesFor } from './partSources';
import type { FileEntry, PartSubject } from './partSources';
import { buildVolumeFor } from './printerBeds';
import { runChecks } from './viewerChecks';
import { BACKGROUNDS, FINISHES, REFLECTIONS, encodeViewerState, readDisplayPrefs, writeDisplayPrefs } from './viewerLink';
import type { RenderPrefs, SceneView, ViewerLinkState, VisualStyle } from './viewerLink';

export interface PartViewerModalProps {
  subject: PartSubject;
  title: string;
  onClose: () => void;
  /** Projects: the revision's Print flow. */
  onPrint?: () => void;
  /** Projects: hands the source file to the desktop slicer (the files panel's own rule). */
  onOpenInSlicer?: () => void;
  /** Projects: downloads one of the revision's files with the panel's own download. */
  onDownload?: (file: FileEntry) => void;
  /** File manager: in-app slicing when the slicer API is on. */
  onSliceWithFenrir?: () => void;
  /** File manager: the first framed render of a STEP file, for its thumbnail (#2976). */
  onSnapshot?: (blob: Blob) => void;
  /** Printed count, for the Files card. */
  printed?: number;
  /** Which tab to open on, when the file has it (a copied link). */
  initialTab?: 'model' | 'toolpath';
  /** Everything else a copied link carries: camera, layers, hidden features, display settings. */
  initialState?: ViewerLinkState | null;
}

type Tab = 'model' | 'toolpath';
type Tool = 'none' | 'measure' | 'pin';

const BED_CHOICES = ['Bambu Lab H2S', 'Bambu Lab H2D', 'Bambu Lab H2C', 'Bambu Lab X1C', 'Bambu Lab P1S', 'Bambu Lab A1', 'Bambu Lab A1 mini'];
const LEGEND: Array<{ type: number; key: string }> = [
  { type: ToolpathType.outerWall, key: 'outerWall' },
  { type: ToolpathType.wall, key: 'wall' },
  { type: ToolpathType.overhangWall, key: 'overhangWall' },
  { type: ToolpathType.sparseInfill, key: 'sparseInfill' },
  { type: ToolpathType.solidInfill, key: 'solidInfill' },
  { type: ToolpathType.topSurface, key: 'topSurface' },
  { type: ToolpathType.bottomSurface, key: 'bottomSurface' },
  { type: ToolpathType.bridge, key: 'bridge' },
  { type: ToolpathType.support, key: 'support' },
  { type: ToolpathType.skirt, key: 'skirt' },
  { type: ToolpathType.gapFill, key: 'gapFill' },
  { type: ToolpathType.ironing, key: 'ironing' },
  { type: ToolpathType.primeTower, key: 'primeTower' },
];
const cssColor = (rgb: number[] | undefined) => (rgb ? `rgb(${rgb.map((c) => Math.round(c * 255)).join(',')})` : '#888');
const VIEWS: Record<string, [number, number, number]> = { iso: [1, 0.85, 1], top: [0, 1, 0], front: [0, 0, 1], right: [1, 0, 0] };
const STYLES: VisualStyle[] = ['shaded', 'edges', 'hiddenEdges', 'wireframe', 'polygons'];
const OVERHANG_DEGS = [30, 45, 60];
const THIN_MMS = [0.8, 1.2, 1.6];
/** The help sheet's rows: a key chip and its `partViewer.help.*` label. */
const HELP_KEYS: Array<[string, string]> = [
  ['1 2 3 4', 'views'], ['Space', 'fit'], ['P', 'projection'], ['G', 'grid'], ['X', 'xray'], ['S', 'section'], ['D', 'dims'], ['M', 'measure'],
  ['R', 'turntable'], ['V', 'style'], ['E', 'explode'], ['O', 'overhangs'], ['T', 'thinWalls'], ['I', 'details'], ['C', 'clean'], ['?', 'help'],
];
const HELP_TOUCH: string[] = ['touchOrbit', 'touchZoom', 'touchIsolate', 'cube'];
const panelCls = 'rounded-xl border border-white/10 bg-bambu-dark/80 px-3 py-2 text-[11px] text-bambu-gray backdrop-blur-sm';

const iconBtn = `relative flex h-8 w-8 items-center justify-center rounded-lg text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white aria-pressed:bg-bambu-dark-tertiary aria-pressed:text-bambu-green ${focusRingCls}`;

function ToolButton({ label, pressed, onClick, side = 'top', children, testId }: { label: string; pressed?: boolean; onClick: () => void; side?: 'top' | 'bottom'; children: ReactNode; testId?: string }) {
  return (
    <Tooltip content={label} side={side}>
      <button type="button" aria-label={label} aria-pressed={pressed} onClick={onClick} data-testid={testId} className={iconBtn}>
        {children}
      </button>
    </Tooltip>
  );
}

/** The part viewer (option A, 2026-10-31): one modal for a library file, an archive or a project
 *  revision, with a Model tab (the 3MF/STL/STEP mesh) and a Toolpath tab (the sliced G-code),
 *  each shown only when its file exists; a CAD view cube; the view tools; and a rail with
 *  everything known about the part. */
export function PartViewerModal({ subject, title, onClose, onPrint, onOpenInSlicer, onDownload, onSliceWithFenrir, onSnapshot, printed = 0, initialTab, initialState = null }: PartViewerModalProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { hasPermission, hasAnyPermission } = useAuth();
  const { data: settings } = useUiSettings();
  const calcConfig = useCalcConfig();
  const fullscreen = usePreviewFullscreen();
  const scene = useRef<PartSceneHandle>(null);

  // ---------- what to show ----------
  const archiveCaps = useQuery({
    queryKey: ['archive-capabilities', subject.kind === 'archive' ? subject.archiveId : null],
    queryFn: () => api.getArchiveCapabilities((subject as Extract<PartSubject, { kind: 'archive' }>).archiveId),
    enabled: subject.kind === 'archive',
  });
  const sources = useMemo(() => sourcesFor(subject, archiveCaps.data ?? undefined), [subject, archiveCaps.data]);
  const platesQuery = useQuery({
    queryKey: ['part-viewer-plates', sources?.plates?.kind, sources?.plates?.kind === 'library' ? sources.plates.fileId : sources?.plates?.kind === 'archive' ? sources.plates.archiveId : null],
    queryFn: async (): Promise<LibraryFilePlatesResponse | ArchivePlatesResponse> => {
      const src = sources!.plates!;
      return src.kind === 'library' ? api.getLibraryFilePlates(src.fileId) : api.getArchivePlates(src.archiveId);
    },
    enabled: !!sources?.plates,
  });
  const plates: PlateMetadata[] = useMemo(() => platesQuery.data?.plates ?? [], [platesQuery.data]);
  const multiPlate = (platesQuery.data?.is_multi_plate ?? false) && plates.length > 1;
  const embeddedPrinter = platesQuery.data?.embedded_printer ?? null;
  const embeddedProcess = platesQuery.data?.embedded_process ?? null;

  const hasModel = !!sources?.model;
  const hasToolpath = !!sources?.toolpath;
  const [tab, setTab] = useState<Tab>('model');
  const wantTab = initialState?.tab ?? initialTab;
  useEffect(() => {
    if (!sources) return;
    setTab(wantTab === 'toolpath' && hasToolpath ? 'toolpath' : hasModel ? 'model' : 'toolpath');
  }, [sources, hasModel, hasToolpath, wantTab]);

  // ---------- view state ----------
  // The Display settings persist per browser; a link's state wins over them for that opening.
  const [prefs] = useState(readDisplayPrefs);
  const [ortho, setOrtho] = useState(initialState?.view?.ortho ?? prefs.ortho);
  const [grid, setGrid] = useState(prefs.grid);
  const [xray, setXray] = useState(initialState?.xray ?? false);
  const [section, setSection] = useState<SectionState>(initialState?.section ?? { on: false, axis: 'z', pct: 100 });
  const [style, setStyle] = useState<VisualStyle>(initialState?.style ?? prefs.style);
  const [analysis, setAnalysis] = useState<AnalysisState>({ overhang: initialState?.overhang ?? prefs.overhang, thinWalls: initialState?.thinWalls ?? prefs.thinWalls });
  const [renderPrefs, setRenderPrefs] = useState<RenderPrefs>(prefs.render);
  useEffect(() => {
    writeDisplayPrefs({ style, grid, ortho, overhang: analysis.overhang, thinWalls: analysis.thinWalls, render: renderPrefs });
  }, [style, grid, ortho, analysis, renderPrefs]);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult>({ overhangShare: null, thinWalls: null });
  const [explode, setExplode] = useState(initialState?.explode ?? 0);
  const [explodeOpen, setExplodeOpen] = useState((initialState?.explode ?? 0) > 0);
  const [displayOpen, setDisplayOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [photo, setPhoto] = useState<{ index: number; overlay: boolean; opacity: number } | null>(null);
  const [speed, setSpeed] = useState(1);
  // The link's camera, applied once the first frame of the part is in (after its framing).
  // Re-applied on every rebuild for a short window: the plates and the bed size arrive after
  // the mesh and each of those re-frames the camera, which would undo the link's view.
  const pendingView = useRef<SceneView | null>(initialState?.view ?? null);
  const applyPendingView = () => {
    const view = pendingView.current;
    if (!view) return;
    requestAnimationFrame(() => scene.current?.setSceneView(view));
    window.setTimeout(() => scene.current?.setSceneView(view), 400);
    window.setTimeout(() => { if (pendingView.current === view) pendingView.current = null; }, 2500);
  };
  const [dims, setDims] = useState(false);
  const [tool, setTool] = useState<Tool>('none');
  const [turntable, setTurntable] = useState(false);
  const [railOn, setRailOn] = useState(true);
  const [clean, setClean] = useState(false);
  const [selectedPlateId, setSelectedPlateId] = useState<number | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [isolatedIndex, setIsolatedIndex] = useState<number | null>(null);
  const [objects, setObjects] = useState<PartObject[]>([]);
  const [bounds, setBounds] = useState<PartBounds | null>(null);
  const [toolpathStats, setToolpathStats] = useState<ToolpathStats | null>(null);
  const [layerRange, setLayerRange] = useState<[number, number]>([0, 0]);
  const [hiddenFeatures, setHiddenFeatures] = useState<ReadonlySet<number>>(new Set(initialState?.hidden ?? []));
  const [colorMode, setColorMode] = useState<'feature' | 'filament'>('feature');
  const [playing, setPlaying] = useState(false);
  const [measure, setMeasure] = useState<number | null>(null);
  // Pins live on the revision (projects only); elsewhere there is nothing to pin to.
  const queryClient = useQueryClient();
  const revisionId = subject.kind === 'revision' ? subject.revision.id : null;
  const pinsQuery = useQuery({
    queryKey: ['revision-pins', revisionId],
    queryFn: () => api.getRevisionPins(revisionId!),
    enabled: revisionId !== null,
  });
  const pins: Pin[] = useMemo(() => (pinsQuery.data ?? []).map((p) => ({ id: p.id, x: p.x, y: p.y, z: p.z, text: p.created_by ? `${p.text} · ${p.created_by}` : p.text })), [pinsQuery.data]);
  const addPin = useMutation({
    mutationFn: (body: { x: number; y: number; z: number; text: string }) => api.createRevisionPin(revisionId!, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['revision-pins', revisionId] }),
    onError: () => showToast(t('common.error'), 'error'),
  });
  const removePin = useMutation({
    mutationFn: (pinId: number) => api.deleteRevisionPin(pinId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['revision-pins', revisionId] }),
    onError: () => showToast(t('common.error'), 'error'),
  });
  const [compareRevision, setCompareRevision] = useState<ProjectRevisionOut | null>(null);
  const [bedOverride, setBedOverride] = useState<string | null>(null);
  const [status, setStatus] = useState<ViewerStatus>({ loading: true, error: null });
  const [menu, setMenu] = useState<{ kind: 'slicer' | 'compare'; x: number; y: number } | null>(null);
  const menuAnchor = useRef<HTMLButtonElement>(null);

  const linkLayers = useRef(initialState?.layers ?? null);
  useEffect(() => {
    if (!toolpathStats) return;
    const last = Math.max(0, toolpathStats.layerCount - 1);
    const wanted = linkLayers.current;
    linkLayers.current = null;
    setLayerRange(wanted ? [Math.min(wanted[0], last), Math.min(wanted[1], last)] : [0, last]);
    applyPendingView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolpathStats]);
  useEffect(() => {
    if (!playing || !toolpathStats) return;
    const last = toolpathStats.layerCount - 1;
    const timer = window.setInterval(() => {
      setLayerRange(([bottom, top]) => {
        const next = Math.min(last, top + Math.max(1, Math.round((last / 120) * speed)));
        if (next >= last) setPlaying(false);
        return [bottom, next];
      });
    }, 30);
    return () => window.clearInterval(timer);
  }, [playing, toolpathStats, speed]);
  const togglePlay = () => {
    if (!playing && toolpathStats) setLayerRange(([bottom]) => [bottom, bottom]);
    setPlaying((p) => !p);
  };

  // ---------- the bed, the colours, the facts ----------
  const printerName = bedOverride ?? (subject.kind === 'revision' ? ((subject.revision.print_profile?.printer_model as string | undefined) ?? null) : null) ?? embeddedPrinter ?? sources?.facts?.sliced_for_model ?? null;
  const buildVolume = useMemo(
    () => (subject.kind === 'archive' && archiveCaps.data && !bedOverride ? archiveCaps.data.build_volume : buildVolumeFor(bedOverride, printerName, ...(sources?.printerHints ?? []))),
    [subject.kind, archiveCaps.data, bedOverride, printerName, sources],
  );
  const activePlate = useMemo(() => plates.find((p) => p.index === selectedPlateId) ?? plates[0] ?? null, [plates, selectedPlateId]);
  const filamentColors = useMemo(() => {
    const fromPlates = activePlate?.filaments.map((f) => f.color) ?? [];
    if (fromPlates.length) return fromPlates;
    if (subject.kind === 'archive' && archiveCaps.data) return archiveCaps.data.filament_colors;
    const own = (sources?.facts?.filament_color ?? '').split(',').map((c) => c.trim()).filter(Boolean);
    return own.length ? own : ['#00ae42'];
  }, [activePlate, subject.kind, archiveCaps.data, sources]);
  const objectNames = useMemo(() => (selectedPlateId != null ? (activePlate?.objects ?? []) : plates.flatMap((p) => p.objects ?? [])), [plates, activePlate, selectedPlateId]);

  const libraryDetail = useQuery({
    queryKey: ['library-file', subject.kind === 'library' ? subject.fileId : null],
    queryFn: () => api.getLibraryFile((subject as Extract<PartSubject, { kind: 'library' }>).fileId),
    enabled: subject.kind === 'library' && subject.photos === undefined,
  });
  const photoUrls = useMemo(() => {
    if (subject.kind === 'archive') return (subject.photos ?? []).map((name) => api.getArchivePhotoUrl(subject.archiveId, name));
    if (subject.kind === 'library') return (subject.photos ?? libraryDetail.data?.photos ?? []).map((name) => api.getLibraryFilePhotoUrl(subject.fileId, name));
    return [];
  }, [subject, libraryDetail.data]);

  const profile = subject.kind === 'revision' ? subject.revision.print_profile : null;
  const facts = useMemo(
    () => sources?.facts ?? (activePlate ? { print_time_seconds: activePlate.print_time_seconds, filament_used_grams: activePlate.filament_used_grams, filament_type: activePlate.filaments[0]?.type ?? null } : null),
    [sources, activePlate],
  );
  const estimate = useMemo(() => {
    if (!facts || !calcConfig) return null;
    const e = estimateArchiveSalePrice(
      { print_time_seconds: facts.print_time_seconds ?? null, filament_used_grams: facts.filament_used_grams ?? null, filament_type: facts.filament_type ?? null, filament_vendor: facts.filament_vendor },
      calcConfig.filaments, calcConfig.printers, calcConfig.defaults, [printerName, facts.sliced_for_model],
    );
    return e ? { price: e.totalTtc, cost: e.machineCost } : null;
  }, [facts, calcConfig, printerName]);
  const railPrint: RailPrint = {
    facts,
    layerCount: toolpathStats?.layerCount ?? null,
    printer: printerName,
    nozzle: nozzleLabel(profile?.nozzle_diameter, facts?.nozzle_diameter, subject.kind === 'revision' ? null : subject.nozzleDiameter, embeddedPrinter),
    layerHeight: profile?.layer_height ? `${profile.layer_height} mm` : facts?.layer_height ? `${facts.layer_height} mm` : null,
    bedType: activePlate?.bed_type ?? null,
    profile: embeddedProcess ?? (profile ? printProfileLine(profile) : null),
    filaments: (activePlate?.filaments ?? []).filter((f) => f.used_in_plate !== false).map((f) => ({ slot: f.slot_id, type: f.type, color: f.color, grams: f.used_grams ?? null, meters: f.used_meters ?? null })),
    estimate,
    currencyCode: settings?.currency || 'USD',
  };
  const checks = useMemo(
    () =>
      runChecks({
        bbox: bounds,
        volume: buildVolume,
        sliced: sources ? hasToolpath : null,
        supportShare: toolpathStats ? (toolpathStats.typeShares[ToolpathType.support] ?? 0) : null,
        outdatedBy: subject.kind === 'revision' ? (subject.revision.outdated_by ? `R${subject.revision.outdated_by.number ?? ''}`.replace(/R$/, '') || subject.revision.outdated_by.item_name : null) : null,
        filaments: railPrint.filaments.map((f) => `A${f.slot} · ${f.type}`),
        overhangs: analysis.overhang.on && analysisResult.overhangShare !== null ? { share: analysisResult.overhangShare, deg: analysis.overhang.deg } : null,
        thinWalls: analysis.thinWalls.on && analysisResult.thinWalls ? { share: analysisResult.thinWalls.share, mm: analysis.thinWalls.mm } : null,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- railPrint is rebuilt each render; its filaments derive from activePlate
    [bounds, buildVolume, sources, hasToolpath, toolpathStats, subject, activePlate, analysis, analysisResult],
  );

  // ---------- actions ----------
  const preferredSlicer: SlicerType = resolveDesktopSlicer(settings?.open_in_slicer, settings?.preferred_slicer);
  const slicerOrder: SlicerType[] = preferredSlicer === 'orcaslicer' ? ['orcaslicer', 'bambu_studio'] : ['bambu_studio', 'orcaslicer'];
  const libraryType = subject.kind === 'library' ? subject.fileType : '3mf';
  const usableSlicers = subject.kind === 'library' ? slicerOrder.filter((s) => isSliceableFileType(libraryType, s)) : slicerOrder;
  const useFenrirSlicer = subject.kind === 'library' && !!settings?.use_slicer_api && !!onSliceWithFenrir && isApiSliceableFileType(libraryType);
  const slicerName = (slicer: SlicerType) => (slicer === 'orcaslicer' ? t('settings.slicerOrcaSlicer') : t('settings.slicerBambuStudio'));
  const handleOpenInSlicer = async (slicer: SlicerType) => {
    if (onOpenInSlicer) return onOpenInSlicer();
    const filename = title || 'model';
    try {
      if (subject.kind === 'library') {
        const { token } = await api.createLibrarySlicerToken(subject.fileId);
        openInSlicer(`${window.location.origin}${api.getLibrarySlicerDownloadUrl(subject.fileId, token, filename)}`, slicer);
      } else if (subject.kind === 'archive') {
        const { token } = await api.createArchiveSlicerToken(subject.archiveId);
        openInSlicer(`${window.location.origin}${api.getArchiveSlicerDownloadUrl(subject.archiveId, token, filename)}`, slicer);
      }
    } catch {
      showToast(t('modelViewer.openInSlicerFailed'), 'error');
    }
  };
  const canOpenInSlicer = !!onOpenInSlicer || usableSlicers.length > 0;

  const copyLink = async () => {
    const base = window.location.origin;
    const state = encodeViewerState({
      tab, view: scene.current?.getSceneView() ?? undefined, layers: toolpathStats ? layerRange : undefined, hidden: [...hiddenFeatures], style, xray, explode, section,
      overhang: analysis.overhang, thinWalls: analysis.thinWalls,
    });
    const url =
      subject.kind === 'revision'
        ? `${base}/projects?project=${subject.projectId}&file=${subject.item.id}&tab=${tab}&v=${state}`
        : subject.kind === 'library'
          ? `${base}/files?highlight=${subject.fileId}`
          : `${base}/archives?highlight=${subject.archiveId}`;
    try {
      await navigator.clipboard.writeText(url);
      showToast(t('partViewer.tools.linkCopied'), 'success');
    } catch {
      showToast(url, 'info');
    }
  };
  const snapshotToFile = async () => {
    const blob = await scene.current?.snapshot();
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${title.replace(/\.[^.]+$/, '')}.png`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const thumbnailFileId = subject.kind === 'library' ? subject.fileId : subject.kind === 'revision' ? (sources?.files.find((f) => f.role === 'source')?.id ?? sources?.files[0]?.id ?? null) : null;
  const canSetThumbnail = thumbnailFileId !== null && hasAnyPermission('library:update_own', 'library:update_all');
  const applyAsThumbnail = async () => {
    if (thumbnailFileId === null) return;
    const blob = await scene.current?.snapshot(256);
    if (!blob) return;
    try {
      await api.uploadLibraryPreviewThumbnail(thumbnailFileId, blob);
      showToast(t('partViewer.tools.thumbnailSaved'), 'success');
    } catch {
      showToast(t('common.error'), 'error');
    }
  };
  const compareChoices = subject.kind === 'revision' ? subject.item.revisions.filter((r) => r.id !== subject.revision.id && r.files.some((f) => isSourceFilename(f.filename))) : [];
  const compareUrl = compareRevision ? api.getLibraryFileDownloadUrl(compareRevision.files.find((f) => isSourceFilename(f.filename))!.id) : null;
  const canPin = subject.kind === 'revision' && hasPermission('projects:update');
  const placePin = useCallback(
    (point: [number, number, number]) => {
      const text = window.prompt(t('partViewer.tools.pinPrompt'))?.trim();
      if (!text || revisionId === null) return;
      addPin.mutate({ x: point[0], y: point[1], z: point[2], text });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the mutation object is stable enough; its identity changes do not matter here
    [t, revisionId],
  );

  // ---------- keyboard ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) return;
      const k = e.key.toLowerCase();
      if (e.key === '1') scene.current?.goTo(VIEWS.iso);
      else if (e.key === '2') scene.current?.goTo(VIEWS.top);
      else if (e.key === '3') scene.current?.goTo(VIEWS.front);
      else if (e.key === '4') scene.current?.goTo(VIEWS.right);
      else if (e.key === ' ') { e.preventDefault(); scene.current?.fit(); }
      else if (k === 'p') setOrtho((v) => !v);
      else if (k === 'g') setGrid((v) => !v);
      else if (k === 'x') setXray((v) => !v);
      else if (k === 's') setSection((s) => ({ ...s, on: !s.on }));
      else if (k === 'd') setDims((v) => !v);
      else if (k === 'm') setTool((v) => (v === 'measure' ? 'none' : 'measure'));
      else if (k === 'r') setTurntable((v) => !v);
      else if (k === 'i') setRailOn((v) => !v);
      else if (k === 'c') setClean((v) => !v);
      else if (k === 'v') setStyle((v) => STYLES[(STYLES.indexOf(v) + 1) % STYLES.length]);
      else if (k === 'e') { setExplode((v) => (v > 0 ? 0 : 0.6)); setExplodeOpen((v) => !v); }
      else if (k === 'o') setAnalysis((a) => ({ ...a, overhang: { ...a.overhang, on: !a.overhang.on } }));
      else if (k === 't') setAnalysis((a) => ({ ...a, thinWalls: { ...a.thinWalls, on: !a.thinWalls.on } }));
      else if (e.key === '?') setHelpOpen((v) => !v);
      else if (e.key === 'Escape' && !e.defaultPrevented) { setDisplayOpen(false); setHelpOpen(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---------- header ----------
  const statusChip = subject.kind === 'revision' ? (
    <span className="flex items-center gap-1.5">
      <span className={`${chipBase} text-[11px]`}>{`R${subject.revision.number}`}</span>
      <span className={`${chipBase} text-[11px] ${STATUS_CHIP_CLS[subject.revision.status]}`}>{t(STATUS_LABEL_KEYS[subject.revision.status])}</span>
      {compareChoices.length > 0 && (
        <Tooltip content={t('partViewer.compare.title')} side="bottom">
          <button ref={menuAnchor} type="button" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ kind: 'compare', x: r.left, y: r.bottom }); }}
            className={`${chipBase} gap-1 text-[11px] ${compareRevision ? 'border-amber-500/40 bg-amber-500/10 text-amber-300' : 'text-bambu-gray hover:text-white'} ${focusRingCls}`}>
            <GitCompare className="h-3 w-3" aria-hidden />{compareRevision ? t('partViewer.compare.with', { n: compareRevision.number }) : t('partViewer.compare.none')}
          </button>
        </Tooltip>
      )}
    </span>
  ) : null;
  const tabs = (sources && (hasModel || hasToolpath)) ? (
    <nav role="tablist" aria-label={t('partViewer.tabs.label')} className="ml-2 flex items-center gap-1 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark p-1">
      {hasModel && (
        <button type="button" role="tab" aria-selected={tab === 'model'} onClick={() => setTab('model')}
          className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm ${tab === 'model' ? 'bg-bambu-dark-tertiary text-white' : 'text-bambu-gray hover:text-white'} ${focusRingCls}`}>
          <Box className="h-4 w-4" aria-hidden />{t('modelViewer.tabs.model')}<span className="rounded border border-bambu-dark-tertiary px-1 font-mono text-[10px] text-bambu-gray">{sources.model!.fileType.toUpperCase()}</span>
        </button>
      )}
      {hasToolpath && (
        <button type="button" role="tab" aria-selected={tab === 'toolpath'} onClick={() => setTab('toolpath')}
          className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm ${tab === 'toolpath' ? 'bg-bambu-dark-tertiary text-white' : 'text-bambu-gray hover:text-white'} ${focusRingCls}`}>
          <Route className="h-4 w-4" aria-hidden />{t('partViewer.tabs.toolpath')}<span className="rounded border border-bambu-dark-tertiary px-1 font-mono text-[10px] text-bambu-gray">{sources.files.find((f) => f.role === 'sliced')?.filename.toLowerCase().endsWith('.gcode.3mf') === false ? 'GCODE' : 'GCODE.3MF'}</span>
        </button>
      )}
    </nav>
  ) : null;
  const actions = (
    <div className="flex items-center gap-0.5">
      {onPrint && <ToolButton label={t('projectsPdm.print.print')} onClick={onPrint} side="bottom"><Printer className="h-4 w-4 text-bambu-green" /></ToolButton>}
      {useFenrirSlicer ? (
        <ToolButton label={t('slice.action')} onClick={() => onSliceWithFenrir?.()} side="bottom"><Cog className="h-4 w-4" /></ToolButton>
      ) : canOpenInSlicer ? (
        <>
          <ToolButton label={onOpenInSlicer ? t('projectsPdm.slice.openInSlicer') : t('modelViewer.openInSlicerWith', { slicer: slicerName(usableSlicers[0]) })} onClick={() => void handleOpenInSlicer(usableSlicers[0])} side="bottom">
            <ExternalLink className="h-4 w-4" />
          </ToolButton>
          {!onOpenInSlicer && usableSlicers.length > 1 && (
            <button type="button" aria-label={t('modelViewer.moreSlicerOptions')} className={`${iconBtn} !w-5`}
              onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); menuAnchor.current = e.currentTarget; setMenu({ kind: 'slicer', x: r.right, y: r.bottom }); }}>
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          )}
        </>
      ) : null}
      {onDownload && sources?.files[0] && <ToolButton label={t('projectsPdm.files.download')} onClick={() => onDownload(sources.files[0])} side="bottom"><Download className="h-4 w-4" /></ToolButton>}
      <ToolButton label={t('partViewer.tools.copyLink')} onClick={() => void copyLink()} side="bottom"><Link2 className="h-4 w-4" /></ToolButton>
      <ToolButton label={t('partViewer.tools.help')} pressed={helpOpen} onClick={() => setHelpOpen((v) => !v)} side="bottom" testId="viewer-help-toggle"><Keyboard className="h-4 w-4" /></ToolButton>
      <span className="mx-1 h-5 w-px bg-bambu-dark-tertiary" aria-hidden />
      <ToolButton label={railOn ? t('partViewer.tools.hideDetails') : t('partViewer.tools.showDetails')} pressed={railOn} onClick={() => setRailOn((v) => !v)} side="bottom" testId="viewer-rail-toggle"><PanelRight className="h-4 w-4" /></ToolButton>
      <ToolButton label={t('partViewer.tools.cleanView')} pressed={clean} onClick={() => setClean((v) => !v)} side="bottom"><Presentation className="h-4 w-4" /></ToolButton>
    </div>
  );

  const errorText = status.error === 'webgl' ? t('partViewer.errors.webgl') : status.error === 'noMeshes' ? t('modelViewer.errors.noMeshes') : status.error === 'unsupported' ? t('modelViewer.errors.unsupportedFormat') : status.error === 'load' ? t('modelViewer.errors.failedToLoad') : null;
  // The timeline (proposition 3): elapsed time at each layer's end from the slicer's progress
  // marks, else the layer's share of the segments; the ridge beside the slider is the per-layer
  // duration, and the legend adds the clock time the layer would print at if started now.
  const timeline = useMemo(() => {
    if (!toolpathStats) return null;
    const n = toolpathStats.layerCount;
    const marks = toolpathStats.remainingPerLayer;
    const hasMarks = marks.some((m) => m !== null);
    const total = facts?.print_time_seconds ?? (hasMarks ? Math.max(...marks.map((m) => m ?? 0)) : null);
    if (!total) return null;
    const elapsed = new Array<number>(n);
    if (hasMarks) {
      let lastKnown = 0;
      for (let i = 0; i < n; i += 1) {
        const m = marks[i];
        if (m !== null) lastKnown = Math.max(lastKnown, total - m);
        elapsed[i] = Math.min(total, lastKnown);
      }
      elapsed[n - 1] = total;
    } else {
      const segs = toolpathStats.segmentsPerLayer;
      const sum = segs.reduce((a, b) => a + b, 0) || 1;
      let acc = 0;
      for (let i = 0; i < n; i += 1) {
        acc += segs[i];
        elapsed[i] = (total * acc) / sum;
      }
    }
    const weights = elapsed.map((e, i) => Math.max(0, e - (i > 0 ? elapsed[i - 1] : 0)));
    return { total, elapsed, weights };
  }, [toolpathStats, facts?.print_time_seconds]);
  const layerInfo = toolpathStats && timeline
    ? t('partViewer.toolpath.layerInfo', { n: layerRange[1] + 1, z: (toolpathStats.zPerLayer[layerRange[1]] ?? 0).toFixed(2), time: formatShort(Math.round(timeline.elapsed[layerRange[1]] ?? 0)), total: formatShort(timeline.total) })
    : toolpathStats ? t('partViewer.toolpath.layerInfoNoTime', { n: layerRange[1] + 1, z: (toolpathStats.zPerLayer[layerRange[1]] ?? 0).toFixed(2) }) : null;
  const layerClock = timeline ? t('partViewer.toolpath.layerClock', { clock: new Date(Date.now() + (timeline.elapsed[layerRange[1]] ?? 0) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }) : null;

  return (
    <PreviewModalShell title={title} fullscreen={fullscreen} onClose={onClose} closeOnBackdropClick titleExtra={<>{statusChip}{tabs}</>} actions={actions}>
      <div className="flex min-h-0 flex-1" data-testid="part-viewer">
        <div className="relative min-w-0 flex-1 bg-bambu-dark" onDoubleClick={undefined}>
          <PartScene
            ref={scene}
            className="absolute inset-0"
            tab={hasModel || hasToolpath ? tab : 'model'}
            model={sources?.model ?? null}
            toolpath={sources?.toolpath ?? null}
            buildVolume={buildVolume}
            filamentColors={filamentColors}
            selectedPlateId={selectedPlateId}
            objectNames={objectNames}
            layerRange={layerRange}
            hiddenFeatures={hiddenFeatures}
            colorMode={colorMode}
            hoverIndex={hoverIndex}
            isolatedIndex={isolatedIndex}
            tool={tool}
            pins={pins}
            section={section}
            dims={dims}
            xray={xray}
            grid={grid}
            ortho={ortho}
            turntable={turntable}
            compareUrl={compareUrl}
            style={style}
            analysis={analysis}
            explode={explode}
            render={renderPrefs}
            onAnalysis={setAnalysisResult}
            onHover={setHoverIndex}
            onIsolate={(i) => setIsolatedIndex((cur) => (cur === i ? null : i))}
            onObjects={(o, b) => { setObjects(o); setBounds(b); if (o.length) applyPendingView(); }}
            onToolpathStats={setToolpathStats}
            onMeasure={setMeasure}
            onPlacePin={placePin}
            onStatus={setStatus}
            onSnapshot={onSnapshot}
          />
          {status.loading && !status.error && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 animate-fade-in" data-testid="viewer-loading">
              <span className="text-xs font-medium tabular-nums text-bambu-gray-light">
                {status.stage === 'prepare' ? t('partViewer.loading.preparing') : status.stage === 'parse' ? t('partViewer.loading.parsing', { pct: Math.round((status.progress ?? 0) * 100) }) : status.progress == null ? t('partViewer.loading.loading') : t('partViewer.loading.downloading', { pct: Math.round(status.progress * 100) })}
              </span>
              <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={status.progress == null ? undefined : Math.round(status.progress * 100)}
                className="h-1 w-48 overflow-hidden rounded-full bg-white/10">
                <div className={`h-full rounded-full bg-bambu-green ${status.progress == null ? 'w-1/3 animate-pulse' : 'w-full origin-left transition-transform duration-150 ease-out'}`}
                  style={status.progress == null ? undefined : { transform: `scaleX(${status.progress})` }} />
              </div>
            </div>
          )}
          {errorText && <div className="absolute inset-0 flex items-center justify-center text-sm text-red-400" role="alert">{errorText}</div>}
          {photo && photoUrls[photo.index] && photo.overlay && (
            <img src={photoUrls[photo.index]} alt="" aria-hidden className="pointer-events-none absolute inset-0 h-full w-full object-contain" style={{ opacity: photo.opacity }} data-testid="photo-overlay" />
          )}
          {photo && photoUrls[photo.index] && !photo.overlay && (
            <div className="absolute bottom-16 right-4 top-4 flex w-[36%] min-w-[240px] max-w-[520px] flex-col overflow-hidden rounded-xl border border-white/10 bg-bambu-dark/90 backdrop-blur-sm animate-rise" data-testid="photo-panel">
              <img src={photoUrls[photo.index]} alt={t('partViewer.photos.title')} className="min-h-0 flex-1 object-contain" />
            </div>
          )}
          {photo && photoUrls[photo.index] && (
            <div className={`absolute right-4 top-4 flex items-center gap-1 ${panelCls} !px-1.5 !py-1`} style={photo.overlay ? undefined : { right: 'calc(36% + 0.5rem)', maxWidth: '50%' }} data-testid="photo-controls">
              <ToolButton label={t('partViewer.photos.prev')} onClick={() => setPhoto((p) => p && { ...p, index: (p.index - 1 + photoUrls.length) % photoUrls.length })}><ChevronLeft className="h-4 w-4" /></ToolButton>
              <span className="tabular-nums text-white">{`${photo.index + 1}/${photoUrls.length}`}</span>
              <ToolButton label={t('partViewer.photos.next')} onClick={() => setPhoto((p) => p && { ...p, index: (p.index + 1) % photoUrls.length })}><ChevronRight className="h-4 w-4" /></ToolButton>
              <ToolButton label={t('partViewer.photos.overlay')} pressed={photo.overlay} onClick={() => setPhoto((p) => p && { ...p, overlay: !p.overlay })} testId="photo-overlay-toggle"><Expand className="h-4 w-4" /></ToolButton>
              {photo.overlay && <input type="range" min={10} max={100} value={Math.round(photo.opacity * 100)} aria-label={t('partViewer.photos.opacity')} onChange={(e) => setPhoto((p) => p && { ...p, opacity: Number(e.target.value) / 100 })} className="w-20 accent-bambu-green" />}
              <ToolButton label={t('partViewer.photos.close')} onClick={() => setPhoto(null)}><X className="h-4 w-4" /></ToolButton>
            </div>
          )}
          {!sources?.model && !sources?.toolpath && sources && <div className="absolute inset-0 flex items-center justify-center text-sm text-bambu-gray">{t('modelViewer.noPreview')}</div>}

          {!clean && (
            <>
              <div className="absolute left-4 top-4 flex flex-col items-center gap-1">
                <ViewCube scene={scene} />
                <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-bambu-dark/80 p-0.5 backdrop-blur-sm">
                  <ToolButton label={t('partViewer.tools.home')} onClick={() => scene.current?.goTo(VIEWS.iso)}><House className="h-3.5 w-3.5" /></ToolButton>
                  <ToolButton label={t('partViewer.tools.fit')} onClick={() => scene.current?.fit()}><Scan className="h-3.5 w-3.5" /></ToolButton>
                </div>
              </div>
              {helpOpen && (
                <div className="absolute left-1/2 top-4 z-10 w-[min(560px,calc(100%-2rem))] -translate-x-1/2 rounded-xl border border-white/10 bg-bambu-dark/90 p-4 text-xs text-bambu-gray backdrop-blur-sm animate-rise" role="dialog" aria-label={t('partViewer.help.title')} data-testid="help-sheet">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-sm font-semibold text-white">{t('partViewer.help.title')}</span>
                    <ToolButton label={t('common.close')} onClick={() => setHelpOpen(false)}><X className="h-4 w-4" /></ToolButton>
                  </div>
                  <div className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
                    {HELP_KEYS.map(([key, label]) => (
                      <div key={key} className="flex items-center gap-2">
                        <kbd className="min-w-[2.2rem] rounded border border-bambu-dark-tertiary bg-bambu-dark px-1.5 py-0.5 text-center font-mono text-[10px] text-white">{key}</kbd>
                        <span>{t(`partViewer.help.${label}`)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 border-t border-bambu-dark-tertiary pt-2">
                    <div className="mb-1 font-medium text-white">{t('partViewer.help.touch')}</div>
                    <ul className="space-y-0.5">{HELP_TOUCH.map((k) => <li key={k}>{t(`partViewer.help.${k}`)}</li>)}</ul>
                  </div>
                </div>
              )}
              <div className="absolute left-4 top-[215px] flex w-[220px] flex-col gap-2">
              {explodeOpen && tab === 'model' && objects.length > 1 && (
                <div className={panelCls} data-testid="explode-panel">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="font-medium text-white">{t('partViewer.display.explode')}</span>
                    <span className="tabular-nums">{`${Math.round(explode * 100)}%`}</span>
                  </div>
                  <input type="range" min={0} max={100} value={Math.round(explode * 100)} aria-label={t('partViewer.display.explode')} onChange={(e) => setExplode(Number(e.target.value) / 100)} className="w-full accent-bambu-green" />
                  <div>{t('partViewer.display.explodeHint')}</div>
                </div>
              )}
              {section.on && tab === 'model' && (
                <div className={panelCls} data-testid="section-panel">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="font-medium text-white">{t('partViewer.section.title')}</span>
                    <span className="flex gap-1">
                      {(['z', 'x', 'y'] as const).map((axis) => (
                        <button key={axis} type="button" aria-pressed={section.axis === axis} onClick={() => setSection((s) => ({ ...s, axis }))}
                          className={`rounded border px-1.5 text-[11px] uppercase ${section.axis === axis ? 'border-bambu-green/40 bg-bambu-green/10 text-bambu-green' : 'border-bambu-dark-tertiary hover:text-white'} ${focusRingCls}`}>{axis}</button>
                      ))}
                    </span>
                  </div>
                  <input type="range" min={0} max={100} value={section.pct} aria-label={t('partViewer.section.title')} onChange={(e) => setSection((s) => ({ ...s, pct: Number(e.target.value) }))} className="w-full accent-bambu-green" />
                  <div className="flex justify-between"><span>{t('partViewer.section.bottom')}</span><span>{`${section.pct}%`}</span><span>{t('partViewer.section.top')}</span></div>
                </div>
              )}
              </div>
              {tab === 'toolpath' && toolpathStats && (
                <>
                  <div className="absolute bottom-14 right-4 top-4 flex">
                    <LayerRange count={toolpathStats.layerCount} range={layerRange} onChange={(r) => { setPlaying(false); setLayerRange(r); }} playing={playing} onTogglePlay={togglePlay}
                      weights={timeline?.weights ?? null} speed={speed} onSpeed={setSpeed} />
                  </div>
                  <div className="absolute bottom-16 left-4 space-y-1 rounded-xl border border-white/10 bg-bambu-dark/80 px-3 py-2 text-[11px] text-bambu-gray backdrop-blur-sm" data-testid="toolpath-legend">
                    <div className="mb-1 flex items-center gap-3">
                      <span className="font-medium text-white">{t('partViewer.toolpath.colour')}</span>
                      <button type="button" onClick={() => setColorMode((m) => (m === 'feature' ? 'filament' : 'feature'))}
                        className={`${chipBase} text-[11px] text-bambu-gray hover:text-white ${focusRingCls}`}>
                        {colorMode === 'feature' ? t('partViewer.toolpath.byFeature') : t('partViewer.toolpath.byFilament')}
                      </button>
                    </div>
                    {colorMode === 'feature' ? LEGEND.filter((l) => (toolpathStats.typeShares[l.type] ?? 0) > 0).map((l) => (
                      <label key={l.type} className="flex cursor-pointer items-center gap-2">
                        <input type="checkbox" className="accent-bambu-green" checked={!hiddenFeatures.has(l.type)}
                          onChange={() => setHiddenFeatures((prev) => { const next = new Set(prev); if (next.has(l.type)) next.delete(l.type); else next.add(l.type); return next; })} />
                        <i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: cssColor(TYPE_COLOR[l.type]) }} />
                        {t(`gcodeViewer.feature.${l.key}`)}
                      </label>
                    )) : railPrint.filaments.map((f) => (
                      <div key={f.slot} className="flex items-center gap-2"><i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: f.color }} />{`A${f.slot} · ${f.type}`}</div>
                    ))}
                    {layerInfo && <div className="mt-1 border-t border-bambu-dark-tertiary pt-1 text-white">{layerInfo}{layerClock && <span className="text-bambu-gray">{` · ${layerClock}`}</span>}</div>}
                  </div>
                </>
              )}
              {(hoverIndex !== null || measure !== null || tool !== 'none') && (
                <div className="absolute left-1/2 top-4 -translate-x-1/2 rounded-lg border border-white/10 bg-bambu-dark/80 px-3 py-1.5 text-xs text-white backdrop-blur-sm" data-testid="viewer-hint">
                  {measure !== null ? `${measure.toFixed(1)} mm` : hoverIndex !== null && objects[hoverIndex]
                    ? `${objects[hoverIndex].name} · ${objects[hoverIndex].size.join(' × ')} mm${objects[hoverIndex].triangles ? ` · ${t('partViewer.rail.triangles', { count: objects[hoverIndex].triangles })}` : ''}`
                    : tool === 'measure' ? t('partViewer.tools.measureHint') : t('partViewer.tools.pinHint')}
                </div>
              )}
              <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-white/10 bg-bambu-dark/80 p-1 backdrop-blur-sm" data-testid="viewer-toolbar">
                <ToolButton label={ortho ? t('partViewer.tools.perspective') : t('partViewer.tools.orthographic')} pressed={ortho} onClick={() => setOrtho((v) => !v)} testId="tool-projection"><Cuboid className="h-4 w-4" /></ToolButton>
                <ToolButton label={t('partViewer.tools.grid')} pressed={grid} onClick={() => setGrid((v) => !v)}><Grid3x3 className="h-4 w-4" /></ToolButton>
                <ToolButton label={t('partViewer.tools.xray')} pressed={xray} onClick={() => setXray((v) => !v)}><Eye className="h-4 w-4" /></ToolButton>
                {tab === 'model' && (
                  <>
                    <ToolButton label={t('partViewer.tools.section')} pressed={section.on} onClick={() => setSection((s) => ({ ...s, on: !s.on }))} testId="tool-section"><ScissorsLineDashed className="h-4 w-4" /></ToolButton>
                    <ToolButton label={t('partViewer.tools.dims')} pressed={dims} onClick={() => setDims((v) => !v)}><Move3d className="h-4 w-4" /></ToolButton>
                    <ToolButton label={t('partViewer.tools.measure')} pressed={tool === 'measure'} onClick={() => setTool((v) => (v === 'measure' ? 'none' : 'measure'))}><Ruler className="h-4 w-4" /></ToolButton>
                    {objects.length > 1 && (
                      <ToolButton label={t('partViewer.tools.explode')} pressed={explode > 0} onClick={() => { setExplodeOpen((v) => !v || explode === 0); setExplode((v) => (v > 0 ? 0 : 0.6)); }} testId="tool-explode"><Expand className="h-4 w-4" /></ToolButton>
                    )}
                  </>
                )}
                <ToolButton label={t('partViewer.tools.display')} pressed={displayOpen} onClick={() => setDisplayOpen((v) => !v)} testId="tool-display"><Monitor className="h-4 w-4" /></ToolButton>
                <span className="mx-0.5 h-5 w-px bg-bambu-dark-tertiary" aria-hidden />
                <ToolButton label={t('partViewer.tools.turntable')} pressed={turntable} onClick={() => setTurntable((v) => !v)}><Rotate3d className="h-4 w-4" /></ToolButton>
                <ToolButton label={t('partViewer.tools.snapshot')} onClick={() => void snapshotToFile()}><Camera className="h-4 w-4" /></ToolButton>
                {canSetThumbnail && <ToolButton label={t('partViewer.tools.useAsThumbnail')} onClick={() => void applyAsThumbnail()}><ImageIcon /></ToolButton>}
                {canPin && tab === 'model' && <ToolButton label={t('partViewer.tools.pin')} pressed={tool === 'pin'} onClick={() => setTool((v) => (v === 'pin' ? 'none' : 'pin'))}><MapPin className="h-4 w-4" /></ToolButton>}
              </div>
              {displayOpen && (
                <div className={`absolute bottom-16 left-1/2 w-[260px] -translate-x-1/2 ${panelCls} animate-rise-sm`} role="menu" aria-label={t('partViewer.display.title')} data-testid="display-menu">
                  <div className="mb-1 font-medium text-white">{t('partViewer.display.style')}</div>
                  <div className="space-y-0.5">
                    {STYLES.map((st) => (
                      <label key={st} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-white/5">
                        <input type="radio" name="visual-style" className="accent-bambu-green" checked={style === st} onChange={() => setStyle(st)} />
                        <span className={style === st ? 'text-white' : ''}>{t(`partViewer.display.${st}`)}</span>
                      </label>
                    ))}
                  </div>
                  <div className="mb-1 mt-2 border-t border-bambu-dark-tertiary pt-2 font-medium text-white">{t('partViewer.display.rendering')}</div>
                  <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-white/5">
                    <input type="checkbox" className="accent-bambu-green" checked={renderPrefs.shadows} onChange={() => setRenderPrefs((r) => ({ ...r, shadows: !r.shadows }))} data-testid="render-shadows" />
                    <span className="flex-1">{t('partViewer.display.shadows')}</span>
                  </label>
                  <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-white/5">
                    <input type="checkbox" className="accent-bambu-green" checked={renderPrefs.ao} onChange={() => setRenderPrefs((r) => ({ ...r, ao: !r.ao }))} data-testid="render-ao" />
                    <span className="flex-1">{t('partViewer.display.ao')}</span>
                  </label>
                  {([['finish', FINISHES], ['reflections', REFLECTIONS], ['background', BACKGROUNDS]] as const).map(([field, options]) => (
                    <label key={field} className="flex items-center gap-2 rounded px-1 py-0.5">
                      <span className="flex-1">{t(`partViewer.display.${field}`)}</span>
                      <select value={renderPrefs[field]} aria-label={t(`partViewer.display.${field}`)} onChange={(e) => setRenderPrefs((r) => ({ ...r, [field]: e.target.value }))}
                        className="rounded border border-bambu-dark-tertiary bg-bambu-dark px-1 py-0.5 text-[11px] text-white" data-testid={`render-${field}`}>
                        {options.map((o) => <option key={o} value={o}>{t(`partViewer.display.${field}_${o}`)}</option>)}
                      </select>
                    </label>
                  ))}
                  {tab === 'model' && (
                    <>
                      <div className="mb-1 mt-2 border-t border-bambu-dark-tertiary pt-2 font-medium text-white">{t('partViewer.display.analysis')}</div>
                      <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-white/5">
                        <input type="checkbox" className="accent-bambu-green" checked={analysis.overhang.on} onChange={() => setAnalysis((a) => ({ ...a, overhang: { ...a.overhang, on: !a.overhang.on } }))} data-testid="analysis-overhangs" />
                        <span className="flex-1">{t('partViewer.display.overhangs')}</span>
                        <select value={analysis.overhang.deg} aria-label={t('partViewer.display.overhangFrom', { deg: analysis.overhang.deg })} onChange={(e) => setAnalysis((a) => ({ ...a, overhang: { on: true, deg: Number(e.target.value) } }))}
                          className="rounded border border-bambu-dark-tertiary bg-bambu-dark px-1 py-0.5 text-[11px] text-white">
                          {OVERHANG_DEGS.map((d) => <option key={d} value={d}>{`${d}°`}</option>)}
                        </select>
                      </label>
                      <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-white/5">
                        <input type="checkbox" className="accent-bambu-green" checked={analysis.thinWalls.on} onChange={() => setAnalysis((a) => ({ ...a, thinWalls: { ...a.thinWalls, on: !a.thinWalls.on } }))} data-testid="analysis-thin-walls" />
                        <span className="flex-1">{t('partViewer.display.thinWalls')}</span>
                        <select value={analysis.thinWalls.mm} aria-label={t('partViewer.display.thinUnder', { mm: analysis.thinWalls.mm })} onChange={(e) => setAnalysis((a) => ({ ...a, thinWalls: { on: true, mm: Number(e.target.value) } }))}
                          className="rounded border border-bambu-dark-tertiary bg-bambu-dark px-1 py-0.5 text-[11px] text-white">
                          {THIN_MMS.map((m) => <option key={m} value={m}>{`${m} mm`}</option>)}
                        </select>
                      </label>
                    </>
                  )}
                </div>
              )}
              <div className="absolute bottom-4 right-4 rounded-lg border border-white/10 bg-bambu-dark/80 px-2.5 py-1 text-[11px] text-bambu-gray backdrop-blur-sm" data-testid="projection-hint">
                {ortho ? t('partViewer.tools.orthographic') : t('partViewer.tools.perspective')}
              </div>
            </>
          )}
        </div>
        {railOn && !clean && (
          <ViewerRail
            plates={plates}
            multiPlate={multiPlate}
            selectedPlateId={selectedPlateId}
            onSelectPlate={(id) => { setSelectedPlateId(id); setIsolatedIndex(null); }}
            objects={objects}
            bounds={bounds}
            hoverIndex={hoverIndex}
            isolatedIndex={isolatedIndex}
            onHover={setHoverIndex}
            onIsolate={(i) => setIsolatedIndex((cur) => (cur === i ? null : i))}
            checks={checks}
            print={railPrint}
            volume={buildVolume}
            onBedChange={subject.kind === 'archive' ? undefined : setBedOverride}
            bedChoices={BED_CHOICES}
            tab={tab}
            onShowToolpath={hasToolpath ? () => setTab('toolpath') : null}
            pins={pinsQuery.data ?? []}
            onDeletePin={canPin ? (id) => removePin.mutate(id) : null}
            files={sources?.files ?? []}
            onDownload={onDownload ?? (subject.kind === 'library' ? () => window.open(api.getLibraryFileDownloadUrl(subject.fileId), '_blank', 'noopener') : null)}
            meta={{ by: subject.kind === 'revision' ? subject.revision.created_by : null, date: subject.kind === 'revision' ? new Date(subject.revision.created_at).toLocaleDateString() : null, printed }}
            photos={photoUrls}
            shownPhoto={photo?.index ?? null}
            onShowPhoto={(index) => setPhoto((p) => (p?.index === index ? null : { index, overlay: p?.overlay ?? false, opacity: p?.opacity ?? 0.5 }))}
          />
        )}
      </div>
      {menu && createPortal(
        <ContextMenu
          x={menu.x}
          y={menu.y}
          anchorRef={menuAnchor}
          onClose={() => setMenu(null)}
          items={
            menu.kind === 'slicer'
              ? usableSlicers.slice(1).map<ContextMenuItem>((s) => ({ label: t('modelViewer.openInSlicerWith', { slicer: slicerName(s) }), onClick: () => void handleOpenInSlicer(s) }))
              : [
                  { label: t('partViewer.compare.none'), onClick: () => setCompareRevision(null), disabled: compareRevision === null },
                  ...compareChoices.map<ContextMenuItem>((r) => ({ label: t('partViewer.compare.with', { n: r.number }), onClick: () => setCompareRevision(r), disabled: compareRevision?.id === r.id })),
                ]
          }
        />,
        document.body,
      )}
    </PreviewModalShell>
  );
}

function ImageIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
    </svg>
  );
}

function formatShort(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
