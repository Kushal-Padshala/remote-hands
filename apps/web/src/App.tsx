import { useState, useEffect } from 'react';
import type { MachineRow, TaskRow, TaskKind, TaskMode } from '@remote-hands/shared';
import clsx from 'clsx';
import { apiClient } from './api/client.js';
import { MachinesScreen } from './screens/MachinesScreen.js';
import { NewTaskScreen } from './screens/NewTaskScreen.js';
import { LiveTaskScreen } from './screens/LiveTaskScreen.js';
import { PairingTab } from './screens/PairingTab.js';
import { HistoryTab } from './screens/HistoryTab.js';
import { PairingModal } from './components/PairingModal.js';
import { SidebarMachines } from './components/SidebarMachines.js';
import { InstallModal } from './components/InstallModal.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';

export function App() {
  const [machines, setMachines] = useState<MachineRow[]>(() => {
    if (typeof localStorage !== 'undefined') {
      try {
        const cached = localStorage.getItem('rh_cached_machines');
        if (cached) {
          const parsed = JSON.parse(cached);
          if (Array.isArray(parsed) && parsed.length > 0) {
            return parsed;
          }
        }
      } catch {}
    }
    return [];
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [currentScreen, setCurrentScreen] = useState<'machines' | 'new-task' | 'live-task'>('machines');
  const [activeTab, setActiveTab] = useState<'devices' | 'history' | 'pairing'>('devices');
  const [selectedMachine, setSelectedMachine] = useState<MachineRow | null>(null);
  const [activeTask, setActiveTask] = useState<TaskRow | null>(null);
  const [submittingTask, setSubmittingTask] = useState(false);
  const [showPairModal, setShowPairModal] = useState(false);
  const [showInstallModal, setShowInstallModal] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [isStandalone, setIsStandalone] = useState(false);
  const [pairingCode, setPairingCode] = useState<string | undefined>(undefined);
  const [pasteUrlInput, setPasteUrlInput] = useState('');

  const handleClearCache = () => {
    try {
      localStorage.removeItem('rh_token');
      localStorage.removeItem('rh_pairing_code');
      localStorage.removeItem('rh_api_url');
      localStorage.removeItem('rh_cached_machines');
    } catch {}
    setPairingCode(undefined);
    setError(null);
    setMachines([]);
    if (typeof window !== 'undefined') {
      window.location.href = window.location.origin;
    }
  };

  const handleConnectUrl = (rawInput: string) => {
    const trimmed = rawInput.trim();
    if (!trimmed) return;
    try {
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.includes('?') || trimmed.includes('&')) {
        const urlToParse = trimmed.startsWith('http') ? trimmed : `https://dummy/?${trimmed.replace(/^\?/, '')}`;
        const parsed = new URL(urlToParse);
        const secret = parsed.searchParams.get('secret') || parsed.searchParams.get('token');
        const api = parsed.searchParams.get('api');
        const code = parsed.searchParams.get('code');
        if (api) apiClient.setBaseUrl(api);
        if (secret) apiClient.setToken(secret);
        if (code) {
          setPairingCode(code);
          try {
            localStorage.setItem('rh_pairing_code', code);
          } catch {}
        }
      } else {
        apiClient.setToken(trimmed);
      }
      setPasteUrlInput('');
      setError(null);
      setActiveTab('devices');
      loadMachines();
    } catch {
      alert('Invalid pairing token or URL');
    }
  };

  async function loadMachines() {
    setLoading(true);
    setError(null);
    try {
      const list = await apiClient.listMachines();
      setMachines(list);
      setSelectedMachine((prev) => {
        if (!prev) return list[0] || null;
        return list.find((m) => m.id === prev.id) || list[0] || null;
      });
      if (typeof localStorage !== 'undefined' && list.length > 0) {
        try {
          localStorage.setItem('rh_cached_machines', JSON.stringify(list));
        } catch {}
      }
    } catch (err: any) {
      const msg = err?.message || 'Failed to load machines';
      if (msg.includes('Valid session token required') || msg.includes('Owner session required') || msg.includes('401') || msg.includes('Unauthorized')) {
        setError(null);
        setPairingCode(undefined);
        try {
          localStorage.removeItem('rh_pairing_code');
        } catch {}
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const standalone =
        (window.navigator as any).standalone === true ||
        window.matchMedia?.('(display-mode: standalone)').matches === true;
      setIsStandalone(Boolean(standalone));

      const onBeforeInstall = (e: any) => {
        e.preventDefault();
        setDeferredPrompt(e);
      };
      window.addEventListener('beforeinstallprompt', onBeforeInstall);

      const params = new URLSearchParams(window.location.search);
      const api = params.get('api');
      if (api) {
        apiClient.setBaseUrl(api);
      }
      const secret = params.get('secret') || params.get('token');
      if (secret) {
        apiClient.setToken(secret);
      }
      const code = params.get('code');
      if (code) {
        setPairingCode(code);
        try {
          localStorage.setItem('rh_pairing_code', code);
        } catch {}
      } else {
        try {
          const cached = localStorage.getItem('rh_pairing_code');
          if (cached) {
            setPairingCode(cached);
          }
        } catch {}
      }

      return () => {
        window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      };
    }
  }, []);

  useEffect(() => {
    loadMachines();

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        loadMachines();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    const interval = setInterval(loadMachines, 10000);
    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
      clearInterval(interval);
    };
  }, []);

  const handleSelectMachine = (machine: MachineRow) => {
    setSelectedMachine(machine);
    setActiveTask(null);
    setCurrentScreen('live-task');
  };

  const handleSelectHistoricalTask = (task: TaskRow) => {
    const matched = machines.find((m) => m.id === task.machine_id);
    const machine = matched || ({
      id: task.machine_id,
      owner_id: task.owner_id,
      name: 'Remote Machine',
      hostname: 'remote',
      daemon_version: '0.1.0',
      agy_version: null,
      status: 'offline',
      last_seen_at: task.created_at,
      created_at: task.created_at,
    } as MachineRow);
    setSelectedMachine(machine);
    setActiveTask(task);
    setCurrentScreen('live-task');
  };

  const handleCreateTask = async (
    prompt: string,
    kind: TaskKind,
    mode: TaskMode,
    model?: string,
    effort?: string,
  ) => {
    if (!selectedMachine) return;
    setSubmittingTask(true);
    try {
      const task = await apiClient.createTask({
        machine_id: selectedMachine.id,
        prompt,
        kind,
        mode,
        model,
        effort,
      });
      setActiveTask(task);
      setCurrentScreen('live-task');
    } catch (err: any) {
      alert(err?.message || 'Failed to create task');
    } finally {
      setSubmittingTask(false);
    }
  };

  const onlineCount = machines.filter(
    (m) =>
      m.status === 'online' &&
      m.last_seen_at &&
      Date.now() - new Date(m.last_seen_at).getTime() < 45000,
  ).length;

  const isOnlineMachine = (m: MachineRow) =>
    m.status === 'online' &&
    Boolean(m.last_seen_at) &&
    Date.now() - new Date(m.last_seen_at as string).getTime() < 45000;

  const goToTab = (tab: 'devices' | 'history' | 'pairing') => {
    setCurrentScreen('machines');
    setActiveTab(tab);
  };

  const handleSidebarOpenWorkspace = () => {
    const target = selectedMachine || machines.find((m) => isOnlineMachine(m)) || machines[0];
    if (target) {
      handleSelectMachine(target);
    } else {
      goToTab('pairing');
    }
  };

  const headerContextTitle =
    currentScreen === 'live-task'
      ? selectedMachine?.name || activeTask
        ? 'Workspace'
        : 'Workspace'
      : activeTab === 'devices'
        ? 'Devices'
        : activeTab === 'history'
          ? 'History'
          : 'Pairing';

  const headerContextSub =
    currentScreen === 'live-task'
      ? selectedMachine?.name || machines[0]?.name || 'Remote session'
      : activeTab === 'devices'
        ? machines.length === 0
          ? 'Pair a computer to get started'
          : `${onlineCount} of ${machines.length} online`
        : activeTab === 'history'
          ? 'Past tasks across all devices'
          : pairingCode
            ? 'Session active'
            : 'Link a new computer';

  return (
    <div className={`app-shell ${currentScreen === 'live-task' ? 'chat-mode' : ''}`}>
      <aside className="app-sidebar" aria-label="Primary navigation">
        <div className="sidebar-brand">
          <div className="brand-icon" aria-hidden="true">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
          </div>
          <span className="brand-text">
            <span className="brand-title">Remote Hands</span>
            <span className="brand-sub">
              {machines.length === 0 ? 'Not connected' : `${onlineCount} of ${machines.length} online`}
            </span>
          </span>
        </div>

        <button
          type="button"
          className="sidebar-cta"
          onClick={handleSidebarOpenWorkspace}
          data-testid="sidebar-open-workspace"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          <span>New chat</span>
        </button>

        <nav className="sidebar-nav">
          <button
            type="button"
            className={clsx('sidebar-nav-item', currentScreen !== 'live-task' && activeTab === 'devices' && 'active')}
            onClick={() => goToTab('devices')}
            data-testid="sidebar-nav-devices"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
            <span className="sidebar-nav-label">Devices</span>
            {machines.length > 0 && <span className="sidebar-nav-count">{machines.length}</span>}
          </button>
          <button
            type="button"
            className={clsx('sidebar-nav-item', currentScreen !== 'live-task' && activeTab === 'history' && 'active')}
            onClick={() => goToTab('history')}
            data-testid="sidebar-nav-history"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 3v5h5" />
              <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
              <path d="M12 7v5l4 2" />
            </svg>
            <span className="sidebar-nav-label">History</span>
          </button>
          <button
            type="button"
            className={clsx('sidebar-nav-item', currentScreen !== 'live-task' && activeTab === 'pairing' && 'active')}
            onClick={() => goToTab('pairing')}
            data-testid="sidebar-nav-pairing"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
            <span className="sidebar-nav-label">Pairing</span>
            {pairingCode && <span className="sidebar-nav-dot" aria-hidden="true" />}
          </button>
        </nav>

        {machines.length === 0 ? (
          <div className="sidebar-section">
            <div className="sidebar-section-head">
              <span className="sidebar-section-title">Computers</span>
            </div>
            <button
              type="button"
              className="sidebar-empty"
              onClick={() => goToTab('pairing')}
              data-testid="sidebar-pair-empty"
            >
              <span className="sidebar-empty-title">No computers yet</span>
              <span className="sidebar-empty-sub">Pair your Mac to start</span>
            </button>
          </div>
        ) : (
          <SidebarMachines
            machines={machines}
            selectedMachineId={selectedMachine?.id ?? null}
            activeTaskId={activeTask?.id ?? null}
            isChatMode={currentScreen === 'live-task'}
            onOpenMachine={handleSelectMachine}
            onOpenTask={handleSelectHistoricalTask}
            onViewAll={() => goToTab('history')}
            onRefreshMachines={loadMachines}
          />
        )}

        <div className="sidebar-footer">
          <button
            type="button"
            className="sidebar-pair-btn"
            onClick={() => setShowPairModal(true)}
            data-testid="sidebar-pair-btn"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
            </svg>
            <span>Pair computer</span>
          </button>
          <div className="sidebar-footer-status">
            <span className={clsx('sidebar-status-pill', onlineCount > 0 ? 'online' : 'offline')}>
              <span className="status-dot" aria-hidden="true" />
              {machines.length === 0 ? 'Not connected' : `${onlineCount} online`}
            </span>
          </div>
        </div>
      </aside>

      <div className="app-content">
      {currentScreen !== 'live-task' && (
        <header className="app-header">
          <div className="brand-group">
            <div className="brand-icon" aria-hidden="true">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" y1="19" x2="20" y2="19" />
              </svg>
            </div>
            <span className="brand-text">
              <span className="brand-title">Remote Hands</span>
              <span className="brand-sub">
                {machines.length === 0 ? 'Not connected' : `${onlineCount} of ${machines.length} online`}
              </span>
            </span>
          </div>
          <div className="header-context" aria-hidden="false">
            <span className="header-context-title">{headerContextTitle}</span>
            <span className="header-context-sub">{headerContextSub}</span>
          </div>
          <div className="header-actions">
            <button
              type="button"
              className="btn-header-icon"
              onClick={loadMachines}
              title="Refresh"
              aria-label="Refresh machines list"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
              </svg>
            </button>
            {!isStandalone && (
              <button
                type="button"
                className="btn-header-icon"
                onClick={() => setShowInstallModal(true)}
                title="Add to Home Screen"
                aria-label="Add to Home Screen"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <polyline points="19 12 12 19 5 12" />
                </svg>
              </button>
            )}
            <button
              type="button"
              className="btn-header-icon"
              onClick={() => setShowPairModal(true)}
              title="Pair a computer"
              aria-label="Pair a computer"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
              </svg>
              {pairingCode && <span className="header-dot" aria-hidden="true" />}
            </button>
          </div>
        </header>
      )}

      {currentScreen !== 'live-task' && (
        <div className="segmented-nav-wrapper">
          <div className="segmented-control" role="tablist" aria-label="Primary">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'devices'}
              className={clsx('segmented-button', activeTab === 'devices' && 'active')}
              onClick={() => setActiveTab('devices')}
            >
              <span>Devices</span>
              {machines.length > 0 && <span className="tab-count">{machines.length}</span>}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'history'}
              className={clsx('segmented-button', activeTab === 'history' && 'active')}
              onClick={() => setActiveTab('history')}
            >
              <span>History</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'pairing'}
              className={clsx('segmented-button', activeTab === 'pairing' && 'active')}
              onClick={() => setActiveTab('pairing')}
            >
              <span>Pairing</span>
              {pairingCode && <span className="tab-dot" aria-hidden="true" />}
            </button>
          </div>
        </div>
      )}

      <main className={`app-main ${currentScreen === 'live-task' ? 'chat-mode' : ''}`}>
        {currentScreen === 'machines' && activeTab === 'devices' && (
          <>
            {error && !error.includes('session token') && !error.includes('401') && !error.includes('Unauthorized') && (
              <div className="home-error" role="alert">
                <div className="home-error-content">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  <span className="home-error-text">
                    {error.includes('Failed to fetch') || error.includes('NetworkError')
                      ? 'Control plane unreachable (network offline or Cloudflare limit). Showing cached computers.'
                      : error}
                  </span>
                </div>
                <div className="home-error-actions">
                  <button type="button" className="home-error-retry" onClick={loadMachines}>
                    Retry
                  </button>
                  <button
                    type="button"
                    className="home-error-dismiss"
                    onClick={() => setError(null)}
                    aria-label="Dismiss error"
                  >
                    ✕
                  </button>
                </div>
              </div>
            )}

            <MachinesScreen
              machines={machines}
              onSelectMachine={handleSelectMachine}
              onRefresh={loadMachines}
              loading={loading}
              onGoToPairing={() => setActiveTab('pairing')}
            />
          </>
        )}

        {currentScreen === 'machines' && activeTab === 'history' && (
          <HistoryTab
            machines={machines}
            onSelectTask={handleSelectHistoricalTask}
          />
        )}

        {currentScreen === 'machines' && activeTab === 'pairing' && (
          <PairingTab
            pairingCode={pairingCode}
            onShowPairQr={() => setShowPairModal(true)}
            onClearCache={handleClearCache}
            onConnectUrl={handleConnectUrl}
            error={error}
          />
        )}

        {currentScreen === 'new-task' && (
          (selectedMachine || machines[0]) ? (
            <NewTaskScreen
              machine={selectedMachine || machines[0]!}
              onCreateTask={handleCreateTask}
              onCancel={() => setCurrentScreen('machines')}
              loading={submittingTask}
            />
          ) : (
            <div className="empty-state-card" style={{ margin: 16 }}>
              <h3 className="empty-state-title">No computers connected</h3>
              <p className="empty-state-desc">Pair a machine to create tasks.</p>
              <button className="btn btn-primary" onClick={() => setCurrentScreen('machines')}>
                Go to Devices
              </button>
            </div>
          )
        )}

        {currentScreen === 'live-task' && (
          (selectedMachine || activeTask || machines[0]) ? (
            <ErrorBoundary
              fallbackTitle="Unable to load task session"
              onReset={() => {
                setActiveTask(null);
                setSelectedMachine(null);
                setCurrentScreen('machines');
              }}
            >
              <LiveTaskScreen
                task={activeTask ?? undefined}
                machine={(selectedMachine || (activeTask ? machines.find((m) => m.id === activeTask.machine_id) : machines[0])) ?? undefined}
                machineName={selectedMachine?.name || (activeTask ? 'Remote Mac' : machines[0]?.name)}
                onBack={() => {
                  setActiveTask(null);
                  setSelectedMachine(null);
                  setCurrentScreen('machines');
                  loadMachines();
                }}
              />
            </ErrorBoundary>
          ) : (
            <div className="empty-state-card" style={{ margin: 16 }}>
              <h3 className="empty-state-title">No computer connected</h3>
              <p className="empty-state-desc">Please connect or select a paired computer first.</p>
              <button className="btn btn-primary" onClick={() => setCurrentScreen('machines')}>
                View Devices
              </button>
            </div>
          )
        )}
      </main>

      <PairingModal
        isOpen={showPairModal}
        onClose={() => setShowPairModal(false)}
        pairingCode={pairingCode}
      />

      <InstallModal
        isOpen={showInstallModal}
        onClose={() => setShowInstallModal(false)}
        deferredPrompt={deferredPrompt}
      />
      </div>
    </div>
  );
}

export default App;
