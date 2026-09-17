import { useState, useEffect } from 'react';
import type { MachineRow, TaskRow, TaskKind, TaskMode } from '@remote-hands/shared';
import { apiClient } from './api/client.js';
import { MachinesScreen } from './screens/MachinesScreen.js';
import { NewTaskScreen } from './screens/NewTaskScreen.js';
import { LiveTaskScreen } from './screens/LiveTaskScreen.js';
import { PairingModal } from './components/PairingModal.js';
import { InstallModal } from './components/InstallModal.js';

export function App() {
  const [machines, setMachines] = useState<MachineRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [currentScreen, setCurrentScreen] = useState<'machines' | 'new-task' | 'live-task'>('machines');
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
    } catch {}
    setPairingCode(undefined);
    setError(null);
    setMachines([]);
    if (typeof window !== 'undefined') {
      window.location.href = window.location.origin;
    }
  };

  const handleConnectUrl = (rawUrl: string) => {
    try {
      const parsed = new URL(rawUrl.trim());
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
      setPasteUrlInput('');
      loadMachines();
    } catch {
      alert('Invalid pairing URL');
    }
  };

  async function loadMachines() {
    setLoading(true);
    setError(null);
    try {
      const list = await apiClient.listMachines();
      setMachines(list);
    } catch (err: any) {
      const msg = err?.message || 'Failed to load machines';
      setError(msg);
      if (msg.includes('Valid session token required') || msg.includes('401') || msg.includes('Unauthorized')) {
        setPairingCode(undefined);
        try {
          localStorage.removeItem('rh_pairing_code');
        } catch {}
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
    setCurrentScreen('new-task');
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
    <div className="app-shell">
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
                className="btn-header-pill"
                onClick={() => setShowInstallModal(true)}
                title="Add to Home Screen"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
                  <line x1="12" y1="18" x2="12.01" y2="18" />
                </svg>
                <span>Add to Home</span>
              </button>
            )}
            <button
              className="btn-header-ghost"
              onClick={handleClearCache}
              title="Reset paired session"
            >
              Reset
            </button>
            <button
              className="btn-header-pill qr-button"
              onClick={() => setShowPairModal(true)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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

      <main className="app-main">
        {currentScreen === 'machines' && !isStandalone && (
          <div
            className="install-callout"
            onClick={() => setShowInstallModal(true)}
          >
            <div className="install-callout-left">
              <div className="install-callout-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 5v14M5 12l7 7 7-7" />
                </svg>
              </div>
              <div>
                <div className="install-callout-title">Add to Home Screen</div>
                <div className="install-callout-desc">Open Remote Hands fullscreen like an app on your phone</div>
              </div>
            </div>
            <button
              className="btn-install-trigger"
              onClick={(e) => {
                e.stopPropagation();
                setShowInstallModal(true);
              }}
            >
              Add +
            </button>
          </div>
        )}

        {currentScreen !== 'live-task' && pairingCode && (
          <div className="info-banner">
            <div className="info-banner-content">
              <span className="info-banner-dot" />
              <span className="info-banner-text">Paired to <strong>{pairingCode}</strong></span>
            </div>
          </div>
        )}

        {currentScreen !== 'live-task' && error && (
          <div className="error-banner">
            <div className="error-banner-title">
              {error.includes('session token') ? 'Phone Not Paired' : error}
            </div>
            {error.includes('session token') && (
              <div className="error-banner-body">
                <p>This phone does not have an active session with your Mac.</p>
                <p>Run <code className="inline-code">rh pair</code> on your computer to view QR code or direct link.</p>
                <div className="connect-input-group">
                  <input
                    type="text"
                    className="app-input"
                    placeholder="Paste pairing URL or token..."
                    value={pasteUrlInput}
                    onChange={(e) => setPasteUrlInput(e.target.value)}
                  />
                  <button
                    className="btn-primary-compact"
                    onClick={() => handleConnectUrl(pasteUrlInput)}
                  >
                    Connect
                  </button>
                </div>
                <button className="btn-text" onClick={handleClearCache}>
                  Clear cached credentials
                </button>
              </div>
            )}
          </div>
        )}

        {currentScreen === 'machines' && (
          <MachinesScreen
            machines={machines}
            onSelectMachine={handleSelectMachine}
            onRefresh={loadMachines}
            loading={loading}
          />
        )}

        {currentScreen === 'new-task' && selectedMachine && (
          <NewTaskScreen
            machine={selectedMachine}
            onCreateTask={handleCreateTask}
            onCancel={() => setCurrentScreen('machines')}
            loading={submittingTask}
          />
        )}

        {currentScreen === 'live-task' && activeTask && (
          <LiveTaskScreen
            task={activeTask}
            machineName={selectedMachine?.name}
            onBack={() => {
              setActiveTask(null);
              setCurrentScreen('machines');
            }}
          />
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
