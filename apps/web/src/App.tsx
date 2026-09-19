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

  const handleCreateTask = async (prompt: string, kind: TaskKind, mode: TaskMode) => {
    if (!selectedMachine) return;
    setSubmittingTask(true);
    try {
      const task = await apiClient.createTask({
        machine_id: selectedMachine.id,
        prompt,
        kind,
        mode,
      });
      setActiveTask(task);
      setCurrentScreen('live-task');
    } catch (err: any) {
      alert(err?.message || 'Failed to create task');
    } finally {
      setSubmittingTask(false);
    }
  };

  return (
    <div className={`app-shell ${currentScreen === 'live-task' ? 'chat-mode' : ''}`}>
      {currentScreen !== 'live-task' && (
        <header className="app-header">
          <div className="brand-group">
            <div className="brand-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
            </div>
            <span className="brand-title">Remote Hands</span>
          </div>
          <div className="header-actions">
            {!isStandalone && (
              <button
                type="button"
                className="btn-header-pill"
                onClick={() => setShowInstallModal(true)}
                title="Add to Home Screen"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
                  <line x1="12" y1="18" x2="12.01" y2="18" />
                </svg>
                <span>Install</span>
              </button>
            )}
            <button
              type="button"
              className="btn-header-pill qr-button"
              onClick={() => setShowPairModal(true)}
              title="Pair with QR code"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" />
                <rect x="14" y="3" width="7" height="7" />
                <rect x="14" y="14" width="7" height="7" />
                <rect x="3" y="14" width="7" height="7" />
              </svg>
              <span>Pair QR</span>
            </button>
          </div>
        </header>
      )}

      {currentScreen !== 'live-task' && (
        <div className="segmented-nav-wrapper">
          <div className="segmented-control">
            <button
              type="button"
              className={clsx('segmented-button', activeTab === 'devices' && 'active')}
              onClick={() => setActiveTab('devices')}
            >
              <span>💻 Devices</span>
            </button>
            <button
              type="button"
              className={clsx('segmented-button', activeTab === 'history' && 'active')}
              onClick={() => setActiveTab('history')}
            >
              <span>💬 History</span>
            </button>
            <button
              type="button"
              className={clsx('segmented-button', activeTab === 'pairing' && 'active')}
              onClick={() => setActiveTab('pairing')}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span>📱 Pairing</span>
                {pairingCode && <span className="status-dot" style={{ background: 'var(--claude-text-accent)' }} />}
              </span>
            </button>
          </div>
        </div>
      )}

      <main className={`app-main ${currentScreen === 'live-task' ? 'chat-mode' : ''}`}>
        {currentScreen === 'machines' && activeTab === 'devices' && (
          <>
            {error && !error.includes('session token') && !error.includes('401') && !error.includes('Unauthorized') && (
              <div className="card" style={{ borderColor: 'var(--accent-rose)', marginBottom: 14 }}>
                <div style={{ color: 'var(--accent-rose)', fontWeight: 600, fontSize: '0.875rem' }}>
                  {error}
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
  );
}

export default App;
