import { Component, Suspense, lazy, type ComponentType, type ReactNode, type ErrorInfo } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Layout } from './components/Layout';
import { useWebSocket } from './hooks/useWebSocket';
import { useStreamTokenSync } from './hooks/useCameraStreamToken';
import { ThemeProvider } from './contexts/ThemeContext';
import { ToastProvider } from './contexts/ToastContext';
import { SliceJobTrackerProvider } from './contexts/SliceJobTrackerContext';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ColorCatalogProvider } from './contexts/ColorCatalogContext';
import { FullscreenProvider } from './contexts/FullscreenContext';

// After a redeploy the previous build's hashed chunk files no longer exist,
// so a lazy route's dynamic import rejects. One forced reload picks up the
// new index.html; the sessionStorage guard prevents a reload loop when the
// failure has a different cause.
const CHUNK_RELOAD_KEY = 'bambuddy-chunk-reload';
function lazyWithReload(load: () => Promise<{ default: ComponentType }>) {
  return lazy(() =>
    load().then(
      (module) => {
        sessionStorage.removeItem(CHUNK_RELOAD_KEY);
        return module;
      },
      (error) => {
        if (sessionStorage.getItem(CHUNK_RELOAD_KEY)) {
          throw error;
        }
        sessionStorage.setItem(CHUNK_RELOAD_KEY, '1');
        window.location.reload();
        return new Promise<{ default: ComponentType }>(() => {});
      },
    )
  );
}

const PrintersPage = lazyWithReload(() => import('./pages/PrintersPage').then(m => ({ default: m.PrintersPage })));
const ArchivesPage = lazyWithReload(() => import('./pages/ArchivesPage').then(m => ({ default: m.ArchivesPage })));
const QueuePage = lazyWithReload(() => import('./pages/QueuePage').then(m => ({ default: m.QueuePage })));
const StatsPage = lazyWithReload(() => import('./pages/StatsPage').then(m => ({ default: m.StatsPage })));
const SettingsPage = lazyWithReload(() => import('./pages/SettingsPage').then(m => ({ default: m.SettingsPage })));
const ProfilesPage = lazyWithReload(() => import('./pages/ProfilesPage').then(m => ({ default: m.ProfilesPage })));
const MaintenancePage = lazyWithReload(() => import('./pages/MaintenancePage').then(m => ({ default: m.MaintenancePage })));
const CalculatorPage = lazyWithReload(() => import('./pages/CalculatorPage').then(m => ({ default: m.CalculatorPage })));
const CalculatorQuotePage = lazyWithReload(() => import('./pages/CalculatorQuotePage').then(m => ({ default: m.CalculatorQuotePage })));
const ProjectsPage = lazyWithReload(() => import('./pages/ProjectsPage').then(m => ({ default: m.ProjectsPage })));
const ProjectDetailPage = lazyWithReload(() => import('./pages/ProjectDetailPage').then(m => ({ default: m.ProjectDetailPage })));
const FileManagerPage = lazyWithReload(() => import('./pages/FileManagerPage').then(m => ({ default: m.FileManagerPage })));
const LibraryTrashPage = lazyWithReload(() => import('./pages/LibraryTrashPage').then(m => ({ default: m.LibraryTrashPage })));
const CameraPage = lazyWithReload(() => import('./pages/CameraPage').then(m => ({ default: m.CameraPage })));
const StreamOverlayPage = lazyWithReload(() => import('./pages/StreamOverlayPage').then(m => ({ default: m.StreamOverlayPage })));
const ExternalLinkPage = lazyWithReload(() => import('./pages/ExternalLinkPage').then(m => ({ default: m.ExternalLinkPage })));
const GroupEditPage = lazyWithReload(() => import('./pages/GroupEditPage').then(m => ({ default: m.GroupEditPage })));
const InventoryPage = lazyWithReload(() => import('./pages/InventoryPage'));
const MakerworldPage = lazyWithReload(() => import('./pages/MakerworldPage').then(m => ({ default: m.MakerworldPage })));
const SystemInfoPage = lazyWithReload(() => import('./pages/SystemInfoPage').then(m => ({ default: m.SystemInfoPage })));
const LoginPage = lazyWithReload(() => import('./pages/LoginPage').then(m => ({ default: m.LoginPage })));
const SetupPage = lazyWithReload(() => import('./pages/SetupPage').then(m => ({ default: m.SetupPage })));
const NotificationsPage = lazyWithReload(() => import('./pages/NotificationsPage').then(m => ({ default: m.NotificationsPage })));
const GCodeViewerPage = lazyWithReload(() => import('./pages/GCodeViewerPage').then(m => ({ default: m.GCodeViewerPage })));
const SpoolBuddyLayout = lazyWithReload(() => import('./components/spoolbuddy/SpoolBuddyLayout').then(m => ({ default: m.SpoolBuddyLayout })));
const SpoolBuddyDashboard = lazyWithReload(() => import('./pages/spoolbuddy/SpoolBuddyDashboard').then(m => ({ default: m.SpoolBuddyDashboard })));
const SpoolBuddyAmsPage = lazyWithReload(() => import('./pages/spoolbuddy/SpoolBuddyAmsPage').then(m => ({ default: m.SpoolBuddyAmsPage })));
const SpoolBuddySettingsPage = lazyWithReload(() => import('./pages/spoolbuddy/SpoolBuddySettingsPage').then(m => ({ default: m.SpoolBuddySettingsPage })));
const SpoolBuddyCalibrationPage = lazyWithReload(() => import('./pages/spoolbuddy/SpoolBuddyCalibrationPage').then(m => ({ default: m.SpoolBuddyCalibrationPage })));
const SpoolBuddyWriteTagPage = lazyWithReload(() => import('./pages/spoolbuddy/SpoolBuddyWriteTagPage').then(m => ({ default: m.SpoolBuddyWriteTagPage })));
const SpoolBuddyInventoryPage = lazyWithReload(() => import('./pages/spoolbuddy/SpoolBuddyInventoryPage').then(m => ({ default: m.SpoolBuddyInventoryPage })));
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null; errorInfo: ErrorInfo | null }> {
  state = { error: null as Error | null, errorInfo: null as ErrorInfo | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo });
    console.error('React crash:', error, errorInfo);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, color: '#ef4444', backgroundColor: '#18181b', minHeight: '100vh', fontFamily: 'monospace' }}>
          <h1 style={{ fontSize: 20, marginBottom: 12 }}>UI Crash</h1>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 14 }}>{this.state.error.message}</pre>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, color: '#a1a1aa', marginTop: 12 }}>
            {this.state.error.stack}
          </pre>
          <button
            onClick={() => { this.setState({ error: null, errorInfo: null }); }}
            style={{ marginTop: 16, padding: '8px 16px', backgroundColor: '#3b82f6', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60,
      retry: 1,
    },
  },
});

// Full-viewport route-guard loading state — a centered spinner instead of a
// bare "Loading..." so the pre-auth/permission gate resolves less jarringly.
function RouteLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-bambu-dark animate-fade-in">
      <Loader2 className="w-7 h-7 text-bambu-green animate-spin" />
    </div>
  );
}

function StreamTokenSync() {
  useStreamTokenSync();
  return null;
}

function WebSocketProvider({ children }: { children: React.ReactNode }) {
  useWebSocket();
  return <>{children}</>;
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { authEnabled, loading, user } = useAuth();
  const location = useLocation();

  if (loading) {
    return <RouteLoading />;
  }

  if (authEnabled && !user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <>{children}</>;
}

function PermissionRoute({ permission, children }: { permission: string; children: React.ReactNode }) {
  // Permission-gated route: any user with the given permission can enter, not
  // just admins. Individual components below this guard apply their own
  // per-action permission checks. Used for pages where delegation is supported
  // (e.g. settings:read grants read-only access to Settings; specific tabs
  // require their own permissions like users:read, groups:update, etc.).
  const { authEnabled, loading, user, hasPermission } = useAuth();
  const location = useLocation();

  if (loading) {
    return <RouteLoading />;
  }

  // Auth disabled → open access (backward compatibility)
  if (!authEnabled) {
    return <>{children}</>;
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  if (!hasPermission(permission as Parameters<typeof hasPermission>[0])) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}

function SetupRoute({ children }: { children: React.ReactNode }) {
  const { authEnabled, loading } = useAuth();

  if (loading) {
    return <RouteLoading />;
  }

  // If auth is already enabled, redirect to login
  // Otherwise, allow access to setup page (even if setup was completed before)
  // This allows users to enable auth later if they skipped it during initial setup
  if (authEnabled) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            {/* ThemeProvider sits inside AuthProvider so its initial
                ``api.getSettings()`` fetch can wait for AuthContext to
                resolve — otherwise it fires unconditionally on every
                login page load and returns 401. ErrorBoundary uses
                inline styles, so a missing theme on a crash screen is
                not a regression. */}
            <ThemeProvider>
            <ColorCatalogProvider>
            <SliceJobTrackerProvider>
            <FullscreenProvider>
            <StreamTokenSync />
            <BrowserRouter>
              <Suspense fallback={<RouteLoading />}>
              <Routes>
                {/* Setup page - only accessible if auth not enabled */}
                <Route path="/setup" element={<SetupRoute><SetupPage /></SetupRoute>} />

                {/* Login page */}
                <Route path="/login" element={<LoginPage />} />

                {/* Camera page - standalone, no layout, no WebSocket (doesn't need real-time updates) */}
                <Route path="/camera/:printerId" element={<CameraPage />} />

                {/* Stream overlay page - standalone for OBS/streaming embeds, no auth required */}
                <Route path="/overlay/:printerId" element={<StreamOverlayPage />} />

                {/* Printable client-facing quote — standalone (light, print-first, no app chrome) */}
                <Route
                  path="/calculator/quote"
                  element={
                    <ProtectedRoute>
                      <PermissionRoute permission="calculator:read">
                        <CalculatorQuotePage />
                      </PermissionRoute>
                    </ProtectedRoute>
                  }
                />

                {/* SpoolBuddy kiosk UI */}
                <Route element={<ProtectedRoute><WebSocketProvider><SpoolBuddyLayout /></WebSocketProvider></ProtectedRoute>}>
                  <Route path="spoolbuddy" element={<SpoolBuddyDashboard />} />
                  <Route path="spoolbuddy/ams" element={<SpoolBuddyAmsPage />} />
                  <Route path="spoolbuddy/write-tag" element={<SpoolBuddyWriteTagPage />} />
                  <Route path="spoolbuddy/inventory" element={<SpoolBuddyInventoryPage />} />
                  <Route path="spoolbuddy/settings" element={<SpoolBuddySettingsPage />} />
                  <Route path="spoolbuddy/calibration" element={<SpoolBuddyCalibrationPage />} />
                </Route>

                {/* Main app with WebSocket for real-time updates */}
                <Route element={<ProtectedRoute><WebSocketProvider><Layout /></WebSocketProvider></ProtectedRoute>}>
                  <Route index element={<PrintersPage />} />
                  <Route path="archives" element={<ArchivesPage />} />
                  <Route path="queue" element={<QueuePage />} />
                  {/* Slicer Pipelines (#1425) — Pipelines tab lives on the
                      Print Queue page (Queue + History + Timeline +
                      Pipelines). Old standalone URL redirects. */}
                  <Route path="pipelines/runs" element={<Navigate to="/queue?tab=pipelines" replace />} />
                  <Route path="stats" element={<StatsPage />} />
                  <Route path="profiles" element={<ProfilesPage />} />
                  <Route path="maintenance" element={<MaintenancePage />} />
                  <Route path="calculator" element={<PermissionRoute permission="calculator:read"><CalculatorPage /></PermissionRoute>} />
                  <Route path="projects" element={<ProjectsPage />} />
                  <Route path="projects/:id" element={<ProjectDetailPage />} />
                  <Route path="inventory" element={<InventoryPage />} />
                  <Route path="files" element={<FileManagerPage />} />
                  <Route path="files/trash" element={<LibraryTrashPage />} />
                  <Route path="makerworld" element={<PermissionRoute permission="makerworld:view"><MakerworldPage /></PermissionRoute>} />
                  <Route path="settings" element={<PermissionRoute permission="settings:read"><SettingsPage /></PermissionRoute>} />
                  <Route path="groups/new" element={<PermissionRoute permission="groups:create"><GroupEditPage /></PermissionRoute>} />
                  <Route path="groups/:id/edit" element={<PermissionRoute permission="groups:update"><GroupEditPage /></PermissionRoute>} />
                  <Route path="users" element={<Navigate to="/settings?tab=users" replace />} />
                  <Route path="groups" element={<Navigate to="/settings?tab=users" replace />} />
                  <Route path="system" element={<SystemInfoPage />} />
                  <Route path="notifications" element={<NotificationsPage />} />
                  <Route path="gcode-viewer" element={<GCodeViewerPage />} />
                  <Route path="external/:id" element={<ExternalLinkPage />} />
                  <Route path="camera-tokens" element={<Navigate to="/settings?tab=apikeys#card-camera-tokens" replace />} />
                </Route>
              </Routes>
              </Suspense>
            </BrowserRouter>
            </FullscreenProvider>
            </SliceJobTrackerProvider>
            </ColorCatalogProvider>
            </ThemeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </ToastProvider>
    </ErrorBoundary>
  );
}

export default App;
